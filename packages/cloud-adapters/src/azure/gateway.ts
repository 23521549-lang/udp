import type {
  ClusterInfo,
  CreatedResource,
  CreatedResourceKind,
  ResolvedCredential,
} from "@udp/adapter-core";
import { GatewayError, type CloudGateway } from "../core/gateway.js";
import {
  armGetOrNull,
  armListAll,
  armRequest,
  type AzureHttp,
  type Fetch,
} from "./http.js";
import { checkAzurePermissions } from "./permissions.js";
import type { AzureSpec } from "./plan.js";
import {
  agentPoolHandler,
  AKS_API,
  clusterHandler,
} from "./resources/cluster.js";
import {
  managedIdentityHandler,
  roleAssignmentHandler,
} from "./resources/identity.js";
import {
  natGatewayHandler,
  nsgHandler,
  publicIpHandler,
  subnetHandler,
  vnetHandler,
} from "./resources/network.js";
import {
  ownershipMarker,
  required,
  rgPath,
  type ArmResource,
  type AzureKindHandler,
  type AzureScope,
} from "./resources/types.js";
import { azureSessionOf } from "./session.js";
import { azureTagCodec } from "./tags.js";

const HANDLERS: Partial<Record<CreatedResourceKind, AzureKindHandler>> = {
  vpc: vnetHandler,
  nsg: nsgHandler,
  "elastic-ip": publicIpHandler,
  "nat-gateway": natGatewayHandler,
  subnet: subnetHandler,
  "managed-identity": managedIdentityHandler,
  "iam-policy": roleAssignmentHandler,
  cluster: clusterHandler,
  nodegroup: agentPoolHandler,
};

/** Kiểu ARM (chữ thường) ⇒ kind, cho kết quả tra theo tag của Resource Manager */
const KIND_OF_TYPE: Readonly<Record<string, CreatedResourceKind>> = {
  "microsoft.network/virtualnetworks": "vpc",
  "microsoft.network/networksecuritygroups": "nsg",
  "microsoft.network/publicipaddresses": "elastic-ip",
  "microsoft.network/natgateways": "nat-gateway",
  "microsoft.managedidentity/userassignedidentities": "managed-identity",
  "microsoft.containerservice/managedclusters": "cluster",
};

const RESOURCES_API = "2021-04-01";

/**
 * Trạng thái ARM ⇒ trạng thái cluster. `Deleting` vẫn là CÒN: tài nguyên chỉ hết khi GET
 * trả 404 (cùng quy tắc với AWS và GCP).
 */
const AKS_STATUS: Record<string, ClusterInfo["status"]> = {
  Creating: "PROVISIONING",
  Updating: "PROVISIONING",
  Upgrading: "PROVISIONING",
  Scaling: "PROVISIONING",
  Starting: "PROVISIONING",
  Deleting: "DELETING",
  Failed: "ERROR",
  Canceled: "ERROR",
};

export interface AzureGatewayOptions {
  region: string;
  credential: ResolvedCredential;
  fetch: Fetch;
  deleteWait: { intervalMs: number; timeoutMs: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function handlerOf(kind: CreatedResourceKind): AzureKindHandler {
  const handler = HANDLERS[kind];
  if (handler === undefined) {
    throw new GatewayError(
      "permanent",
      `Azure không có kind ${kind} trong kế hoạch AKS`,
    );
  }
  return handler;
}

/** Tài nguyên của UDP? — theo `ownership` của kind (xem `AzureKindHandler`) */
function isUdpOwned(handler: AzureKindHandler, r: ArmResource): boolean {
  switch (handler.ownership) {
    case "tag":
      return r.tags?.["udp.key"] !== undefined;
    case "description":
      return (r.properties?.description ?? "").startsWith(ownershipMarker(""));
    case "parent":
      return true;
  }
}

/** `'` trong giá trị OData được viết đôi */
const odataString = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** Chứng chỉ CA trong kubeconfig mà AKS trả (base64 của YAML) */
function caDataOf(kubeconfigBase64: string): string {
  const yaml = Buffer.from(kubeconfigBase64, "base64").toString("utf8");
  const m = /certificate-authority-data:\s*(\S+)/.exec(yaml);
  return required(m?.[1], "certificate-authority-data");
}

export function createAzureGateway(options: AzureGatewayOptions): CloudGateway {
  const session = () => azureSessionOf(options.credential);
  const http: AzureHttp = {
    fetch: options.fetch,
    accessToken: () => session().armToken,
  };
  const scope = (): AzureScope => {
    const s = session();
    return {
      http,
      subscriptionId: s.subscriptionId,
      resourceGroup: s.resourceGroup,
      region: options.region,
      now: options.now,
      sleep: options.sleep,
    };
  };

  const view = (
    kind: CreatedResourceKind,
    id: string,
    tags: Readonly<Record<string, string>>,
  ): CreatedResource => ({
    kind,
    id,
    provider: "azure",
    region: options.region,
    createdAt: new Date(options.now()).toISOString(),
    tags: azureTagCodec.decode(tags),
  });

  const read = async (kind: CreatedResourceKind, id: string) => {
    const handler = handlerOf(kind);
    const r = await armGetOrNull<ArmResource>(http, id, handler.apiVersion);
    return r === null
      ? null
      : { handler, arm: r, resource: view(kind, id, r.tags ?? {}) };
  };

  const byTag = async (
    key: string,
    value: string,
  ): Promise<CreatedResource[]> => {
    const filter = `tagName eq ${odataString(key)} and tagValue eq ${odataString(value)}`;
    const found = await armListAll<ArmResource>(
      http,
      `${rgPath(scope())}/resources?$filter=${encodeURIComponent(filter)}`,
      RESOURCES_API,
    );
    // Kiểu ngoài kế hoạch (do AKS hay khách gắn tag) không có kind để xếp bậc teardown
    return found.flatMap((r) => {
      const kind = KIND_OF_TYPE[(r.type ?? "").toLowerCase()];
      return kind === undefined || r.id === undefined
        ? []
        : [view(kind, r.id, r.tags ?? {})];
    });
  };

  const waitGone = async (r: CreatedResource): Promise<void> => {
    const deadline = options.now() + options.deleteWait.timeoutMs;
    while ((await read(r.kind, r.id)) !== null) {
      if (options.now() >= deadline) {
        throw new GatewayError("transient", `${r.kind} ${r.id} chưa biến mất`);
      }
      await options.sleep(options.deleteWait.intervalMs);
    }
  };

  return {
    provider: "azure",
    region: options.region,

    whoAmI: async () => {
      const s = scope();
      const rg = await armRequest<ArmResource>(
        http,
        "GET",
        rgPath(s),
        RESOURCES_API,
      );
      return `${s.subscriptionId}/${required(rg.name, "tên resource group")}`;
    },

    checkPermissions: (actions) =>
      checkAzurePermissions(http, scope(), actions),

    create: async (req) => {
      const problems = azureTagCodec.problems(azureTagCodec.encode(req.tags));
      if (problems.length > 0) {
        throw new GatewayError(
          "permanent",
          `tag không hợp lệ: ${problems.join("; ")}`,
        );
      }
      const handler = handlerOf(req.kind);
      const ctx = {
        scope: scope(),
        physicalName: req.physicalName,
        idempotencyKey: req.idempotencyKey,
        spec: req.spec as AzureSpec,
        tags: azureTagCodec.encode(req.tags),
        parents: req.parents,
      };
      const id = handler.idFor(ctx);
      // PUT của ARM là tạo-HOẶC-CẬP-NHẬT: không bao giờ PUT đè lên thứ đã có
      const existing = await armGetOrNull<ArmResource>(
        http,
        id,
        handler.apiVersion,
      );
      if (existing !== null && !isUdpOwned(handler, existing)) {
        throw new GatewayError(
          "permanent",
          `${req.kind} ${req.physicalName} tồn tại nhưng không phải của UDP`,
        );
      }
      if (existing === null) {
        await armRequest(
          http,
          "PUT",
          id,
          handler.apiVersion,
          await handler.body(ctx),
        );
      }
      return view(req.kind, id, handler.ownership === "tag" ? ctx.tags : {});
    },

    findByTag: (key, value) => byTag(key, value),

    findByName: async (kind, physicalName) => {
      const handler = handlerOf(kind);
      const found = await read(kind, handler.idOfName(scope(), physicalName));
      if (found === null) return null;
      if (!isUdpOwned(handler, found.arm)) {
        // Trùng tên với tài nguyên KHÔNG mang dấu của UDP: tuyệt đối không nhận làm của mình
        throw new GatewayError(
          "permanent",
          `${kind} ${physicalName} tồn tại nhưng không phải của UDP`,
        );
      }
      return found.resource;
    },

    describe: async (kind, id) => (await read(kind, id))?.resource ?? null,

    isReady: async (r) => {
      const found = await read(r.kind, r.id);
      if (found === null) {
        throw new GatewayError(
          "not-found",
          `${r.kind} ${r.id} biến mất khi đang chờ`,
        );
      }
      const state = found.arm.properties?.provisioningState;
      if (state === "Failed" || state === "Canceled") {
        throw new GatewayError(
          "permanent",
          `${r.kind} ${r.id} ở trạng thái ${state}`,
        );
      }
      // Managed identity và role assignment không có provisioningState: có là xong
      return state === undefined || state === "Succeeded";
    },

    remove: async (r) => {
      const handler = handlerOf(r.kind);
      const s = scope();
      // Ngoài try: `not-found` của bước gỡ liên kết (subnet biến mất) KHÔNG nghĩa là
      // tài nguyên này đã không còn — chỉ DELETE được nói điều đó
      await handler.beforeRemove?.(s, r.id);
      try {
        await armRequest(http, "DELETE", r.id, handler.apiVersion);
      } catch (e) {
        if (e instanceof GatewayError && e.errorClass === "not-found")
          return "not-found";
        throw e;
      }
      // DELETE của ARM là bất đồng bộ (202): chỉ xong khi GET trả 404
      await waitGone(r);
      return "deleted";
    },

    listByProject: (projectId) => byTag("udp.project", projectId),

    clusterInfo: async (clusterId) => {
      const c = await armRequest<
        ArmResource & {
          properties?: { fqdn?: string; powerState?: { code?: string } };
        }
      >(http, "GET", clusterId, AKS_API);
      const credentials = await armRequest<{
        kubeconfigs?: { value?: string }[];
      }>(http, "POST", `${clusterId}/listClusterUserCredential`, AKS_API);
      const state = c.properties?.provisioningState ?? "";
      const running = c.properties?.powerState?.code === "Running";
      return {
        clusterId,
        clusterName: required(c.name, "tên cluster"),
        apiEndpoint: `https://${required(c.properties?.fqdn, "fqdn của cluster")}`,
        caData: caDataOf(
          required(credentials.kubeconfigs?.[0]?.value, "kubeconfig"),
        ),
        status:
          state === "Succeeded"
            ? running
              ? "READY"
              : "ERROR"
            : (AKS_STATUS[state] ?? "ERROR"),
      };
    },

    /**
     * API server AKS (Entra ID) nhận access token của CHÍNH service principal, cấp cho
     * ứng dụng máy chủ AKS — đã đổi sẵn cùng lúc với token ARM (§4.2 "AKS: token AAD").
     */
    kubeToken: () =>
      Promise.resolve({
        token: session().aksToken,
        expiresAt: options.credential.expiresAt,
      }),
  };
}
