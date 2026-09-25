import { GatewayError } from "../../core/gateway.js";
import {
  gcpGetOrNull,
  gcpRequest,
  waitOperation,
  type GcpOperation,
} from "../http.js";
import { PODS_RANGE, SERVICES_RANGE } from "../plan.js";
import {
  COMPUTE_OPERATION_TIMEOUT_MS,
  ownershipMarker,
  parentOf,
  required,
  specOf,
  type GcpKindHandler,
  type GcpScope,
} from "./types.js";

/**
 * Mạng Compute Engine của kế hoạch GKE. Không kind nào ở đây có label: `id` là TÊN (tên là
 * định danh của Compute), `description` mang `udp.key` để nhận ra tài nguyên của UDP.
 * Tạo và xoá đều CHỜ operation xong — lỗi quota nằm trong operation, không ở response tạo.
 */

const COMPUTE = "https://compute.googleapis.com/compute/v1";
const globalUrl = (s: GcpScope, collection: string) =>
  `${COMPUTE}/projects/${s.gcpProject}/global/${collection}`;
const regionalUrl = (s: GcpScope, collection: string) =>
  `${COMPUTE}/projects/${s.gcpProject}/regions/${s.region}/${collection}`;

async function insert(s: GcpScope, url: string, body: unknown): Promise<void> {
  const op = await gcpRequest<GcpOperation>(s.http, "POST", url, body);
  await waitOperation(s.http, op, COMPUTE_OPERATION_TIMEOUT_MS);
}

async function destroy(s: GcpScope, url: string): Promise<void> {
  const op = await gcpRequest<GcpOperation>(s.http, "DELETE", url);
  await waitOperation(s.http, op, COMPUTE_OPERATION_TIMEOUT_MS);
}

interface Named {
  name?: string;
  description?: string;
  selfLink?: string;
}

const described = (r: Named | null, ready = true) =>
  r === null ? null : { labels: {}, description: r.description ?? "", ready };

export const vpcHandler: GcpKindHandler = {
  create: async (ctx) => {
    await insert(ctx.scope, globalUrl(ctx.scope, "networks"), {
      name: ctx.physicalName,
      description: ownershipMarker(ctx.idempotencyKey),
      autoCreateSubnetworks: false,
      routingConfig: { routingMode: "REGIONAL" },
    });
    return ctx.physicalName;
  },
  describe: async (s, id) =>
    described(
      await gcpGetOrNull<Named>(s.http, `${globalUrl(s, "networks")}/${id}`),
    ),
  remove: (s, id) => destroy(s, `${globalUrl(s, "networks")}/${id}`),
};

export const subnetHandler: GcpKindHandler = {
  create: async (ctx) => {
    const spec = specOf(ctx, "subnet");
    const vpc = parentOf(ctx, "vpc");
    await insert(ctx.scope, regionalUrl(ctx.scope, "subnetworks"), {
      name: ctx.physicalName,
      description: ownershipMarker(ctx.idempotencyKey),
      network: `${globalUrl(ctx.scope, "networks")}/${vpc.id}`,
      ipCidrRange: spec.primaryCidr,
      privateIpGoogleAccess: true,
      secondaryIpRanges: [
        { rangeName: PODS_RANGE, ipCidrRange: spec.podsCidr },
        { rangeName: SERVICES_RANGE, ipCidrRange: spec.servicesCidr },
      ],
    });
    return ctx.physicalName;
  },
  describe: async (s, id) =>
    described(
      await gcpGetOrNull<Named>(
        s.http,
        `${regionalUrl(s, "subnetworks")}/${id}`,
      ),
    ),
  remove: (s, id) => destroy(s, `${regionalUrl(s, "subnetworks")}/${id}`),
};

export const firewallHandler: GcpKindHandler = {
  create: async (ctx) => {
    const spec = specOf(ctx, "firewall-rule");
    const vpc = parentOf(ctx, "vpc");
    await insert(ctx.scope, globalUrl(ctx.scope, "firewalls"), {
      name: ctx.physicalName,
      description: ownershipMarker(ctx.idempotencyKey),
      network: `${globalUrl(ctx.scope, "networks")}/${vpc.id}`,
      direction: "INGRESS",
      sourceRanges: [...spec.sourceRanges],
      allowed: [
        { IPProtocol: "tcp" },
        { IPProtocol: "udp" },
        { IPProtocol: "icmp" },
      ],
    });
    return ctx.physicalName;
  },
  describe: async (s, id) =>
    described(
      await gcpGetOrNull<Named>(s.http, `${globalUrl(s, "firewalls")}/${id}`),
    ),
  remove: (s, id) => destroy(s, `${globalUrl(s, "firewalls")}/${id}`),
};

/** Phần tử `nats` của router — giữ nguyên mọi trường khác khi PATCH lại danh sách */
type RouterNat = { name?: string } & Record<string, unknown>;

interface Router extends Named {
  nats?: RouterNat[];
}

export const routerHandler: GcpKindHandler = {
  create: async (ctx) => {
    const vpc = parentOf(ctx, "vpc");
    await insert(ctx.scope, regionalUrl(ctx.scope, "routers"), {
      name: ctx.physicalName,
      description: ownershipMarker(ctx.idempotencyKey),
      network: `${globalUrl(ctx.scope, "networks")}/${vpc.id}`,
    });
    return ctx.physicalName;
  },
  describe: async (s, id) =>
    described(
      await gcpGetOrNull<Router>(s.http, `${regionalUrl(s, "routers")}/${id}`),
    ),
  remove: (s, id) => destroy(s, `${regionalUrl(s, "routers")}/${id}`),
};

/**
 * Cloud NAT là CẤU HÌNH bên trong Cloud Router, không phải tài nguyên riêng: `id` là
 * `<router>/<nat>`, tạo và xoá là PATCH danh sách `nats` của router. `description` của
 * NAT không có — đánh dấu sở hữu nằm ở router cha (cũng của UDP).
 */
export const natIdOf = (id: string): { router: string; nat: string } => {
  const [router, nat] = id.split("/");
  return {
    router: required(router, `router trong ${id}`),
    nat: required(nat, `nat trong ${id}`),
  };
};

async function patchNats(
  s: GcpScope,
  router: string,
  change: (nats: RouterNat[]) => RouterNat[],
): Promise<void> {
  const url = `${regionalUrl(s, "routers")}/${router}`;
  const current = await gcpRequest<Router>(s.http, "GET", url);
  const op = await gcpRequest<GcpOperation>(s.http, "PATCH", url, {
    nats: change(current.nats ?? []),
  });
  await waitOperation(s.http, op, COMPUTE_OPERATION_TIMEOUT_MS);
}

export const natHandler: GcpKindHandler = {
  create: async (ctx) => {
    const router = parentOf(ctx, "router");
    await patchNats(ctx.scope, router.id, (nats) => [
      ...nats.filter((n) => n.name !== ctx.physicalName),
      {
        name: ctx.physicalName,
        natIpAllocateOption: "AUTO_ONLY",
        sourceSubnetworkIpRangesToNat: "ALL_SUBNETWORKS_ALL_IP_RANGES",
      },
    ]);
    return `${router.id}/${ctx.physicalName}`;
  },
  describe: async (s, id) => {
    const { router, nat } = natIdOf(id);
    const r = await gcpGetOrNull<Router>(
      s.http,
      `${regionalUrl(s, "routers")}/${router}`,
    );
    if (r?.nats?.some((n) => n.name === nat) !== true) return null;
    return { labels: {}, description: r.description ?? "", ready: true };
  },
  remove: async (s, id) => {
    const { router, nat } = natIdOf(id);
    const r = await gcpGetOrNull<Router>(
      s.http,
      `${regionalUrl(s, "routers")}/${router}`,
    );
    if (r === null || r.nats?.some((n) => n.name === nat) !== true) {
      throw new GatewayError("not-found", `không còn NAT ${id}`);
    }
    await patchNats(s, router, (nats) => nats.filter((n) => n.name !== nat));
  },
};
