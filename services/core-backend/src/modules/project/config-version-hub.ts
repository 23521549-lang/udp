import { logger } from "@udp/http";

/**
 * Nguồn của `GET /projects/:id/stream` (Plan #41 QĐ-1, QĐ-2): `config_version` của mọi
 * environment, ĐỌC THEO LÔ — mỗi vòng MỘT câu truy vấn cho mọi project đang có luồng mở, rồi chia
 * cho từng luồng. Mọi lần ghi cấu hình (flag, rule, segment, tracked) đều tăng `config_version`
 * của environment nó chạm (ADR-05), nên con số này là tín hiệu "có gì đổi" đủ và duy nhất.
 *
 * Vì sao đọc chứ không LISTEN: Service 1 không có kết nối session riêng bằng `udp_s1` — thêm là
 * thêm một biến môi trường bắt buộc cho mọi triển khai — và độ trễ một vòng (`pollMs`, như SSE job
 * của D-P19) là đủ cho người đang nhìn Portal. Không luồng nào mở ⇒ không hẹn giờ, không truy vấn.
 *
 * Vòng đầu tiên của một project chỉ ghi mốc, không phát gì: luồng mới mở không có "trước" để so.
 */

export interface EnvironmentVersion {
  projectId: string;
  environmentId: string;
  configVersion: number;
}

export interface ConfigChange {
  environmentId: string;
  configVersion: number;
}

export interface ConfigVersionHub {
  /** Đăng ký nghe một project; trả hàm huỷ — luồng cuối của project huỷ thì mốc của nó bị bỏ */
  subscribe(
    projectId: string,
    listener: (change: ConfigChange) => void,
  ): () => void;
  /** Một vòng đọc — hẹn giờ gọi nó; test gọi thẳng */
  tick(): Promise<void>;
}

export const CONFIG_STREAM_TIMING = { pollMs: 1_000, heartbeatMs: 15_000 };

export function createConfigVersionHub(options: {
  read: (projectIds: readonly string[]) => Promise<EnvironmentVersion[]>;
  pollMs?: number;
}): ConfigVersionHub {
  const listeners = new Map<string, Set<(change: ConfigChange) => void>>();
  /** projectId → environmentId → version đã thấy */
  const seen = new Map<string, Map<string, number>>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;

  async function tick(): Promise<void> {
    // Vòng trước chưa xong (database chậm) ⇒ bỏ vòng này, không chồng truy vấn
    if (inFlight || listeners.size === 0) return;
    inFlight = true;
    try {
      const rows = await options.read([...listeners.keys()]);
      for (const row of rows) {
        let versions = seen.get(row.projectId);
        if (versions === undefined) {
          // Project vừa có luồng đầu: vòng này chỉ ghi mốc
          versions = new Map();
          seen.set(row.projectId, versions);
          versions.set(row.environmentId, row.configVersion);
          continue;
        }
        const before = versions.get(row.environmentId);
        versions.set(row.environmentId, row.configVersion);
        if (before !== undefined && row.configVersion > before) {
          const change = {
            environmentId: row.environmentId,
            configVersion: row.configVersion,
          };
          for (const listener of listeners.get(row.projectId) ?? []) {
            listener(change);
          }
        }
      }
    } catch (err: unknown) {
      logger.warn({ err }, "Không đọc được config_version cho luồng Portal");
    } finally {
      inFlight = false;
    }
  }

  return {
    subscribe(projectId, listener) {
      const set = listeners.get(projectId) ?? new Set();
      set.add(listener);
      listeners.set(projectId, set);
      if (timer === undefined) {
        timer = setInterval(() => {
          void tick();
        }, options.pollMs ?? CONFIG_STREAM_TIMING.pollMs);
        timer.unref();
      }
      return () => {
        set.delete(listener);
        if (set.size > 0) return;
        listeners.delete(projectId);
        seen.delete(projectId);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    tick,
  };
}
