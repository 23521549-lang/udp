import type { ClusterInfo } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import {
  bootstrapManifests,
  rbacProblems,
  REGISTRY_PULL_SECRET,
  SYSTEM_NAMESPACE,
  type Manifest,
} from "../src/modules/cluster/bootstrap.js";
import type { KubeTransport } from "@udp/cluster-access";
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

  it("không vi phạm nào: không wildcard, không escalate/bind/impersonate, không pods/exec, không secrets ngoài udp-system", () => {
    expect(rbacProblems(manifests)).toEqual([]);
  });

  it("chỉ udp-tooling có secrets: trọn quyền trong udp-system, ở env CHỈ udp-registry-pull (Plan #31 AC-8, #35 AC-2)", () => {
    type Rule = {
      resources: string[];
      resourceNames?: string[];
      verbs: string[];
    };
    const withSecrets = manifests.filter(
      (m) =>
        (m.ref.kind === "Role" || m.ref.kind === "ClusterRole") &&
        ((m.body.rules ?? []) as Rule[]).some((r) =>
          r.resources.includes("secrets"),
        ),
    );
    expect(
      withSecrets.map(
        (m) => `${m.ref.kind}:${String(m.ref.namespace)}/${String(m.ref.name)}`,
      ),
    ).toEqual([
      `Role:${SYSTEM_NAMESPACE}/udp-tooling`,
      "Role:p-0f0f-dev/udp-tooling-registry-pull",
      "Role:p-0f0f-prod/udp-tooling-registry-pull",
    ]);
    for (const m of withSecrets.slice(1)) {
      expect(m.body.rules).toEqual([
        {
          apiGroups: [""],
          resources: ["secrets"],
          resourceNames: [REGISTRY_PULL_SECRET],
          verbs: ["get", "update", "patch"],
        },
      ]);
    }
  });

  it("mỗi environment có udp-registry-pull RỖNG kiểu dockerconfigjson (Plan #35 AC-2)", () => {
    for (const env of INPUT.environments) {
      const secret = manifests.find(
        (m) =>
          m.ref.kind === "Secret" &&
          m.ref.namespace === env.k8sNamespace &&
          m.ref.name === REGISTRY_PULL_SECRET,
      );
      expect(secret?.body).toMatchObject({
        type: "kubernetes.io/dockerconfigjson",
        data: {
          ".dockerconfigjson": Buffer.from('{"auths":{}}').toString("base64"),
        },
      });
    }
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
    // [Plan #51, D-P39] promote/abort/retry là patch lên `rollouts/status` — subresource DUY NHẤT có thật
    expect(
      traffic
        .flatMap((r) => r.resources)
        .filter((x) => x.startsWith("rollouts/")),
    ).toEqual(["rollouts/status"]);
    expect(
      traffic.find((r) => r.resources.includes("rollouts/status"))?.verbs,
    ).toEqual(["patch"]);
    expect(
      traffic.find((r) => r.resources.includes("canaries"))?.verbs,
    ).toEqual(["get", "list", "watch"]);
    // S1 là bên ghi spec của mọi đối tượng giao hàng
    for (const resource of ["rollouts", "analysistemplates", "canaries"]) {
      expect(
        workload.find((r) => r.resources.includes(resource))?.verbs,
        resource,
      ).toContain("patch");
    }
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

  it("ngoại lệ udp-registry-pull HẸP: create, list, tên khác, thiếu resourceNames hay ClusterRole ⇒ đỏ", () => {
    const rule = (over: Record<string, unknown>) => ({
      apiGroups: [""],
      resources: ["secrets"],
      resourceNames: [REGISTRY_PULL_SECRET],
      verbs: ["get", "patch"],
      ...over,
    });
    const role = (kind: string, r: Record<string, unknown>): Manifest => ({
      ref: {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind,
        name: "x",
        namespace: "p-0f0f-dev",
      },
      body: { rules: [r] },
    });
    expect(rbacProblems([role("Role", rule({}))])).toEqual([]);
    for (const bad of [
      rule({ verbs: ["create"] }),
      rule({ verbs: ["list"] }),
      rule({ verbs: ["delete"] }),
      rule({ resourceNames: ["khac"] }),
      rule({ resourceNames: [REGISTRY_PULL_SECRET, "khac"] }),
      rule({ resourceNames: undefined }),
    ]) {
      expect(rbacProblems([role("Role", bad)]), JSON.stringify(bad)).toEqual([
        "x: resource secrets",
      ]);
    }
    expect(rbacProblems([role("ClusterRole", rule({}))])).toEqual([
      "x: resource secrets",
    ]);
  });

  it("secrets: hợp lệ trong Role của udp-system, đỏ ở ClusterRole và ở namespace khác", () => {
    const rules = [{ apiGroups: [""], resources: ["secrets"], verbs: ["get"] }];
    const manifest = (kind: string, namespace?: string): Manifest => ({
      ref: {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind,
        name: "x",
        ...(namespace === undefined ? {} : { namespace }),
      },
      body: { rules },
    });
    expect(rbacProblems([manifest("Role", SYSTEM_NAMESPACE)])).toEqual([]);
    expect(rbacProblems([manifest("ClusterRole")])).toEqual([
      "x: resource secrets",
    ]);
    expect(rbacProblems([manifest("Role", "p-0f0f-dev")])).toEqual([
      "x: resource secrets",
    ]);
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
