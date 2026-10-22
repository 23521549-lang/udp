import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Kube } from "../src/install.js";
import { endpointOf } from "./netpol-probe.js";
import { eventually } from "./support.js";

/**
 * [Plan #67] Danh tính bên gọi `/internal/*` trên cụm THẬT - dùng chung cho kind và máy ảo (k3s).
 *
 * Năm nhóm, mỗi nhóm đòi MÃ CHÍNH XÁC (lớp danh tính hỏng trả 503, mà 503 cũng "không phải 401"):
 *
 *  1. Dương: Service 3 thật, bí mật cộng token chiếu ⇒ đúng mã của route (400 ở Service 2: thiếu `projectId`; 404 ở
 *     Service 1: environment không có) - tức đã qua cả ba lớp và tới handler.
 *  2. Âm trên pod thật: thiếu token, thiếu bí mật, token của audience kia ⇒ đúng 401.
 *  3. Kẻ mạo nhãn: pod do NGƯỜI CÀI dựng (policy cho qua) mang nhãn `pd-controller` - qua NetworkPolicy -, SA
 *     `default`, token chiếu ĐÚNG audience, ĐÚNG bí mật ⇒ đúng 401. Đây là lớp còn lại khi admission bị vượt hay
 *     NetworkPolicy cấu hình sai.
 *  4. Kẻ có quyền trong namespace (giả danh một ServiceAccount có Role tạo pod, deployment, exec, token, configmap):
 *     mọi cách lấy danh tính của bên gọi bị policy `udp-internal-identity` từ chối; đối chứng cùng danh tính tạo pod
 *     SA `default` được - lần từ chối đến từ policy, không từ RBAC. Pod `hostPath` bị Pod Security từ chối.
 *  5. Quyền: chỉ bên nhận có `tokenreviews: create`.
 *
 * Bí mật không bao giờ đi qua dòng lệnh: pod đọc `process.env`, token đọc từ tệp trong pod.
 */

const SCRIPT = [
  'const fs = require("fs");',
  "const [url, tokenFile, withSecret] = process.argv.slice(1);",
  "const headers = {};",
  'if (withSecret === "1") headers["X-Internal-Secret"] = process.env.INTERNAL_SERVICE_SECRET ?? "";',
  'if (tokenFile !== "-") headers.authorization = "Bearer " + fs.readFileSync(tokenFile, "utf8").trim();',
  "fetch(url, { headers }).then((r) => console.log(r.status), (e) => console.log('ERR ' + String(e.cause?.code ?? e)));",
].join("\n");

const TOKEN_DIR = "/var/run/secrets/udp/internal";
const IMPOSTOR = "udp-identity-impostor";
const ATTACKER = "udp-identity-probe";
const POLICY = "udp-internal-identity";

interface Call {
  url: string;
  /** Đường tệp token trong pod, hay `-` (không gửi) */
  token: string;
  secret: boolean;
}

function statusFrom(
  kube: Kube,
  namespace: string,
  target: string,
  call: Call,
): string {
  const out = kube.ask([
    "exec",
    target,
    "-n",
    namespace,
    "--",
    "node",
    "-e",
    SCRIPT,
    call.url,
    call.token,
    call.secret ? "1" : "0",
  ]);
  return out?.trim() ?? "EXEC_FAILED";
}

/** Lặp tới khi có trả lời HTTP (pod mới cần một nhịp để NetworkPolicy thấy IP của nó), rồi đòi đúng mã */
async function expectStatus(
  kube: Kube,
  namespace: string,
  target: string,
  call: Call,
  status: number,
  what: string,
): Promise<void> {
  const seen = await eventually(
    () => {
      const out = statusFrom(kube, namespace, target, call);
      return /^\d{3}$/.test(out) ? out : undefined;
    },
    90_000,
    `${what}: có trả lời HTTP`,
  );
  expect(seen, what).toBe(String(status));
}

function imageOf(kube: Kube, namespace: string, deployment: string) {
  const out = kube.ask([
    "get",
    "deployment",
    deployment,
    "-n",
    namespace,
    "-o",
    "jsonpath={.spec.template.spec.containers[0].image} {.spec.template.spec.containers[0].imagePullPolicy}",
  ]);
  const [image, pullPolicy] = (out ?? "").trim().split(" ");
  expect(image, `image của ${deployment}`).toBeTruthy();
  return { image: image as string, pullPolicy: pullPolicy ?? "IfNotPresent" };
}

const apply = (kube: Kube, manifest: object, extra: string[] = []) =>
  kube.attempt(["apply", "-f", "-", ...extra], JSON.stringify(manifest));

export async function expectInternalIdentityEnforced(
  kube: Kube,
  namespace: string,
): Promise<void> {
  const flag = `http://${endpointOf(kube, namespace, "internal-flag-service")}`;
  const core = `http://${endpointOf(kube, namespace, "internal-core-backend")}`;
  const staleFlags = `${flag}/internal/stale-flags`;
  const metricsSource = `${core}/internal/environments/${randomUUID()}/metrics-source`;
  const s3 = "deploy/pd-controller";

  // 1. Dương
  await expectStatus(
    kube,
    namespace,
    s3,
    { url: staleFlags, token: `${TOKEN_DIR}/flag-service`, secret: true },
    400,
    "Service 3 → Service 2, đủ ba lớp",
  );
  await expectStatus(
    kube,
    namespace,
    s3,
    { url: metricsSource, token: `${TOKEN_DIR}/core-backend`, secret: true },
    404,
    "Service 3 → Service 1, đủ ba lớp",
  );

  // 2. Âm trên pod thật
  await expectStatus(
    kube,
    namespace,
    s3,
    { url: staleFlags, token: "-", secret: true },
    401,
    "có bí mật, không token",
  );
  await expectStatus(
    kube,
    namespace,
    s3,
    { url: staleFlags, token: `${TOKEN_DIR}/flag-service`, secret: false },
    401,
    "có token, không bí mật",
  );
  await expectStatus(
    kube,
    namespace,
    s3,
    { url: staleFlags, token: `${TOKEN_DIR}/core-backend`, secret: true },
    401,
    "token của audience Service 1 gửi tới Service 2",
  );

  // 3. Kẻ mạo nhãn - do người cài dựng (policy cho qua người có escalate), không thành endpoint (readiness hỏng)
  const { image, pullPolicy } = imageOf(kube, namespace, "pd-controller");
  const impostor = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: IMPOSTOR,
      namespace,
      labels: { "app.kubernetes.io/name": "pd-controller" },
    },
    spec: {
      serviceAccountName: "default",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000 },
      containers: [
        {
          name: "impostor",
          image,
          imagePullPolicy: pullPolicy,
          command: ["node", "-e", "setInterval(() => {}, 1 << 30)"],
          env: [
            {
              name: "INTERNAL_SERVICE_SECRET",
              valueFrom: {
                secretKeyRef: {
                  name: "udp-secrets",
                  key: "INTERNAL_SERVICE_SECRET",
                },
              },
            },
          ],
          readinessProbe: { exec: { command: ["false"] }, periodSeconds: 5 },
          volumeMounts: [{ name: "token", mountPath: "/t", readOnly: true }],
          securityContext: { allowPrivilegeEscalation: false },
        },
      ],
      volumes: [
        {
          name: "token",
          projected: {
            sources: [
              {
                serviceAccountToken: {
                  audience: "udp:internal:flag-service",
                  expirationSeconds: 600,
                  path: "flag-service",
                },
              },
            ],
          },
        },
      ],
    },
  };
  try {
    const made = apply(kube, impostor);
    expect(made.code, made.output).toBe(0);
    await eventually(
      () =>
        kube
          .ask([
            "get",
            "pod",
            IMPOSTOR,
            "-n",
            namespace,
            "-o",
            "jsonpath={.status.phase}",
          ])
          ?.trim() === "Running"
          ? true
          : undefined,
      180_000,
      "pod mạo nhãn chạy",
    );
    await expectStatus(
      kube,
      namespace,
      `pod/${IMPOSTOR}`,
      { url: staleFlags, token: "/t/flag-service", secret: true },
      401,
      "nhãn pd-controller, SA default, đúng audience, đúng bí mật",
    );
  } finally {
    kube.ask([
      "delete",
      "pod",
      IMPOSTOR,
      "-n",
      namespace,
      "--ignore-not-found",
      "--wait=false",
    ]);
  }

  // 4. Kẻ có quyền trong namespace
  expectNamespaceAttackerDenied(kube, namespace, image);

  // 5. Quyền
  for (const [sa, allowed] of [
    ["core-backend", "yes"],
    ["flag-service", "yes"],
    ["pd-controller", "no"],
  ] as const) {
    const out = kube.attempt([
      "auth",
      "can-i",
      "create",
      "tokenreviews.authentication.k8s.io",
      `--as=system:serviceaccount:${namespace}:${sa}`,
    ]);
    expect(out.output.trim(), `${sa} create tokenreviews`).toBe(allowed);
  }
}

function expectNamespaceAttackerDenied(
  kube: Kube,
  namespace: string,
  image: string,
): void {
  const as = `--as=system:serviceaccount:${namespace}:${ATTACKER}`;
  const role = {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: ATTACKER, namespace },
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name: ATTACKER, namespace },
        rules: [
          {
            apiGroups: [""],
            resources: ["pods", "configmaps"],
            verbs: ["get", "list", "create", "patch", "update"],
          },
          {
            apiGroups: [""],
            resources: ["pods/exec", "serviceaccounts/token"],
            verbs: ["create", "get"],
          },
          {
            apiGroups: ["apps"],
            resources: ["deployments", "replicasets"],
            verbs: ["get", "list", "create", "patch", "update"],
          },
        ],
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: ATTACKER, namespace },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: ATTACKER,
        },
        subjects: [{ kind: "ServiceAccount", name: ATTACKER, namespace }],
      },
    ],
  };
  const pod = (name: string, sa: string, label: string, extra = {}) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: { "app.kubernetes.io/name": label },
    },
    spec: {
      serviceAccountName: sa,
      containers: [{ name: "c", image, command: ["true"] }],
      ...extra,
    },
  });
  const denied = (
    result: { code: number | null; output: string },
    by: string,
    what: string,
    /** Đầu ra có thể chứa token (`create token` lọt qua): không in */
    secret = false,
  ) => {
    const shown = secret ? "(không in)" : result.output.trim().slice(0, 400);
    expect(result.code !== 0, `${what}: bị từ chối - ${shown}`).toBe(true);
    expect(
      result.output.includes(by),
      `${what}: từ chối bởi ${by} - ${shown}`,
    ).toBe(true);
  };

  const made = apply(kube, role);
  expect(made.code, made.output).toBe(0);
  try {
    const dry = ["--dry-run=server", as];
    // Đối chứng: cùng danh tính tạo pod SA default thì được - RBAC đủ, lần từ chối bên dưới là của policy
    const control = apply(
      kube,
      pod("udp-identity-control", "default", ATTACKER),
      dry,
    );
    expect(control.code, control.output).toBe(0);

    denied(
      apply(
        kube,
        pod("udp-identity-sa", "pd-controller", "pd-controller"),
        dry,
      ),
      POLICY,
      "tạo pod mang SA pd-controller",
    );
    denied(
      apply(kube, pod("udp-identity-receiver", "default", "core-backend"), dry),
      POLICY,
      "tạo pod SA default mang nhãn core-backend (hứng token)",
    );
    denied(
      apply(
        kube,
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "udp-identity-deploy", namespace },
          spec: {
            selector: { matchLabels: { "app.kubernetes.io/name": ATTACKER } },
            template: {
              metadata: { labels: { "app.kubernetes.io/name": ATTACKER } },
              spec: pod("x", "pd-controller", ATTACKER).spec,
            },
          },
        },
        dry,
      ),
      POLICY,
      "tạo Deployment mang SA pd-controller",
    );
    denied(
      kube.attempt([
        "set",
        "image",
        "deployment/pd-controller",
        `pd-controller=${image}-attacker`,
        "-n",
        namespace,
        ...dry,
      ]),
      POLICY,
      "đổi image của Deployment pd-controller",
    );
    const realPod = (
      kube.ask([
        "get",
        "pod",
        "-n",
        namespace,
        "-l",
        "app.kubernetes.io/name=pd-controller",
        "-o",
        "jsonpath={.items[0].metadata.name}",
      ]) ?? ""
    ).trim();
    expect(realPod).toMatch(/^pd-controller-/);
    denied(
      kube.attempt([
        "set",
        "image",
        `pod/${realPod}`,
        `pd-controller=${image}-attacker`,
        "-n",
        namespace,
        ...dry,
      ]),
      POLICY,
      "đổi image của pod pd-controller tại chỗ",
    );
    const config = (
      kube.ask([
        "get",
        "configmap",
        "-n",
        namespace,
        "-o",
        "jsonpath={.items[*].metadata.name}",
      ]) ?? ""
    )
      .trim()
      .split(" ")
      .find((n) => n.startsWith("udp-config"));
    expect(config).toBeTruthy();
    denied(
      kube.attempt([
        "patch",
        "configmap",
        config as string,
        "-n",
        namespace,
        "--type=merge",
        "-p",
        '{"data":{"NODE_OPTIONS":"--require=/tmp/x.js"}}',
        ...dry,
      ]),
      POLICY,
      "sửa ConfigMap udp-config",
    );
    // `exec` và `create token` không có dry-run: chạy thật, vô hại theo cấu tạo (`true`, token không in ra)
    denied(
      kube.attempt(["exec", realPod, "-n", namespace, as, "--", "true"]),
      POLICY,
      "exec vào pod pd-controller",
    );
    denied(
      kube.attempt([
        "create",
        "token",
        "pd-controller",
        "-n",
        namespace,
        "--audience=udp:internal:flag-service",
        as,
      ]),
      POLICY,
      "xin token cho SA pd-controller",
      true,
    );
    denied(
      apply(
        kube,
        pod("udp-identity-hostpath", "default", ATTACKER, {
          volumes: [{ name: "h", hostPath: { path: "/var/lib/kubelet" } }],
        }),
        dry,
      ),
      "PodSecurity",
      "pod hostPath trong namespace udp",
    );
  } finally {
    kube.attempt(
      ["delete", "-f", "-", "--ignore-not-found"],
      JSON.stringify(role),
    );
  }
}
