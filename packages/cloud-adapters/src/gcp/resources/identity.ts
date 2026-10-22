import { GatewayError } from "../../core/gateway.js";
import { gcpGetOrNull, gcpRequest } from "../http.js";
import {
  ownershipMarker,
  required,
  specOf,
  type GcpKindHandler,
  type GcpScope,
} from "./types.js";

/**
 * Service account cho node GKE + role mức project của nó. `id` là email (định danh của
 * IAM). Role được gán bằng read–modify–write policy của project, có `etag`: hai thay đổi
 * đồng thời làm Google trả 409 và lần đọc sau thấy bản mới — thử lại ĐÚNG phép hợp nhất
 * đó (không phải thử lại một lời gọi cloud mù) tối đa ba lần.
 */

const IAM = "https://iam.googleapis.com/v1";
const CRM = "https://cloudresourcemanager.googleapis.com/v1";

interface ServiceAccount {
  email?: string;
  description?: string;
}

interface Binding {
  role: string;
  members: string[];
}

interface Policy {
  bindings?: Binding[];
  etag?: string;
  version?: number;
}

const POLICY_ATTEMPTS = 3;

async function updateProjectPolicy(
  s: GcpScope,
  change: (bindings: Binding[]) => Binding[],
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const policy = await gcpRequest<Policy>(
      s.http,
      "POST",
      `${CRM}/projects/${s.gcpProject}:getIamPolicy`,
      {},
    );
    try {
      await gcpRequest(
        s.http,
        "POST",
        `${CRM}/projects/${s.gcpProject}:setIamPolicy`,
        {
          policy: { ...policy, bindings: change(policy.bindings ?? []) },
        },
      );
      return;
    } catch (e) {
      const conflict =
        e instanceof GatewayError && /409|ABORTED/.test(e.message);
      if (!conflict || attempt >= POLICY_ATTEMPTS) throw e;
    }
  }
}

const member = (email: string): string => `serviceAccount:${email}`;

export const serviceAccountHandler: GcpKindHandler = {
  create: async (ctx) => {
    const spec = specOf(ctx, "service-account");
    const sa = await gcpRequest<ServiceAccount>(
      ctx.scope.http,
      "POST",
      `${IAM}/projects/${ctx.scope.gcpProject}/serviceAccounts`,
      {
        accountId: ctx.physicalName,
        serviceAccount: {
          displayName: spec.displayName,
          description: ownershipMarker(ctx.idempotencyKey),
        },
      },
    );
    const email = required(sa.email, "email của service account");
    await updateProjectPolicy(ctx.scope, (bindings) => {
      const out = bindings.map((b) => ({ ...b, members: [...b.members] }));
      for (const role of spec.projectRoles) {
        const existing = out.find((b) => b.role === role);
        if (existing === undefined)
          out.push({ role, members: [member(email)] });
        else if (!existing.members.includes(member(email)))
          existing.members.push(member(email));
      }
      return out;
    });
    return email;
  },
  describe: async (s, email) => {
    const sa = await gcpGetOrNull<ServiceAccount>(
      s.http,
      `${IAM}/projects/${s.gcpProject}/serviceAccounts/${email}`,
    );
    return sa === null
      ? null
      : { labels: {}, description: sa.description ?? "", ready: true };
  },
  remove: async (s, email) => {
    // Gỡ role trước: một binding trỏ tới SA đã xoá để lại "deleted:serviceAccount:…" trong policy
    await updateProjectPolicy(s, (bindings) =>
      bindings
        .map((b) => ({
          ...b,
          members: b.members.filter((m) => m !== member(email)),
        }))
        .filter((b) => b.members.length > 0),
    );
    await gcpRequest(
      s.http,
      "DELETE",
      `${IAM}/projects/${s.gcpProject}/serviceAccounts/${email}`,
    );
  },
};
