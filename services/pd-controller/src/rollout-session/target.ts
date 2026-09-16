import { flagServeDbSchema } from "@udp/shared-types";
import type { MetricTarget } from "@udp/metrics-provider";
import type { DbClient } from "../core/db.js";
import type { SessionRow } from "./types.js";

/**
 * Mục tiêu của một rollout FLAG_LEVEL — mọi thứ executor và `decide()` cần, đọc
 * MỘT lần ở đầu vòng.
 *
 * Trả `{ kind: "hold" }` thay vì ném khi session không đủ điều kiện: một session
 * cấu hình thiếu (không có `workload_name`, rule không phải phân phối hai
 * variant, thiếu baseline) phải HIỆN LÊN ở `last_decision.reason` cho người
 * dùng thấy, chứ không được làm reconciler ném rồi bỏ qua trong im lặng.
 *
 * Giới hạn có chủ đích, đúng thiết kế: canary FLAG_LEVEL là HAI nhánh (§2.2
 * `[{on:p},{off:100000−p}]`, §16 "canary luôn là hai nhánh"); ATTRIBUTE_SPLIT
 * và BLUE_GREEN của FLAG_LEVEL không có đường auto (§7.2) và endpoint đổi
 * default variant chưa có, nên hôm nay S3 HOLD chúng với lý do rõ.
 */

export interface Weight {
  variantId: string;
  weight: number;
}

export interface FlagTarget {
  kind: "ready";
  flagKey: string;
  ruleId: string;
  targetVariant: { id: string; key: string };
  currentWeights: Weight[];
  /** Phần trăm hiện tại của variant mục tiêu theo trọng số THẬT của rule — so với DB để thấy rule bị sửa ngoài luồng */
  currentPercent: number;
  canary: MetricTarget;
  baseline: MetricTarget;
}

export interface HoldTarget {
  kind: "hold";
  reason: string;
}

type Db = DbClient;

interface TargetRow {
  flagKey: string;
  namespace: string;
  serve: unknown;
}

interface VariantRow {
  id: string;
  key: string;
}

export async function loadFlagTarget(
  db: Db,
  session: SessionRow,
): Promise<FlagTarget | HoldTarget> {
  if (session.rolloutScope !== "FLAG_LEVEL") {
    return hold("SERVICE_LEVEL chưa được Service 3 hỗ trợ ở lát cắt này");
  }
  if (session.controlMode !== "UDP_DRIVEN") {
    return hold("FLAG_LEVEL chỉ có chế độ UDP_DRIVEN");
  }
  if (session.targetingRuleId === null || session.targetVariantId === null) {
    return hold("session thiếu targeting_rule_id hoặc target_variant_id");
  }
  if (session.workloadName === null) {
    return hold(
      "session thiếu workload_name — mọi truy vấn §7.4 lọc service_name, không đo được",
    );
  }

  const rows = await db.$queryRaw<TargetRow[]>`
    SELECT f.key AS "flagKey", e.k8s_namespace AS "namespace", r.serve AS "serve"
      FROM flag_targeting_rules r
      JOIN flag_env_configs c ON c.id = r.flag_env_config_id
      JOIN feature_flags f ON f.id = c.flag_id
      JOIN environments e ON e.id = c.environment_id
     WHERE r.id = ${session.targetingRuleId}::uuid
       AND c.environment_id = ${session.environmentId}::uuid
       AND (${session.flagEnvConfigId}::uuid IS NULL OR c.id = ${session.flagEnvConfigId}::uuid)`;
  const row = rows[0];
  if (row === undefined) {
    return hold("rule của session không còn tồn tại trong environment này");
  }

  const parsed = flagServeDbSchema.safeParse(row.serve);
  if (!parsed.success) {
    return hold(
      `rule.serve không hợp lệ: ${parsed.error.message.slice(0, 200)}`,
    );
  }
  const serve = parsed.data;
  if (serve.kind !== "distribution") {
    return hold(
      "rule phục vụ thẳng một variant — chỉ ramp được rule phân phối",
    );
  }
  if (serve.weights.length !== 2) {
    return hold(
      `rule có ${String(serve.weights.length)} variant — canary FLAG_LEVEL chỉ hỗ trợ hai nhánh (§16)`,
    );
  }
  const targetWeight = serve.weights.find(
    (w) => w.variantId === session.targetVariantId,
  );
  const otherWeight = serve.weights.find(
    (w) => w.variantId !== session.targetVariantId,
  );
  if (targetWeight === undefined || otherWeight === undefined) {
    return hold("target_variant_id không nằm trong phân phối của rule");
  }

  const variants = await db.$queryRaw<VariantRow[]>`
    SELECT id::text AS "id", key AS "key"
      FROM flag_variants
     WHERE id IN (${targetWeight.variantId}::uuid, ${otherWeight.variantId}::uuid)`;
  const target = variants.find((v) => v.id === targetWeight.variantId);
  const baseline = variants.find((v) => v.id === otherWeight.variantId);
  if (target === undefined || baseline === undefined) {
    return hold("variant của rule không còn tồn tại");
  }

  const base = { namespace: row.namespace, workloadName: session.workloadName };
  return {
    kind: "ready",
    flagKey: row.flagKey,
    ruleId: session.targetingRuleId,
    targetVariant: target,
    currentWeights: serve.weights.map((w) => ({
      variantId: w.variantId,
      weight: w.weight,
    })),
    currentPercent: targetWeight.weight / 1000,
    canary: { ...base, flagKey: row.flagKey, variantKey: target.key },
    baseline: { ...base, flagKey: row.flagKey, variantKey: baseline.key },
  };
}

function hold(reason: string): HoldTarget {
  return { kind: "hold", reason };
}
