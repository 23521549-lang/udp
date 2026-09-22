import { randomUUID } from "node:crypto";
import { TOTAL_BUCKETS } from "@udp/config/constants";
import type { PrismaClient } from "@udp/db";
import { canonicalizeServe } from "@udp/shared-types";

/**
 * Một flag BOOLEAN sẵn sàng cho canary FLAG_LEVEL: variant `on`/`off`, env-config
 * đang BẬT ở environment cho sẵn, một rule phân phối với `on` ở `onPercent`.
 *
 * Dựng bằng client OWNER (bên gọi truyền vào): Service 1 và Service 3 đều chỉ có
 * SELECT trên bảng flag (§1.2), còn đường ghi thật qua Service 2 không phải thứ
 * test của hai service đó đang kiểm. Serve đi qua `canonicalizeServe` như mọi
 * writer thật — trigger UDP04 chặn thứ tự sai.
 */
export interface FlagTarget {
  flagId: string;
  flagKey: string;
  envConfigId: string;
  ruleId: string;
  /** id variant `on` — variant mục tiêu của canary */
  on: string;
  off: string;
}

export interface FlagTargetOptions {
  /** Mặc định true — flag tắt thì hook không gắn nhãn (§6.6) */
  isEnabled?: boolean;
  keyPrefix?: string;
}

export async function newFlagTarget(
  admin: PrismaClient,
  scope: { projectId: string; environmentId: string },
  onPercent: number,
  options: FlagTargetOptions = {},
): Promise<FlagTarget> {
  const key = `${options.keyPrefix ?? "t"}-${randomUUID().slice(0, 8)}`;
  const flag = await admin.featureFlag.create({
    data: {
      projectId: scope.projectId,
      key,
      flagType: "BOOLEAN",
      lifecycleStatus: "ACTIVE",
      variants: {
        create: [
          { key: "on", value: true },
          { key: "off", value: false },
        ],
      },
    },
    select: { id: true, variants: { select: { id: true, key: true } } },
  });
  const on = flag.variants.find((v) => v.key === "on")?.id;
  const off = flag.variants.find((v) => v.key === "off")?.id;
  if (on === undefined || off === undefined) {
    throw new Error("fixture thiếu variant");
  }
  await admin.featureFlag.update({
    where: { id: flag.id },
    data: { defaultVariantId: off },
  });
  const target = Math.round((onPercent * TOTAL_BUCKETS) / 100);
  const config = await admin.flagEnvConfig.create({
    data: {
      flagId: flag.id,
      environmentId: scope.environmentId,
      isEnabled: options.isEnabled ?? true,
      rules: {
        create: [
          {
            ruleType: "ALL",
            priority: 0,
            bucketSalt: randomUUID(),
            condition: {},
            serve: canonicalizeServe({
              kind: "distribution",
              weights: [
                { variantId: on, weight: target },
                { variantId: off, weight: TOTAL_BUCKETS - target },
              ],
            }),
          },
        ],
      },
    },
    select: { id: true, rules: { select: { id: true } } },
  });
  const ruleId = config.rules[0]?.id;
  if (ruleId === undefined) throw new Error("fixture thiếu rule");
  return {
    flagId: flag.id,
    flagKey: key,
    envConfigId: config.id,
    ruleId,
    on,
    off,
  };
}
