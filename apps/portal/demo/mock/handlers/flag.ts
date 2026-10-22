import type {
  FlagDetailWire,
  RuleWire,
  SegmentDetailWire,
} from "@udp/shared-types/wire";
import { daysAgo, hoursAhead, nowIso } from "../clock";
import type { Db, FlagRecord, ProjectRecord } from "../db";
import {
  bodyOf,
  found,
  HttpProblem,
  intParam,
  noContent,
  ok,
  projectOf,
  type Router,
} from "../router";
import { refreshSegmentUsage, TELEMETRY_SINCE } from "../seed";
import { audit } from "./project";

/** Flag, rule, variant, promote, bộ thử, thống kê, dọn dẹp, segment (§9 nhóm flag) */

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

const flagOf = (p: ProjectRecord, flagId: string): FlagRecord =>
  found(
    p.flags.find((f) => f.detail.id === flagId),
    "flag",
  );

function envStateOf(flag: FlagRecord, envId: string) {
  return found(
    flag.detail.envs.find((e) => e.environment.id === envId),
    "cấu hình flag ở environment này",
  );
}

function touch(db: Db, flag: FlagRecord): void {
  flag.detail.updatedAt = nowIso();
  db.configVersion += 1;
}

function summaryOf(flag: FlagRecord, envId: string | null, withStats: boolean) {
  const env =
    envId === null
      ? undefined
      : flag.detail.envs.find((e) => e.environment.id === envId);
  const daily = envId === null ? [] : (flag.daily[envId] ?? []);
  return {
    id: flag.detail.id,
    key: flag.detail.key,
    flagType: flag.detail.flagType,
    description: flag.detail.description,
    lifecycleStatus: flag.detail.lifecycleStatus,
    activatedAt: flag.detail.activatedAt,
    updatedAt: flag.detail.updatedAt,
    ...(env === undefined
      ? {}
      : {
          env: {
            configId: env.configId,
            isEnabled: env.isEnabled,
            isTracked: env.isTracked,
            ruleCount: env.ruleCount,
          },
        }),
    ...(withStats
      ? {
          stats: {
            evalCount7d: sum(daily.slice(-7)),
            daily14: Array.from(
              { length: 14 },
              (_, i) => daily[daily.length - 14 + i] ?? 0,
            ),
          },
        }
      : {}),
  };
}

/** Đếm theo variant từ tỉ lệ quan sát — cùng tổng với chuỗi ngày */
function variantCounts(flag: FlagRecord, envId: string, total: number) {
  const mix = flag.mix[envId] ?? {};
  return Object.entries(mix)
    .filter(([, share]) => share > 0)
    .map(([variantKey, share]) => ({
      variantKey,
      count: Math.round(total * share),
    }));
}

function archiveStatus(flag: FlagRecord, p: ProjectRecord) {
  const prod = p.environments.filter((e) => e.isProduction).map((e) => e.id);
  const evalCount7d = sum(
    prod.flatMap((id) => (flag.daily[id] ?? []).slice(-7)),
  );
  const live = p.rollouts.find(
    (r) =>
      r.flag?.id === flag.detail.id &&
      (r.status === "IN_PROGRESS" || r.status === "PAUSED"),
  );
  if (live !== undefined) {
    return {
      allowed: false,
      blockedBy: "LIVE_ROLLOUT" as const,
      evalCount7d,
      lastEvaluatedAt: flag.lastEvaluatedAt,
      rolloutId: live.id,
    };
  }
  if (evalCount7d > 0) {
    return {
      allowed: false,
      blockedBy: "RECENT_EVALUATIONS" as const,
      evalCount7d,
      lastEvaluatedAt: flag.lastEvaluatedAt,
      archivableAfter: hoursAhead(24 * 7),
    };
  }
  return { allowed: true, evalCount7d, lastEvaluatedAt: flag.lastEvaluatedAt };
}

/** Bộ thử (§6.5, rút gọn): đủ bốn loại rule, chia tỉ lệ theo băm ổn định của targetingKey */
function evaluate(
  p: ProjectRecord,
  flag: FlagRecord,
  envId: string,
  context: Record<string, unknown>,
) {
  const env = envStateOf(flag, envId);
  const variantBy = (id: string | null) =>
    flag.detail.variants.find((v) => v.id === id);
  const fallback = variantBy(
    env.defaultVariantId ?? flag.detail.defaultVariantId,
  );
  const answer = (
    reason: "TARGETING_MATCH" | "SPLIT" | "DEFAULT" | "DISABLED",
    variant = fallback,
    rule?: RuleWire,
  ) => ({
    evaluation: {
      reason,
      ...(reason === "DISABLED" || variant === undefined
        ? {}
        : { value: variant.value, variant: variant.key }),
      ...(rule === undefined ? {} : { ruleId: rule.id }),
    },
    ...(rule === undefined
      ? {}
      : {
          rule: {
            id: rule.id,
            ruleType: rule.ruleType,
            priority: rule.priority,
          },
        }),
    configVersion: 1_284,
    draft: flag.detail.lifecycleStatus === "DRAFT",
  });
  if (!env.isEnabled) return answer("DISABLED");
  const key = String(context["targetingKey"] ?? "");
  const segments = new Map(p.segments.map((s) => [s.id, s]));
  const rules = [...(flag.rules[envId] ?? [])].sort(
    (a, b) => a.priority - b.priority,
  );
  for (const rule of rules) {
    if (!matches(rule, context, key, segments)) continue;
    if (rule.serve.kind === "variant") {
      return answer("TARGETING_MATCH", variantBy(rule.serve.variantId), rule);
    }
    let bucket = hashBucket(`${flag.detail.key}:${key}`);
    for (const w of rule.serve.weights) {
      if (bucket < w.weight)
        return answer("SPLIT", variantBy(w.variantId), rule);
      bucket -= w.weight;
    }
  }
  return answer("DEFAULT");
}

function hashBucket(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100_000;
}

interface Condition {
  attribute: string;
  operator: string;
  value: unknown;
}

function conditionHolds(
  c: Condition,
  context: Record<string, unknown>,
): boolean {
  const actual = context[c.attribute];
  if (actual === undefined) return false;
  const text = String(actual);
  const values = Array.isArray(c.value)
    ? c.value.map(String)
    : [String(c.value)];
  const semver = (v: string) => v.split(".").map((n) => Number(n));
  const cmp = (a: string, b: string) => {
    const [x, y] = [semver(a), semver(b)];
    for (let i = 0; i < 3; i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  switch (c.operator) {
    case "eq":
      return text === values[0];
    case "neq":
      return text !== values[0];
    case "in":
      return values.includes(text);
    case "nin":
      return !values.includes(text);
    case "gt":
      return Number(actual) > Number(c.value);
    case "gte":
      return Number(actual) >= Number(c.value);
    case "lt":
      return Number(actual) < Number(c.value);
    case "lte":
      return Number(actual) <= Number(c.value);
    case "contains":
      return text.includes(values[0] ?? "");
    case "startsWith":
      return text.startsWith(values[0] ?? "");
    case "endsWith":
      return text.endsWith(values[0] ?? "");
    case "semverGt":
      return cmp(text, values[0] ?? "0.0.0") > 0;
    case "semverLt":
      return cmp(text, values[0] ?? "0.0.0") < 0;
    case "regex":
      try {
        return new RegExp(values[0] ?? "").test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function matches(
  rule: RuleWire,
  context: Record<string, unknown>,
  key: string,
  segments: Map<string, SegmentDetailWire>,
): boolean {
  const condition = rule.condition as {
    all?: Condition[];
    userIds?: string[];
    segmentId?: string;
  };
  switch (rule.ruleType) {
    case "ALL":
      return true;
    case "USER_BASED":
      return (condition.userIds ?? []).includes(key);
    case "ATTRIBUTE_BASED":
      return (condition.all ?? []).every((c) => conditionHolds(c, context));
    case "SEGMENT": {
      const segment = segments.get(condition.segmentId ?? "");
      if (segment === undefined) return false;
      return (
        segment.conditions.userIds.includes(key) ||
        (segment.conditions.all.length > 0 &&
          segment.conditions.all.every((c) =>
            conditionHolds(c as Condition, context),
          ))
      );
    }
  }
}

function statsView(
  p: ProjectRecord,
  flag: FlagRecord,
  envId: string | null,
  days: number,
  tz: string,
) {
  const envs = p.environments.filter((e) => envId === null || e.id === envId);
  const byEnv = envs.map((env) => {
    const daily = (flag.daily[env.id] ?? []).slice(-days);
    const total = sum(daily);
    const counts = variantCounts(flag, env.id, total);
    return {
      evalCount: total,
      lastEvaluatedAt: total > 0 ? flag.lastEvaluatedAt : null,
      variants: counts.map((c) => ({
        ...c,
        share: total === 0 ? 0 : c.count / total,
        known: flag.detail.variants.some((v) => v.key === c.variantKey),
      })),
      series: daily.map((count, i) => ({
        at: daysAgo(daily.length - 1 - i).slice(0, "YYYY-MM-DD".length),
        count,
      })),
      environment: {
        id: env.id,
        name: env.name,
        isProduction: env.isProduction,
      },
    };
  });
  return {
    window: { from: daysAgo(days), to: nowIso(), granularity: "day", tz },
    totals: {
      evalCount: sum(byEnv.map((e) => e.evalCount)),
      lastEvaluatedAt: flag.lastEvaluatedAt,
    },
    byEnv,
    archive: archiveStatus(flag, p),
    clientTrafficUnobserved: false,
    telemetryGaps: [],
  };
}

function staleItem(p: ProjectRecord, flag: FlagRecord) {
  const prod = p.environments.find((e) => e.isProduction);
  const daily30 = prod === undefined ? [] : (flag.daily[prod.id] ?? []);
  const evalCount30d = sum(daily30);
  const distribution =
    prod === undefined ? [] : variantCounts(flag, prod.id, evalCount30d);
  const settled = flag.stale === "SETTLED" ? distribution[0] : undefined;
  return {
    flag: {
      id: flag.detail.id,
      key: flag.detail.key,
      description: flag.detail.description,
      lifecycleStatus:
        flag.detail.lifecycleStatus === "DRAFT"
          ? ("DRAFT" as const)
          : ("ACTIVE" as const),
      flagType: flag.detail.flagType,
      createdAt: flag.detail.createdAt,
      activatedAt: flag.detail.activatedAt,
      updatedAt: flag.detail.updatedAt,
    },
    category: flag.stale ?? "UNUSED",
    lastEvaluatedAt: flag.lastEvaluatedAt,
    evalCount30d,
    ...(settled === undefined ? {} : { settled }),
    distribution,
    byEnv: p.environments.map((env) => {
      const total = sum((flag.daily[env.id] ?? []).slice(-14));
      return {
        environmentId: env.id,
        evalCount14d: total,
        variants: variantCounts(flag, env.id, total),
      };
    }),
    archive: archiveStatus(flag, p),
    clientTrafficUnobserved: false,
  };
}

function setRules(
  p: ProjectRecord,
  flag: FlagRecord,
  envId: string,
  input: Partial<RuleWire>[],
): RuleWire[] {
  const rules = input.map((r, i): RuleWire => ({
    id: r.id ?? crypto.randomUUID(),
    priority: r.priority ?? (i + 1) * 10,
    ruleType: r.ruleType ?? "ALL",
    condition: r.condition ?? {},
    serve: r.serve ?? {
      kind: "variant",
      variantId: flag.detail.defaultVariantId ?? "",
    },
    description: r.description ?? null,
  }));
  flag.rules[envId] = rules;
  flag.rulesUpdatedAt[envId] = nowIso();
  envStateOf(flag, envId).ruleCount = rules.length;
  refreshSegmentUsage(p);
  return rules;
}

type Lifecycle = FlagDetailWire["lifecycleStatus"];

/** Mã audit của một PATCH flag, như Service 2: đổi vòng đời lấy tên của vòng đời */
function lifecycleAction(from: Lifecycle, to: Lifecycle | undefined): string {
  if (to === undefined || to === from) return "flag.update";
  if (to === "ARCHIVED") return "flag.archive";
  if (to === "ACTIVE")
    return from === "ARCHIVED" ? "flag.restore" : "flag.activate";
  return "flag.update";
}

function archive(flag: FlagRecord): void {
  flag.detail.lifecycleStatus = "ARCHIVED";
  for (const env of flag.detail.envs) env.isEnabled = false;
}

export function registerFlagRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/projects/:id/flags", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const envId = req.query.get("envId");
      const search = (req.query.get("search") ?? "").toLowerCase();
      const status = req.query.get("status");
      const isEnabled = req.query.get("isEnabled");
      const offset = intParam(req.query, "offset", 0);
      const limit = intParam(req.query, "limit", 50);
      const list = p.flags
        .filter(
          (f) =>
            search === "" ||
            f.detail.key.includes(search) ||
            (f.detail.description ?? "").toLowerCase().includes(search),
        )
        .filter((f) => status === null || f.detail.lifecycleStatus === status)
        .filter((f) => {
          if (isEnabled === null || envId === null) return true;
          const env = f.detail.envs.find((e) => e.environment.id === envId);
          return env?.isEnabled === (isEnabled === "true");
        })
        .sort((a, b) => b.detail.createdAt.localeCompare(a.detail.createdAt));
      return ok({
        flags: list
          .slice(offset, offset + limit)
          .map((f) =>
            summaryOf(f, envId, req.query.get("include") === "stats"),
          ),
        total: list.length,
      });
    })
    .on("POST", "/projects/:id/flags", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const body = bodyOf<{
        key: string;
        flagType: FlagDetailWire["flagType"];
        description?: string;
        variants?: { key: string; value: unknown }[];
        defaultVariantKey?: string;
      }>(req);
      if (p.flags.some((f) => f.detail.key === body.key)) {
        throw new HttpProblem(
          409,
          "FLAG_KEY_TAKEN",
          `Flag "${body.key}" đã có trong project`,
        );
      }
      const variants = (
        body.variants ?? [
          { key: "off", value: false },
          { key: "on", value: true },
        ]
      ).map((v) => ({ id: crypto.randomUUID(), key: v.key, value: v.value }));
      const defaultKey = body.defaultVariantKey ?? variants[0]?.key;
      const at = nowIso();
      const record: FlagRecord = {
        detail: {
          id: crypto.randomUUID(),
          key: body.key,
          flagType: body.flagType,
          description: body.description ?? null,
          lifecycleStatus: "DRAFT",
          stickinessAttribute: "targetingKey",
          defaultVariantId:
            variants.find((v) => v.key === defaultKey)?.id ?? null,
          permanent: false,
          activatedAt: null,
          createdAt: at,
          updatedAt: at,
          variants,
          envs: p.environments.map((env) => ({
            environment: {
              id: env.id,
              name: env.name,
              isProduction: env.isProduction,
            },
            configId: crypto.randomUUID(),
            isEnabled: false,
            defaultVariantId: null,
            isTracked: false,
            ruleCount: 0,
            updatedAt: at,
          })),
        },
        rules: Object.fromEntries(p.environments.map((e) => [e.id, []])),
        rulesUpdatedAt: Object.fromEntries(
          p.environments.map((e) => [e.id, at]),
        ),
        daily: Object.fromEntries(
          p.environments.map((e) => [
            e.id,
            Array.from({ length: 30 }, () => 0),
          ]),
        ),
        mix: Object.fromEntries(p.environments.map((e) => [e.id, {}])),
        lastEvaluatedAt: null,
      };
      p.flags.unshift(record);
      audit(db, p, "flag.create", "FeatureFlag", record.detail.id, null, {
        key: body.key,
        flagType: body.flagType,
        description: record.detail.description,
      });
      return ok({ flag: record.detail }, 201);
    })
    .on("GET", "/projects/:id/flags/stale", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const category = req.query.get("category");
      const candidates = p.flags.filter(
        (f) => f.stale !== undefined && f.detail.lifecycleStatus !== "ARCHIVED",
      );
      const counts = { UNUSED: 0, SETTLED: 0, STALE_DRAFT: 0 };
      for (const f of candidates)
        if (f.stale !== undefined) counts[f.stale] += 1;
      const items = candidates
        .filter((f) => category === null || f.stale === category)
        .map((f) => staleItem(p, f));
      return ok({
        telemetry: {
          firstReportAt: `${TELEMETRY_SINCE}T00:00:00.000Z`,
          observedDays: 58,
        },
        telemetryGaps: [],
        counts,
        total: items.length,
        items,
      });
    })
    .on("POST", "/projects/:id/flags/bulk-archive", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const { flags } = bodyOf<{ flags: { flagId: string }[] }>(req);
      const results = flags.map(({ flagId }) => {
        const flag = flagOf(p, flagId);
        const status = archiveStatus(flag, p);
        if (!status.allowed) {
          return {
            flagId,
            ok: false as const,
            problem: {
              status: 409,
              title: "Flag was evaluated recently",
              detail: `Flag còn ${String(status.evalCount7d)} lượt đánh giá trong 7 ngày gần nhất. Gỡ flag khỏi code của bạn trước khi lưu trữ nó`,
              code: "FLAG_RECENTLY_EVALUATED",
            },
          };
        }
        archive(flag);
        touch(db, flag);
        audit(
          db,
          p,
          "flag.archive",
          "FeatureFlag",
          flag.detail.id,
          { lifecycleStatus: "ACTIVE" },
          { lifecycleStatus: "ARCHIVED" },
        );
        return { flagId, ok: true as const, flag: flag.detail };
      });
      return ok({ results });
    })
    .on("GET", "/projects/:id/flags/:flagId", (_req, [id = "", flagId = ""]) =>
      ok({ flag: flagOf(projectOf(db, id), flagId).detail }),
    )
    .on(
      "PATCH",
      "/projects/:id/flags/:flagId",
      (req, [id = "", flagId = ""]) => {
        const p = projectOf(db, id);
        const flag = flagOf(p, flagId);
        const body = bodyOf<{
          description?: string | null;
          lifecycleStatus?: FlagDetailWire["lifecycleStatus"];
          permanent?: boolean;
          stickinessAttribute?: string;
        }>(req);
        const before = {
          lifecycleStatus: flag.detail.lifecycleStatus,
          description: flag.detail.description,
        };
        const action = lifecycleAction(
          flag.detail.lifecycleStatus,
          body.lifecycleStatus,
        );
        if (body.description !== undefined)
          flag.detail.description = body.description;
        if (body.permanent !== undefined)
          flag.detail.permanent = body.permanent;
        if (body.stickinessAttribute !== undefined)
          flag.detail.stickinessAttribute = body.stickinessAttribute;
        if (body.lifecycleStatus !== undefined) {
          if (body.lifecycleStatus === "ARCHIVED") archive(flag);
          flag.detail.lifecycleStatus = body.lifecycleStatus;
          if (
            body.lifecycleStatus === "ACTIVE" &&
            flag.detail.activatedAt === null
          ) {
            flag.detail.activatedAt = nowIso();
          }
        }
        touch(db, flag);
        audit(db, p, action, "FeatureFlag", flag.detail.id, before, body);
        return ok({ flag: flag.detail });
      },
    )
    .on(
      "GET",
      "/projects/:id/flags/:flagId/envs",
      (_req, [id = "", flagId = ""]) =>
        ok({ envs: flagOf(projectOf(db, id), flagId).detail.envs }),
    )
    .on(
      "PATCH",
      "/projects/:id/flags/:flagId/envs/:envId",
      (req, [id = "", flagId = "", envId = ""]) => {
        const p = projectOf(db, id);
        const flag = flagOf(p, flagId);
        const env = envStateOf(flag, envId);
        const body = bodyOf<{
          isEnabled?: boolean;
          defaultVariantId?: string | null;
        }>(req);
        const before = {
          isEnabled: env.isEnabled,
          defaultVariantId: env.defaultVariantId,
        };
        if (body.isEnabled !== undefined) env.isEnabled = body.isEnabled;
        if (body.defaultVariantId !== undefined)
          env.defaultVariantId = body.defaultVariantId;
        env.updatedAt = nowIso();
        touch(db, flag);
        audit(
          db,
          p,
          "flag.env.update",
          "FlagEnvConfig",
          env.configId,
          before,
          { ...body, flagKey: flag.detail.key },
          envId,
        );
        return ok({ env });
      },
    )
    .on(
      "GET",
      "/projects/:id/flags/:flagId/envs/:envId/rules",
      (_req, [id = "", flagId = "", envId = ""]) => {
        const flag = flagOf(projectOf(db, id), flagId);
        envStateOf(flag, envId);
        return ok({
          updatedAt: flag.rulesUpdatedAt[envId] ?? flag.detail.updatedAt,
          rules: flag.rules[envId] ?? [],
        });
      },
    )
    .on(
      "PUT",
      "/projects/:id/flags/:flagId/envs/:envId/rules",
      (req, [id = "", flagId = "", envId = ""]) => {
        const p = projectOf(db, id);
        const flag = flagOf(p, flagId);
        const { rules } = bodyOf<{ rules: Partial<RuleWire>[] }>(req);
        const before = flag.rules[envId] ?? [];
        const saved = setRules(p, flag, envId, rules);
        touch(db, flag);
        audit(
          db,
          p,
          "flag.rule.update",
          "FlagEnvConfig",
          envStateOf(flag, envId).configId,
          { rules: before },
          { rules: saved, flagKey: flag.detail.key },
          envId,
        );
        return ok({ updatedAt: flag.rulesUpdatedAt[envId], rules: saved });
      },
    )
    .on(
      "GET",
      "/projects/:id/flags/:flagId/variants",
      (_req, [id = "", flagId = ""]) =>
        ok({ variants: flagOf(projectOf(db, id), flagId).detail.variants }),
    )
    .on(
      "PUT",
      "/projects/:id/flags/:flagId/variants",
      (req, [id = "", flagId = ""]) => {
        const p = projectOf(db, id);
        const flag = flagOf(p, flagId);
        const { variants } = bodyOf<{
          variants: { id?: string; key: string; value: unknown }[];
        }>(req);
        flag.detail.variants = variants.map((v) => ({
          id: v.id ?? crypto.randomUUID(),
          key: v.key,
          value: v.value,
        }));
        if (
          !flag.detail.variants.some(
            (v) => v.id === flag.detail.defaultVariantId,
          )
        ) {
          flag.detail.defaultVariantId = flag.detail.variants[0]?.id ?? null;
        }
        touch(db, flag);
        audit(
          db,
          p,
          "flag.variants.update",
          "FeatureFlag",
          flag.detail.id,
          null,
          { variants: variants.map((v) => v.key) },
        );
        return ok({ flag: flag.detail });
      },
    )
    .on(
      "POST",
      "/projects/:id/flags/:flagId/promote",
      (req, [id = "", flagId = ""]) => {
        const p = projectOf(db, id);
        const flag = flagOf(p, flagId);
        const { fromEnvId, toEnvId } = bodyOf<{
          fromEnvId: string;
          toEnvId: string;
        }>(req);
        const source = flag.rules[fromEnvId] ?? [];
        const target = flag.rules[toEnvId] ?? [];
        const same = (a: RuleWire, b: RuleWire) =>
          a.ruleType === b.ruleType &&
          JSON.stringify(a.condition) === JSON.stringify(b.condition) &&
          JSON.stringify(a.serve) === JSON.stringify(b.serve);
        const diff = [
          ...source.map((rule, index) => {
            const old = target[index];
            if (old === undefined)
              return {
                kind: "added" as const,
                index,
                ruleType: rule.ruleType,
                description: rule.description,
              };
            return same(rule, old)
              ? {
                  kind: "same" as const,
                  index,
                  ruleType: rule.ruleType,
                  description: rule.description,
                  keptId: old.id,
                }
              : {
                  kind: "changed" as const,
                  index,
                  ruleType: rule.ruleType,
                  description: rule.description,
                  keptId: old.id,
                };
          }),
          ...target.slice(source.length).map((rule, i) => ({
            kind: "removed" as const,
            index: source.length + i,
            ruleType: rule.ruleType,
            description: rule.description,
          })),
        ];
        const rules = setRules(
          p,
          flag,
          toEnvId,
          source.map((r, i) => ({
            ...r,
            id: target[i]?.id ?? crypto.randomUUID(),
          })),
        );
        touch(db, flag);
        // Promote là một lần ghi rule ở env đích, có ghi env nguồn
        audit(
          db,
          p,
          "flag.rule.update",
          "FlagEnvConfig",
          envStateOf(flag, toEnvId).configId,
          { rules: target },
          {
            rules,
            flagKey: flag.detail.key,
            promotedFromEnvironmentId: fromEnvId,
          },
          toEnvId,
        );
        return ok({
          updatedAt: flag.rulesUpdatedAt[toEnvId],
          rules,
          diff,
          changes: diff.filter((d) => d.kind !== "same").length,
        });
      },
    )
    .on(
      "POST",
      "/projects/:id/flags/:flagId/evaluate",
      (req, [id = "", flagId = ""]) => {
        const p = projectOf(db, id);
        const { envId, context } = bodyOf<{
          envId: string;
          context: Record<string, unknown>;
        }>(req);
        return ok(evaluate(p, flagOf(p, flagId), envId, context));
      },
    )
    .on(
      "GET",
      "/projects/:id/flags/:flagId/stats",
      (req, [id = "", flagId = ""]) => {
        const p = projectOf(db, id);
        const days = Math.min(Math.max(intParam(req.query, "days", 7), 1), 30);
        return ok(
          statsView(
            p,
            flagOf(p, flagId),
            req.query.get("envId"),
            days,
            req.query.get("tz") ?? "UTC",
          ),
        );
      },
    )

    // ---------------------------------------------------------- segment
    .on("GET", "/projects/:id/segments", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      return ok({
        segments: p.segments.map(
          ({ conditions: _conditions, usage, ...rest }) => ({
            ...rest,
            usage: {
              flagCount: usage.flagCount,
              productionFlagCount: usage.productionFlagCount,
            },
          }),
        ),
        quota: {
          segmentCount: p.segments.length,
          maxSegments: 100,
          payloadBytes: sum(p.segments.map((s) => s.summary.payloadBytes)),
          maxPayloadBytes: 4_194_304,
        },
      });
    })
    .on(
      "GET",
      "/projects/:id/segments/:segmentId",
      (_req, [id = "", segmentId = ""]) =>
        ok({
          segment: found(
            projectOf(db, id).segments.find((s) => s.id === segmentId),
            "segment",
          ),
        }),
    )
    .on("POST", "/projects/:id/segments", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const body = bodyOf<{
        name: string;
        description?: string | null;
        conditions: SegmentDetailWire["conditions"];
      }>(req);
      if (p.segments.some((s) => s.name === body.name)) {
        throw new HttpProblem(
          409,
          "SEGMENT_NAME_TAKEN",
          `Đã có segment "${body.name}"`,
        );
      }
      const at = nowIso();
      const segment: SegmentDetailWire = {
        id: crypto.randomUUID(),
        name: body.name,
        description: body.description ?? null,
        createdAt: at,
        updatedAt: at,
        summary: summaryOfConditions(body.conditions),
        conditions: body.conditions,
        usage: { flagCount: 0, productionFlagCount: 0, flags: [] },
      };
      p.segments.push(segment);
      audit(db, p, "segment.create", "Segment", segment.id, null, {
        name: body.name,
      });
      return ok({ segment }, 201);
    })
    .on(
      "PUT",
      "/projects/:id/segments/:segmentId",
      (req, [id = "", segmentId = ""]) => {
        const p = projectOf(db, id);
        const segment = found(
          p.segments.find((s) => s.id === segmentId),
          "segment",
        );
        const body = bodyOf<{
          name?: string;
          description?: string | null;
          conditions?: SegmentDetailWire["conditions"];
        }>(req);
        if (body.name !== undefined) segment.name = body.name;
        if (body.description !== undefined)
          segment.description = body.description;
        if (body.conditions !== undefined) {
          segment.conditions = body.conditions;
          segment.summary = summaryOfConditions(body.conditions);
        }
        segment.updatedAt = nowIso();
        db.configVersion += 1;
        audit(db, p, "segment.update", "Segment", segment.id, null, {
          name: segment.name,
        });
        return ok({ segment });
      },
    )
    .on(
      "DELETE",
      "/projects/:id/segments/:segmentId",
      (_req, [id = "", segmentId = ""]) => {
        const p = projectOf(db, id);
        const segment = found(
          p.segments.find((s) => s.id === segmentId),
          "segment",
        );
        if (segment.usage.flagCount > 0) {
          throw new HttpProblem(
            409,
            "SEGMENT_IN_USE",
            `Segment đang được ${String(segment.usage.flagCount)} flag dùng. Gỡ khỏi rule trước khi xoá`,
          );
        }
        p.segments = p.segments.filter((s) => s.id !== segmentId);
        audit(
          db,
          p,
          "segment.delete",
          "Segment",
          segmentId,
          { name: segment.name },
          null,
        );
        return noContent;
      },
    );
}

function summaryOfConditions(conditions: SegmentDetailWire["conditions"]) {
  return {
    conditionCount: conditions.all.length,
    userIdCount: conditions.userIds.length,
    hasRegex: conditions.all.some((c) => c.operator === "regex"),
    payloadBytes: JSON.stringify(conditions).length,
  };
}
