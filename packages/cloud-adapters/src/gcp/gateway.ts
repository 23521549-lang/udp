import type {
  ClusterInfo,
  CreatedResource,
  CreatedResourceKind,
  ResolvedCredential,
} from "@udp/adapter-core";
import { GatewayError, type CloudGateway } from "../core/gateway.js";
import { gcpRequest, type Fetch, type GcpHttp } from "./http.js";
import { gcpLabelCodec, labelKeyHash } from "./labels.js";
import type { GcpSpec } from "./plan.js";
import {
  clusterHandler,
  clustersUrl,
  nodePoolHandler,
  type GkeCluster,
} from "./resources/cluster.js";
import { serviceAccountHandler } from "./resources/identity.js";
import {
  firewallHandler,
  natHandler,
  routerHandler,
  subnetHandler,
  vpcHandler,
} from "./resources/network.js";
import {
  ownershipMarker,
  required,
  type GcpDescribed,
  type GcpKindHandler,
  type GcpScope,
} from "./resources/types.js";
import { gcpSessionOf } from "./session.js";

const HANDLERS: Partial<Record<CreatedResourceKind, GcpKindHandler>> = {
  vpc: vpcHandler,
  subnet: subnetHandler,
  "firewall-rule": firewallHandler,
  "cloud-router": routerHandler,
  "nat-gateway": natHandler,
  "service-account": serviceAccountHandler,
  cluster: clusterHandler,
  nodegroup: nodePoolHandler,
};

/** Xoá GKE là bất đồng bộ (cluster ~5 phút): `remove` chờ nó biến mất thật (xem AWS) */
const ASYNC_DELETE: readonly CreatedResourceKind[] = ["cluster", "nodegroup"];

/**
 * Kind nằm BÊN TRONG một tài nguyên cha của UDP (NAT trong router, node pool trong
 * cluster) không có `description` riêng; sở hữu của chúng suy từ cha — tên cha cũng
 * tất định và cha đã được kiểm dấu.
 */
const OWNED_BY_PARENT: Partial<
  Record<CreatedResourceKind, { self: string; parent: string }>
> = {
  "nat-gateway": { self: "nat", parent: "router" },
  nodegroup: { self: "nodepool", parent: "cluster" },
};

const GKE_STATUS: Record<string, ClusterInfo["status"]> = {
  PROVISIONING: "PROVISIONING",
  RECONCILING: "PROVISIONING",
  RUNNING: "READY",
  STOPPING: "DELETING",
  ERROR: "ERROR",
  DEGRADED: "ERROR",
};

const CRM = "https://cloudresourcemanager.googleapis.com/v1";
const TEST_PERMISSIONS_BATCH = 100;

export interface GcpGatewayOptions {
  region: string;
  credential: ResolvedCredential;
  fetch: Fetch;
  deleteWait: { intervalMs: number; timeoutMs: number };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function handlerOf(kind: CreatedResourceKind): GcpKindHandler {
  const handler = HANDLERS[kind];
  if (handler === undefined) {
    throw new GatewayError(
      "permanent",
      `GCP không có kind ${kind} trong kế hoạch GKE`,
    );
  }
  return handler;
}

/**
 * Một tag chuẩn ⇒ MỘT label để tra: `udp.key` mã hoá thành bốn label, và hash của nó là
 * label duy nhất xác định khoá; tag khác mã hoá một–một.
 */
function labelSelector(key: string, value: string): [string, string] {
  if (key === "udp.key") return ["udp-key", labelKeyHash(value)];
  const [entry] = Object.entries(gcpLabelCodec.encode({ [key]: value }));
  return entry ?? [key, value];
}

/** `udp-<short>-nodepool` ⇒ `udp-<short>-cluster`: tên cha suy từ tên con, cùng một lược đồ */
const siblingName = (
  physicalName: string,
  self: string,
  parent: string,
): string =>
  physicalName.endsWith(`-${self}`)
    ? `${physicalName.slice(0, -self.length)}${parent}`
    : physicalName;

export function createGcpGateway(options: GcpGatewayOptions): CloudGateway {
  const session = () => gcpSessionOf(options.credential);
  const http: GcpHttp = {
    fetch: options.fetch,
    accessToken: () => session().accessToken,
    now: options.now,
    sleep: options.sleep,
  };
  const scope = (): GcpScope => ({
    http,
    gcpProject: session().gcpProjectId,
    region: options.region,
  });

  const view = (
    kind: CreatedResourceKind,
    id: string,
    d: GcpDescribed,
  ): CreatedResource => ({
    kind,
    id,
    provider: "gcp",
    region:
      kind === "service-account" || kind === "vpc" || kind === "firewall-rule"
        ? "global"
        : options.region,
    createdAt: new Date(options.now()).toISOString(),
    tags: gcpLabelCodec.decode(d.labels),
  });

  const describe = async (kind: CreatedResourceKind, id: string) => {
    const d = await handlerOf(kind).describe(scope(), id);
    return d === null ? null : { resource: view(kind, id, d), described: d };
  };

  const allClusters = async (): Promise<GkeCluster[]> => {
    const res = await gcpRequest<{ clusters?: GkeCluster[] }>(
      http,
      "GET",
      clustersUrl(scope()),
    );
    return res.clusters ?? [];
  };

  const byLabel = async (
    key: string,
    value: string,
  ): Promise<CreatedResource[]> => {
    const [labelKey, labelValue] = labelSelector(key, value);
    return (await allClusters()).flatMap((c) =>
      c.name === undefined || c.resourceLabels?.[labelKey] !== labelValue
        ? []
        : [
            view("cluster", c.name, {
              labels: { ...c.resourceLabels },
              description: c.description ?? "",
              ready: c.status === "RUNNING",
            }),
          ],
    );
  };

  const waitGone = async (r: CreatedResource): Promise<void> => {
    const deadline = options.now() + options.deleteWait.timeoutMs;
    while ((await describe(r.kind, r.id)) !== null) {
      if (options.now() >= deadline) {
        throw new GatewayError("transient", `${r.kind} ${r.id} chưa biến mất`);
      }
      await options.sleep(options.deleteWait.intervalMs);
    }
  };

  return {
    provider: "gcp",
    region: options.region,

    whoAmI: async () => {
      const s = scope();
      const p = await gcpRequest<{ projectId?: string }>(
        http,
        "GET",
        `${CRM}/projects/${s.gcpProject}`,
      );
      return required(p.projectId, "projectId");
    },

    checkPermissions: async (actions) => {
      const s = scope();
      const granted = new Set<string>();
      for (let i = 0; i < actions.length; i += TEST_PERMISSIONS_BATCH) {
        const res = await gcpRequest<{ permissions?: string[] }>(
          http,
          "POST",
          `${CRM}/projects/${s.gcpProject}:testIamPermissions`,
          { permissions: actions.slice(i, i + TEST_PERMISSIONS_BATCH) },
        );
        for (const p of res.permissions ?? []) granted.add(p);
      }
      return {
        missing: actions.filter((a) => !granted.has(a)),
        confidence: "exact",
        quotaWarnings: [],
      };
    },

    create: async (req) => {
      const labels = gcpLabelCodec.encode(req.tags);
      const problems = gcpLabelCodec.problems(labels);
      if (problems.length > 0) {
        throw new GatewayError(
          "permanent",
          `label không hợp lệ: ${problems.join("; ")}`,
        );
      }
      const id = await handlerOf(req.kind).create({
        scope: scope(),
        physicalName: req.physicalName,
        idempotencyKey: req.idempotencyKey,
        spec: req.spec as GcpSpec,
        labels,
        parents: req.parents,
      });
      return {
        kind: req.kind,
        id,
        provider: "gcp",
        region: options.region,
        createdAt: new Date(options.now()).toISOString(),
        // Kind không có label thì trên cloud KHÔNG có tag nào — nói đúng điều đó
        tags: req.kind === "cluster" ? gcpLabelCodec.decode(labels) : {},
      };
    },

    findByTag: (key, value) => byLabel(key, value),

    findByName: async (kind, physicalName) => {
      const nested = OWNED_BY_PARENT[kind];
      const id =
        nested === undefined
          ? physicalName
          : `${siblingName(physicalName, nested.self, nested.parent)}/${physicalName}`;
      const found = await describe(kind, id);
      if (found === null) return null;
      if (
        nested === undefined &&
        !found.described.description.startsWith(ownershipMarker(""))
      ) {
        // Trùng tên với tài nguyên KHÔNG mang dấu của UDP: tuyệt đối không nhận làm của mình
        throw new GatewayError(
          "permanent",
          `${kind} ${physicalName} tồn tại nhưng không phải của UDP`,
        );
      }
      return found.resource;
    },

    describe: async (kind, id) => (await describe(kind, id))?.resource ?? null,

    isReady: async (r) => {
      const d = await describe(r.kind, r.id);
      if (d === null)
        throw new GatewayError(
          "not-found",
          `${r.kind} ${r.id} biến mất khi đang chờ`,
        );
      if (d.described.failed === true) {
        throw new GatewayError(
          "permanent",
          `${r.kind} ${r.id} ở trạng thái lỗi`,
        );
      }
      return d.described.ready;
    },

    remove: async (r) => {
      try {
        await handlerOf(r.kind).remove(scope(), r.id);
      } catch (e) {
        if (e instanceof GatewayError && e.errorClass === "not-found")
          return "not-found";
        throw e;
      }
      if (ASYNC_DELETE.includes(r.kind)) await waitGone(r);
      return "deleted";
    },

    listByProject: (projectId) => byLabel("udp.project", projectId),

    clusterInfo: async (clusterId) => {
      const c = await gcpRequest<GkeCluster>(
        http,
        "GET",
        `${clustersUrl(scope())}/${clusterId}`,
      );
      return {
        clusterId,
        clusterName: required(c.name, "cluster.name"),
        apiEndpoint: `https://${required(c.endpoint, "cluster.endpoint")}`,
        caData: required(
          c.masterAuth?.clusterCaCertificate,
          "clusterCaCertificate",
        ),
        status: GKE_STATUS[c.status ?? ""] ?? "ERROR",
      };
    },

    /**
     * GKE nhận thẳng access token OAuth của service account (§4.2 "GKE: OAuth access
     * token"). Hạn của nó là hạn của credential đã đổi.
     */
    kubeToken: () =>
      Promise.resolve({
        token: session().accessToken,
        expiresAt: options.credential.expiresAt,
      }),
  };
}
