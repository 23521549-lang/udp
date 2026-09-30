import type { RolloutEventWire } from "@udp/shared-types/wire";
import { elapsedSeconds, iso, nowIso, OPENED_AT } from "./clock";
import type { Db, JobRecord, LiveRollout, ProjectRecord } from "./db";
import { domainsOf } from "./seed";

/**
 * Hai thứ "đang chạy" của bản xem thử, đẩy đi theo đồng hồ thật mỗi lần có request: một rollout canary tăng từng
 * bậc (và rule chia tỉ lệ của flag đi theo), và một job dựng hạ tầng đi qua từng pha tới khi project ACTIVE.
 * Portal đã poll hai màn hình này, nên người xem thấy chúng tiến mà không phải bấm gì.
 */

function advanceRollout(
  p: ProjectRecord,
  rolloutId: string,
  live: LiveRollout,
): void {
  const rollout = p.rollouts.find((r) => r.id === rolloutId);
  if (rollout === undefined || rollout.status !== "IN_PROGRESS") return;
  const steps = Math.floor(
    (Date.now() - live.startedAt) / 1000 / live.everySeconds,
  );
  const target = Math.min(live.from + steps * live.step, live.upTo);
  while (rollout.currentTrafficPercentage < target) {
    const next = rollout.currentTrafficPercentage + live.step;
    const at = iso(
      live.startedAt +
        ((next - live.from) / live.step) * live.everySeconds * 1000,
    );
    const event: RolloutEventWire = {
      id: crypto.randomUUID(),
      action: "PROMOTE",
      isIntent: false,
      processedAt: at,
      trafficPercentage: next,
      reason: `Canary khoẻ ${String(Math.round(live.everySeconds))} giây liền: lỗi 0,4% ≤ ngưỡng 5%`,
      triggeredBy: "AUTO",
      actorUserId: null,
      causedByEventId: null,
      metricSnapshot: rollout.latestMetricSnapshot ?? null,
      createdAt: at,
    };
    rollout.events.push(event);
    rollout.currentTrafficPercentage = next;
    rollout.baselinePercentage = 100 - next;
    rollout.updatedAt = at;
  }
  const atCeiling = rollout.currentTrafficPercentage >= live.upTo;
  if (rollout.lastDecision !== undefined) {
    // Khoẻ ở mọi bậc: PROMOTE, không vượt ngưỡng; ở trần thì bậc cuối chờ người bấm
    rollout.lastDecision = {
      ...rollout.lastDecision,
      decision: "PROMOTE",
      reason: atCeiling
        ? `Đã tới ${String(live.upTo)}%, số đo trong ngưỡng. Bậc cuối lên 100% chờ người duyệt (Promote)`
        : "Lỗi canary 0,41% so với baseline 0,48%: trong ngưỡng, sẵn sàng bậc tiếp",
      breach: false,
      breachStreak: 0,
      breachAt: null,
      at: nowIso(),
    };
  }
  syncRule(p, live, rollout.currentTrafficPercentage);
}

/** Rule chia tỉ lệ của flag luôn bằng % của rollout — thứ Service 3 ghi mỗi bậc */
export function syncRule(
  p: ProjectRecord,
  live: LiveRollout,
  percent: number,
): void {
  const flag = p.flags.find((f) => f.detail.id === live.flagId);
  if (flag === undefined) return;
  for (const [envId, rules] of Object.entries(flag.rules)) {
    const rule = rules.find((r) => r.id === live.ruleId);
    if (rule === undefined) continue;
    rule.serve =
      percent >= 100
        ? { kind: "variant", variantId: live.targetVariantId }
        : {
            kind: "distribution",
            weights: [
              { weight: percent * 1000, variantId: live.targetVariantId },
              {
                weight: (100 - percent) * 1000,
                variantId: live.otherVariantId,
              },
            ],
          };
    const on = flag.detail.variants.find((v) => v.id === live.targetVariantId);
    const off = flag.detail.variants.find((v) => v.id === live.otherVariantId);
    if (on !== undefined && off !== undefined) {
      flag.mix[envId] = {
        [on.key]: percent / 100,
        [off.key]: 1 - percent / 100,
      };
    }
  }
}

function advanceJob(p: ProjectRecord, record: JobRecord): void {
  const live = record.live;
  if (live === undefined) return;
  const t = elapsedSeconds();
  const reached = live.schedule.filter((s) => s.at <= t);
  const current = reached[reached.length - 1];
  if (current === undefined) return;
  const { job } = record.detail;
  if (job.state !== current.state) {
    job.state = current.state;
    job.updatedAt = nowIso();
  }
  const phaseStart = (state: string): number =>
    live.schedule.find((s) => s.state === state)?.at ??
    Number.POSITIVE_INFINITY;
  const phaseEnd = (state: string): number => {
    const i = live.schedule.findIndex((s) => s.state === state);
    return live.schedule[i + 1]?.at ?? Number.POSITIVE_INFINITY;
  };
  record.detail.resources = live.plan.flatMap((resource) => {
    const step = resource.step;
    const start = phaseStart(step);
    const end = phaseEnd(step);
    const siblings = live.plan.filter((r) => r.step === step);
    const slot = (end - start) / (siblings.length + 1);
    const appearAt = start + slot * siblings.indexOf(resource);
    if (t < appearAt) return [];
    const ready = t >= appearAt + slot;
    return [
      {
        ...resource,
        status: ready ? ("READY" as const) : ("CREATING" as const),
        updatedAt: iso(OPENED_AT + (ready ? appearAt + slot : appearAt) * 1000),
      },
    ];
  });
  if (t >= phaseStart("DOMAINS")) {
    const done = t >= phaseEnd("DOMAINS");
    record.detail.domains = live.domains.map((d) => ({
      ...d,
      status: done ? d.status : ("DEPLOYING" as const),
    }));
  }
  if (job.state === "DONE") {
    job.cancellable = false;
    delete record.live;
    finishProvisioning(p);
  }
}

function finishProvisioning(p: ProjectRecord): void {
  p.project.status = "ACTIVE";
  const provider = p.cloud?.provider ?? "AZURE";
  const region = p.cloud?.region ?? "southeastasia";
  const endpoint = {
    AWS: `https://udp-${p.project.name}.gr7.${region}.eks.amazonaws.com`,
    GCP: "https://34.126.40.17",
    AZURE: `https://udp-${p.project.name}.hcp.${region}.azmk8s.io:443`,
  }[provider];
  p.cluster = {
    clusterId: `udp-${p.project.name}`,
    apiEndpoint: endpoint,
    provider,
    region,
  };
  p.domains = domainsOf(
    p.project.name,
    {
      CONTAINER_REGISTRY: { tool: "ghcr" },
      MONITORING: { tool: "prometheus-grafana", config: { retentionDays: 7 } },
      LOGGING: { tool: "loki" },
    },
    [],
    0,
  );
  p.preview.blockers = ["project-not-draft"];
}

export function advance(db: Db): void {
  for (const p of db.projects) {
    for (const [rolloutId, live] of Object.entries(p.liveRollouts)) {
      advanceRollout(p, rolloutId, live);
    }
    for (const record of p.jobs) advanceJob(p, record);
  }
}
