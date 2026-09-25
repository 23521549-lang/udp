import type { ClusterInfo } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  bootstrapManifests,
  rbacProblems,
  SYSTEM_NAMESPACE,
  type Manifest,
} from "../src/modules/cluster/bootstrap.js";
import type { KubeTransport } from "../src/modules/cluster/cluster-access.js";
import { createClusterRuntime } from "../src/modules/cluster/cluster-runtime.js";

/**
 * Bootstrap cluster tenant (Plan #28 P3, AC-6): ba SA rời nhau đúng bảng §12.2, namespace
 * theo env, và ranh giới "token admin chỉ cho bootstrap". Cluster là transport giả ở tầng
 * HTTP — chạy thật là nợ `I32-cluster`.
 */

const INPUT = {
  projectId: "0f0f0f0f-1111-4222-8333-444455556666",
  environments: [
    { name: "dev", k8sNamespace: "p-0f0f-dev" },
    { name: "production", k8sNamespace: "p-0f0f-prod" },
  ],
  quota: {
    maxNodes: 3,
    maxNodeSize: "medium" as const,
    maxDatabases: 1,
    maxStorageGb: 40,
    maxLoadBalancers: 2,
  },
};

const INFO: ClusterInfo = {
  clusterId: "c-1",
  clusterName: "main",
  apiEndpoint: "https://api.cluster.vi-du.test",
  caData: "Q0E=",
  status: "READY",
};

const rulesOf = (
  manifests: Manifest[],
  kind: string,
  name: string,
  namespace?: string,
) =>
  (manifests.find(
    (m) =>
      m.ref.kind === kind &&
      m.ref.name === name &&
      m.ref.namespace === namespace,
  )?.body.rules ?? []) as { resources: string[]; verbs: string[] }[];

describe("manifest bootstrap (§12.2)", () => {
  const manifests = bootstrapManifests(INPUT);

  it("không vi phạm nào: không wildcard, không escalate/bind/impersonate, không pods/exec, không secrets", () => {
    expect(rbacProblems(manifests)).toEqual([]);
  });

  it("ba ServiceAccount rời nhau trong udp-system", () => {
    expect(
      manifests
        .filter((m) => m.ref.kind === "ServiceAccount")
        .map((m) => `${String(m.ref.namespace)}/${String(m.ref.name)}`),
    ).toEqual([
      `${SYSTEM_NAMESPACE}/udp-workload`,
      `${SYSTEM_NAMESPACE}/udp-traffic`,
      `${SYSTEM_NAMESPACE}/udp-tooling`,
    ]);
  });

  it("traffic KHÔNG sửa được deployments, chỉ subresource của rollout; workload KHÔNG chạm đường traffic", () => {
    const traffic = rulesOf(manifests, "Role", "udp-traffic", "p-0f0f-dev");
    const workload = rulesOf(manifests, "Role", "udp-workload", "p-0f0f-dev");
    expect(traffic.some((r) => r.resources.includes("deployments"))).toBe(
      false,
    );
    const rollouts = traffic.find((r) => r.resources.includes("rollouts"));
    expect(rollouts?.verbs).toEqual(["get", "list", "watch"]);
    expect(
      workload.some((r) =>
        r.resources.some((x) =>
          ["virtualservices", "trafficsplits"].includes(x),
        ),
      ),
    ).toBe(false);
  });

  it("mỗi environment: namespace, chặn ingress khác namespace, quota theo project, LimitRange", () => {
    for (const env of INPUT.environments) {
      const kinds = manifests
        .filter(
          (m) =>
            m.ref.namespace === env.k8sNamespace ||
            m.ref.name === env.k8sNamespace,
        )
        .map((m) => m.ref.kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          "Namespace",
          "NetworkPolicy",
          "ResourceQuota",
          "LimitRange",
          "Role",
          "RoleBinding",
        ]),
      );
    }
    const quota = manifests.find(
      (m) =>
        m.ref.kind === "ResourceQuota" && m.ref.namespace === "p-0f0f-prod",
    );
    expect(quota?.body).toMatchObject({
      spec: {
        hard: { "services.loadbalancers": "2", "requests.storage": "40Gi" },
      },
    });
  });

  it("bộ kiểm RBAC bắt được vi phạm (đối chứng)", () => {
    const bad: Manifest[] = [
      {
        ref: {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "Role",
          name: "x",
        },
        body: {
          rules: [
            { apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] },
            { apiGroups: ["*"], resources: ["secrets"], verbs: ["*"] },
          ],
        },
      },
    ];
    expect(rbacProblems(bad)).toHaveLength(4);
  });
});

function fakeCluster(): {
  transport: KubeTransport;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    transport: {
      request(url, init) {
        calls.push({ url, init });
        if (url.endsWith("/token")) {
          return Promise.resolve(
            Response.json({
              status: {
                token: "bound-token",
                expirationTimestamp: "2099-01-01T00:00:00Z",
              },
            }),
          );
        }
        return Promise.resolve(Response.json({}));
      },
    },
  };
}

const bearer = (init: RequestInit) =>
  (init.headers as Record<string, string>).authorization;

describe("ClusterRuntime", () => {
  it("bootstrap: mọi manifest qua server-side apply, bằng token ADMIN", async () => {
    const { transport, calls } = fakeCluster();
    await createClusterRuntime(() => transport).bootstrap(
      INFO,
      { token: "admin-token", expiresAt: new Date(Date.now() + 600_000) },
      INPUT,
    );
    expect(calls).toHaveLength(bootstrapManifests(INPUT).length);
    for (const c of calls) {
      expect(c.init.method).toBe("PATCH");
      expect(c.url).toContain("fieldManager=");
      expect(bearer(c.init)).toBe("Bearer admin-token");
    }
  });

  it("sau bootstrap: xin bound token CHO ĐÚNG SA bằng quyền admin, rồi gọi bằng bound token", async () => {
    const { transport, calls } = fakeCluster();
    const access = createClusterRuntime(() => transport).accessFor(INFO, {
      token: "admin-token",
      expiresAt: new Date(Date.now() + 600_000),
    });
    const client = await access.getClient("workload");
    await client.read("get", {
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace: "ns",
      name: "d",
    });
    expect(calls[0]?.url).toBe(
      `${INFO.apiEndpoint}/api/v1/namespaces/${SYSTEM_NAMESPACE}/serviceaccounts/udp-workload/token`,
    );
    expect(bearer(calls[0]?.init ?? {})).toBe("Bearer admin-token");
    expect(bearer(calls[1]?.init ?? {})).toBe("Bearer bound-token");
  });
});
