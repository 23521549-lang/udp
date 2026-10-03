import type {
  CreatedResource,
  CreatedResourceKind,
  LookupOutcome,
  ResourceStep,
} from "../../src/cloud.js";
import { SecretBuffer, type ResolvedCredential } from "../../src/credential.js";
import type { SimCloud } from "../../src/testing/sim-cloud.js";
import { KINDS_WITHOUT_CREATE_TAGS } from "../../src/testing/sim-cloud.js";

/**
 * [v4.10] Dựng `ResourceStep` trên cloud mô phỏng, dùng cho test của runner.
 *
 * Đây KHÔNG phải adapter sim của P7 (thứ sẽ đi qua bộ hợp đồng và bị `git log` chốt thứ
 * tự). Nó là helper tối giản để kiểm 14 bất biến của runner một cách cô lập: mỗi bất biến
 * cần một hình dạng step khác nhau, và một adapter đầy đủ sẽ làm phép kiểm phụ thuộc vào
 * quá nhiều thứ cùng lúc.
 */

export const PROJECT = "11111111-1111-4111-8111-111111111111";
export const OWNER = "chu@vi-du.test";

export function credential(): ResolvedCredential {
  const payload = new SecretBuffer("bi-mat-cua-khach");
  return {
    provider: "aws",
    mode: "BYOC",
    authKind: "AWS_ROLE",
    payload,
    expiresAt: new Date(Date.now() + 900_000),
    dispose: () => {
      payload.dispose();
    },
  };
}

export function tagsFor(name: string): Record<string, string> {
  return {
    "udp.project": PROJECT,
    "udp.key": keyOf(name),
    "udp.owner": OWNER,
    "udp.managed": "true",
  };
}

export const keyOf = (name: string): string => `${PROJECT}:NETWORK:vpc:${name}`;

export interface StepOptions {
  name: string;
  kind?: CreatedResourceKind;
  dependsOn?: string;
  /** Ép `lookup` trả một kết quả cố định, để kiểm nhánh riêng của runner */
  lookupOverride?: () => Promise<LookupOutcome>;
  /** Ép `create` ném, để kiểm compensation */
  createThrows?: () => never;
  /** Số lần `waitReady` phải gọi mới xong */
  waitReadyCalls?: number;
}

/**
 * Một step chạy trên `SimCloud`.
 *
 * `lookup` tra theo tag `udp.key` với `kind` gắn được tag; với `kind` không gắn được tag
 * lúc tạo thì tra theo TÊN tất định — đó là đường mà §4.5 quy tắc 2 nói tới, và nó chỉ
 * được kiểm nếu có một step thật đi qua nó.
 */
export function simStep(cloud: SimCloud, opts: StepOptions): ResourceStep {
  const kind = opts.kind ?? "vpc";
  const byName = KINDS_WITHOUT_CREATE_TAGS.includes(kind);
  let waitsLeft = opts.waitReadyCalls ?? 1;

  return {
    kind,
    name: opts.name,
    idempotencyKey: keyOf(opts.name),
    lookupBy: byName ? "deterministic-name" : "tag",

    lookup: async (): Promise<LookupOutcome> => {
      if (opts.lookupOverride !== undefined) return opts.lookupOverride();
      const found = byName
        ? cloud.findByName(kind, opts.name)
        : (cloud.findByTag("udp.key", keyOf(opts.name))[0] ?? null);
      return await Promise.resolve(
        found === null
          ? { kind: "absent" as const }
          : { kind: "found" as const, resource: found },
      );
    },

    lookupById: async (_cred, providerId): Promise<LookupOutcome> => {
      const r = cloud.describeById(providerId);
      return await Promise.resolve(
        r === null
          ? { kind: "absent" as const }
          : { kind: "found" as const, resource: r },
      );
    },

    create: async (_cred, prior): Promise<CreatedResource> => {
      if (opts.createThrows !== undefined) opts.createThrows();
      /**
       * Đọc `prior` vào một biến rồi mới dùng.
       *
       * `exactOptionalPropertyTypes: true` không cho truyền `string | undefined` vào một
       * trường khai `attachedTo?: string`, và trình biên dịch không thu hẹp kiểu qua hai
       * lần truy cập chỉ mục. Đây là ràng buộc của dự án, không phải một chi tiết vặt:
       * nó bắt đúng chỗ mà "có thể vắng" bị lẫn với "vắng là hợp lệ".
       */
      const parent =
        opts.dependsOn === undefined ? undefined : prior[opts.dependsOn];
      if (opts.dependsOn !== undefined && parent === undefined) {
        throw new Error(
          `step ${opts.name} cần prior["${opts.dependsOn}"] mà không có`,
        );
      }
      return await Promise.resolve(
        cloud.createResource({
          kind,
          name: opts.name,
          tags: tagsFor(opts.name),
          idempotencyKey: keyOf(opts.name),
          ...(parent === undefined ? {} : { attachedTo: parent.id }),
        }),
      );
    },

    waitReady: async (_cred, r): Promise<void> => {
      waitsLeft -= 1;
      cloud.pollReady(r.id);
      if (waitsLeft > 0) throw new Error("chưa READY");
      await Promise.resolve();
    },

    delete: async (_cred, r): Promise<void> => {
      cloud.deleteResource(r.id);
      await Promise.resolve();
    },
  };
}
