import { DEFAULT_ROLLOUT_THRESHOLDS } from "@udp/config";
import { flaggerGateToken } from "@udp/http";
import { describe, expect, it } from "vitest";
import {
  argoAnalysisTemplate,
  argoRolloutPatch,
  argoStrategy,
  previewService,
  type BaseStrategy,
} from "../src/modules/rollout/delivery/argo.js";
import {
  canaryWeights,
  DELIVERY_ANNOTATIONS,
  type DeliverySpec,
} from "../src/modules/rollout/delivery/delivery.types.js";
import { flaggerCanary } from "../src/modules/rollout/delivery/flagger.js";
import { patchToward } from "../src/modules/rollout/delivery/merge.js";
import { restoreAfterSession } from "../src/modules/rollout/delivery/restore.js";
import { imageWithTag } from "../src/modules/cicd/workload.js";
import { supportIssue } from "../src/modules/rollout/delivery/matrix.js";

/**
 * Đối tượng giao hàng SERVICE_LEVEL (§7.2, §7.3) [Plan #51 AC-4]. Kể cả **I4** (§13.3): udp-driven không sinh khối
 * `analysis` — kiểm trên đối tượng SAU khi merge patch áp lên một `Rollout` vốn CÓ `analysis` (một session
 * tool-driven trước đó), vì đó là chỗ một bản dựng quên gửi `null` sẽ để lọt.
 */

type Json = Record<string, unknown>;

/** JSON merge patch (RFC 7386) — đúng thứ API server áp với `application/merge-patch+json` */
function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return patch;
  }
  const out: Json =
    typeof target === "object" && target !== null && !Array.isArray(target)
      ? { ...(target as Json) }
      : {};
  for (const [key, value] of Object.entries(patch as Json)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

const spec = (over: Partial<DeliverySpec> = {}): DeliverySpec => ({
  sessionId: "8f3a0000-0000-4000-8000-000000000001",
  tool: "argo-rollouts",
  mode: "udp-driven",
  strategy: "CANARY",
  workloadName: "web",
  namespace: "udp-shop-dev",
  router: "istio",
  stepPercent: 20,
  stepIntervalSeconds: 300,
  analysisIntervalSeconds: 30,
  metricWindowSeconds: 60,
  thresholds: { ...DEFAULT_ROLLOUT_THRESHOLDS, maxConsecutiveBreaches: 2 },
  ...over,
});

const BASE: BaseStrategy = {
  canary: {
    canaryService: "web-canary",
    stableService: "web",
    trafficRouting: {
      istio: { virtualService: { name: "web", routes: ["primary"] } },
    },
    steps: [{ setWeight: 50 }],
  },
};

/** `Rollout` đang chạy sau một session tool-driven — còn khối `analysis` */
const LIVE = {
  spec: {
    strategy: {
      canary: {
        ...BASE.canary,
        analysis: { templates: [{ templateName: "udp-web" }] },
      },
    },
  },
};

function applied(s: DeliverySpec, live: unknown = LIVE): Json {
  const built = argoStrategy(s, BASE);
  if ("issue" in built) throw new Error(built.issue);
  return mergePatch(
    live,
    argoRolloutPatch(s, built.strategy, BASE, false),
  ) as Json;
}

const strategyOf = (rollout: Json): Json =>
  (rollout["spec"] as { strategy: Json }).strategy;

describe("Argo Rollouts", () => {
  it("I4: udp-driven CANARY ⇒ KHÔNG analysis sau khi áp lên Rollout có analysis; mỗi bậc là setWeight + pause vô hạn", () => {
    const canary = strategyOf(applied(spec()))["canary"] as Json;
    expect(canary).not.toHaveProperty("analysis");
    expect(canary["steps"]).toEqual(
      canaryWeights(20).flatMap((w) => [{ setWeight: w }, { pause: {} }]),
    );
    expect(canaryWeights(20)).toEqual([20, 40, 60, 80]);
    // trafficRouting của bản gốc giữ nguyên — setWeight là trọng số traffic, không phải số pod
    expect(canary["trafficRouting"]).toEqual(BASE.canary?.["trafficRouting"]);
  });

  it("tool-driven CANARY: bậc có hạn, analysis nền trỏ AnalysisTemplate của workload", () => {
    const canary = strategyOf(applied(spec({ mode: "tool-driven" })))[
      "canary"
    ] as Json;
    expect(canary["analysis"]).toEqual({
      templates: [{ templateName: "udp-web" }],
    });
    expect((canary["steps"] as Json[])[1]).toEqual({
      pause: { duration: "300s" },
    });
  });

  it("thiếu trafficRouting ⇒ không dựng, kèm lý do", () => {
    const built = argoStrategy(spec(), { canary: { steps: [] } });
    expect(built).toEqual({ issue: expect.stringContaining("trafficRouting") });
  });

  it("BLUE_GREEN xoá canary, dựng blueGreen với preview; udp-driven không tự chuyển; session CANARY sau đó lấy lại canary từ bản gốc", () => {
    const bg = applied(spec({ strategy: "BLUE_GREEN" }));
    expect(strategyOf(bg)).toEqual({
      blueGreen: {
        activeService: "web",
        previewService: "web-preview",
        autoPromotionEnabled: false,
      },
    });
    const next = applied(spec(), bg);
    expect(strategyOf(next)).not.toHaveProperty("blueGreen");
    expect((strategyOf(next)["canary"] as Json)["trafficRouting"]).toEqual(
      BASE.canary?.["trafficRouting"],
    );
  });

  it("ATTRIBUTE_SPLIT udp-driven: trọng số 0, một pod canary, dừng vô hạn — route header là của Service 3", () => {
    const canary = strategyOf(applied(spec({ strategy: "ATTRIBUTE_SPLIT" })))[
      "canary"
    ] as Json;
    expect(canary["steps"]).toEqual([
      { setCanaryScale: { replicas: 1 } },
      { pause: {} },
    ]);
    expect(canary).not.toHaveProperty("analysis");
  });

  it("chú thích của session; strategy gốc ghi MỘT lần — không bao giờ bị strategy của session đè", () => {
    const s = spec();
    const built = argoStrategy(s, BASE);
    if ("issue" in built) throw new Error(built.issue);
    const first = argoRolloutPatch(s, built.strategy, BASE, false) as {
      metadata: { annotations: Record<string, string> };
    };
    expect(first.metadata.annotations).toEqual({
      [DELIVERY_ANNOTATIONS.session]: s.sessionId,
      [DELIVERY_ANNOTATIONS.mode]: "udp-driven",
      [DELIVERY_ANNOTATIONS.strategy]: "CANARY",
      [DELIVERY_ANNOTATIONS.previousStrategy]: JSON.stringify(BASE),
    });
    const again = argoRolloutPatch(s, built.strategy, BASE, true) as {
      metadata: { annotations: Record<string, string> };
    };
    expect(again.metadata.annotations).not.toHaveProperty(
      DELIVERY_ANNOTATIONS.previousStrategy,
    );
  });

  it("AnalysisTemplate đo tỉ lệ lỗi của ĐÚNG phiên bản mới bằng PromQL của Service 3, cùng ngưỡng", () => {
    const template = argoAnalysisTemplate(spec({ mode: "tool-driven" }), {
      prometheusUrl: "http://prometheus.udp-system:9090",
      versionNew: "v2",
    });
    const metric = ((template["spec"] as { metrics: Json[] }).metrics[0] ??
      {}) as Json & { provider: { prometheus: { query: string } } };
    expect(template.metadata.name).toBe("udp-web");
    expect(metric.provider.prometheus.query).toContain('service_version="v2"');
    expect(metric.provider.prometheus.query).toContain('service_name="web"');
    expect(metric["failureLimit"]).toBe(1);
    expect(metric["successCondition"]).toBe(
      `result[0] <= ${String(DEFAULT_ROLLOUT_THRESHOLDS.errorRate)}`,
    );
  });

  it("service preview chép cổng và selector, KHÔNG chép nodePort của service gốc", () => {
    const preview = previewService(spec({ strategy: "BLUE_GREEN" }), {
      spec: {
        selector: { app: "web" },
        ports: [
          {
            name: "http",
            port: 80,
            targetPort: 8080,
            nodePort: 30080,
          } as never,
        ],
      },
    });
    expect(preview.metadata.name).toBe("web-preview");
    expect(preview["spec"]).toEqual({
      selector: { app: "web" },
      ports: [{ name: "http", port: 80, targetPort: 8080 }],
    });
  });
});

describe("ma trận §7.2 (supportIssue)", () => {
  it("các ô làm được", () => {
    for (const mode of ["udp-driven", "tool-driven"] as const) {
      for (const strategy of ["CANARY", "BLUE_GREEN"] as const) {
        expect(
          supportIssue("argo-rollouts", mode, strategy, "nginx"),
        ).toBeUndefined();
      }
      for (const strategy of ["CANARY", "ATTRIBUTE_SPLIT"] as const) {
        expect(
          supportIssue("flagger", mode, strategy, "linkerd"),
        ).toBeUndefined();
      }
    }
    expect(
      supportIssue("argo-rollouts", "udp-driven", "ATTRIBUTE_SPLIT", "istio"),
    ).toBeUndefined();
  });

  it("các ô không làm được nói đúng lý do", () => {
    expect(supportIssue("spinnaker", "udp-driven", "CANARY", "istio")).toMatch(
      /chưa có executor/,
    );
    expect(
      supportIssue("flagger", "udp-driven", "BLUE_GREEN", "istio"),
    ).toMatch(/Argo Rollouts/);
    expect(
      supportIssue("argo-rollouts", "tool-driven", "ATTRIBUTE_SPLIT", "istio"),
    ).toMatch(/Flagger/);
    expect(
      supportIssue("argo-rollouts", "udp-driven", "ATTRIBUTE_SPLIT", "nginx"),
    ).toMatch(/Istio/);
  });
});

describe("Flagger", () => {
  const secret = "bi-mat-noi-bo-du-dai-0000000000";
  const gate = (s: DeliverySpec) => ({
    baseUrl: "http://pd-controller.udp.svc:3003/",
    token: flaggerGateToken(secret, s.sessionId),
  });
  const analysisOf = (manifest: Json) =>
    (manifest["spec"] as { analysis: Json }).analysis;

  it("udp-driven CANARY: không metrics, ba gate tới Service 3 mang token của session", () => {
    const s = spec({ tool: "flagger", router: "linkerd" });
    const canary = flaggerCanary(s, { servicePort: 80, gate: gate(s) });
    const analysis = analysisOf(canary);
    expect(analysis["metrics"]).toEqual([]);
    expect(analysis["stepWeight"]).toBe(20);
    expect(analysis["maxWeight"]).toBe(80);
    expect(analysis["threshold"]).toBe(2);
    expect(analysis["webhooks"]).toEqual(
      ["confirm-traffic-increase", "confirm-promotion", "rollback"].map(
        (type) => ({
          name: `udp-${type}`,
          type,
          url: `http://pd-controller.udp.svc:3003/webhooks/flagger/${s.sessionId}/${type}`,
          timeout: "10s",
          metadata: { token: flaggerGateToken(secret, s.sessionId) },
        }),
      ),
    );
    expect(canary["spec"]).toMatchObject({
      targetRef: { apiVersion: "apps/v1", kind: "Deployment", name: "web" },
      service: { port: 80 },
    });
  });

  it("tool-driven: metrics dựng sẵn theo ngưỡng của session, chỉ gate rollback", () => {
    const s = spec({ tool: "flagger", mode: "tool-driven" });
    const analysis = analysisOf(
      flaggerCanary(s, { servicePort: 80, gate: gate(s) }),
    );
    expect(analysis["metrics"]).toEqual([
      {
        name: "request-success-rate",
        thresholdRange: {
          min: (1 - DEFAULT_ROLLOUT_THRESHOLDS.errorRate) * 100,
        },
        interval: "60s",
      },
      {
        name: "request-duration",
        thresholdRange: { max: DEFAULT_ROLLOUT_THRESHOLDS.latencyP99Ms },
        interval: "60s",
      },
    ]);
    expect((analysis["webhooks"] as Json[]).map((w) => w["type"])).toEqual([
      "rollback",
    ]);
  });

  it("ATTRIBUTE_SPLIT = A/B: khớp header, số vòng đủ một dwell; udp-driven chỉ gate promotion + rollback", () => {
    const s = spec({
      tool: "flagger",
      strategy: "ATTRIBUTE_SPLIT",
      trafficMatch: { header: "X-Beta", value: "1" },
    });
    const analysis = analysisOf(
      flaggerCanary(s, { servicePort: 80, gate: gate(s) }),
    );
    expect(analysis["match"]).toEqual([
      { headers: { "x-beta": { exact: "1" } } },
    ]);
    expect(analysis["iterations"]).toBe(10);
    expect(analysis).not.toHaveProperty("stepWeight");
    expect((analysis["webhooks"] as Json[]).map((w) => w["type"])).toEqual([
      "confirm-promotion",
      "rollback",
    ]);
  });
});

describe("sau session (QĐ-10) và đổi tag", () => {
  it("patchToward: merge patch đưa ĐÚNG về đích — khoá thừa bị xoá, object đệ quy", () => {
    const current = {
      blueGreen: { activeService: "web" },
      canary: { steps: [1], analysis: { a: 1 }, stableService: "web" },
    };
    const target = { canary: { steps: [2], stableService: "web" } };
    expect(mergePatch(current, patchToward(current, target))).toEqual(target);
  });

  it("restoreAfterSession: có chú thích session + bản gốc ⇒ patch về bản gốc, bỏ chú thích session; không có ⇒ null", () => {
    const state = {
      metadata: {
        annotations: {
          [DELIVERY_ANNOTATIONS.session]: "s-1",
          [DELIVERY_ANNOTATIONS.mode]: "tool-driven",
          [DELIVERY_ANNOTATIONS.strategy]: "CANARY",
          [DELIVERY_ANNOTATIONS.previousStrategy]: JSON.stringify(BASE),
        },
      },
      spec: { strategy: LIVE.spec.strategy as Json },
    };
    const restored = mergePatch(state, restoreAfterSession(state)) as {
      metadata: { annotations: Json };
      spec: { strategy: Json };
    };
    expect(restored.spec.strategy).toEqual(BASE);
    expect(Object.keys(restored.metadata.annotations)).toEqual([
      DELIVERY_ANNOTATIONS.previousStrategy,
    ]);
    expect(restoreAfterSession({ spec: { strategy: {} } })).toBeNull();
  });

  it("imageWithTag giữ registry và repository, bỏ tag cũ và digest", () => {
    expect(imageWithTag("ghcr.io/acme/web:v1", "v2")).toBe(
      "ghcr.io/acme/web:v2",
    );
    expect(imageWithTag("ghcr.io/acme/web:v1@sha256:abc", "v2")).toBe(
      "ghcr.io/acme/web:v2",
    );
    expect(imageWithTag("registry:5000/web", "v2")).toBe(
      "registry:5000/web:v2",
    );
    expect(imageWithTag("web", "v2")).toBe("web:v2");
  });
});
