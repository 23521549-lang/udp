import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DOMAIN_ADAPTER_METHODS,
  DOMAIN_ADAPTER_PROPERTIES,
} from "@udp/adapter-core";
import type { DomainAdapter } from "@udp/adapter-core";

/**
 * [v4.10] Registry TỰ KHÁM PHÁ adapter theo hai tầng thư mục (§1.6).
 *
 * Cây thật là `modules/<domainType>-adapter/<toolId>/index.ts`, nên registry đọc hai tầng
 * rồi `import()` từng `index.js`. Ba chi tiết phải đúng, và cả ba đã được đo ở R24-7:
 *
 *  1. **`pathToFileURL(...).href`**, không phải đường dẫn thô. Trên Windows,
 *     `import("D:\\...")` không phải một URL hợp lệ và Node từ chối; `file:///D:/...` thì
 *     chạy. Không có bước này, registry chạy ở CI Linux và vỡ trên máy phát triển.
 *  2. **Ghi tên `index.js` ngay trong nguồn.** `tsx` tự ánh xạ sang `.ts` khi chạy nguồn,
 *     còn `tsc` giữ nguyên lời gọi `import()` động — đã đo: cùng một kết quả dưới `tsx`
 *     và sau `tsc`. Viết `index.ts` thì bản build vỡ.
 *  3. **Gốc là THAM SỐ**, không phải `import.meta.dirname` cố định. Nhờ vậy test trỏ vào
 *     một cây fixture, và không phép kiểm nào phải phụ thuộc vào việc adapter thật đã
 *     tồn tại hay chưa.
 *
 * **Fail-fast, và đó là lựa chọn có chủ đích.** Một adapter khai thiếu phương thức làm
 * registry NÉM lúc nạp, không phải bỏ qua nó. Bỏ qua nghĩa là hệ thống khởi động xanh với
 * ít adapter hơn người vận hành nghĩ, và điều đó chỉ lộ ra khi ai đó bật domain tương
 * ứng rồi nhận "không có tool nào".
 */

export class InvalidAdapterError extends Error {
  readonly code = "ADAPTER_INVALID";
  constructor(
    readonly at: string,
    readonly problem: string,
  ) {
    super(`adapter ở ${at} không dùng được: ${problem}`);
    this.name = "InvalidAdapterError";
  }
}

export interface RegistryOptions {
  /** Gốc của cây adapter, ví dụ `<...>/src/modules` */
  root: string;
  /**
   * Hậu tố của thư mục tầng một. `"-adapter"` theo cây thật của §1.6.
   *
   * Là tham số vì cây fixture của test không nên bắt buộc theo đúng quy ước đặt tên của
   * mã sản phẩm — nếu bắt buộc, một lần đổi quy ước sẽ làm test đỏ vì lý do không liên
   * quan tới điều nó kiểm.
   */
  suffix?: string;
}

/** `"<domainType>:<toolId>"` viết thường — cùng quy ước với `provided_by` (§2.2) */
export const registryKey = (a: DomainAdapter): string =>
  `${a.domainType.toLowerCase()}:${a.toolId.toLowerCase()}`;

/**
 * Type guard **7 + 6**: bảy phương thức và sáu thuộc tính của `DomainAdapter`.
 *
 * Hai danh sách là DỮ LIỆU ở `@udp/adapter-core`, không viết lại ở đây. Viết lại là tạo
 * bản khai thứ hai: thêm một phương thức vào interface mà quên thêm vào guard nghĩa là
 * một adapter thiếu phương thức đó vẫn nạp được, rồi vỡ lúc chạy ở một chỗ xa.
 *
 * Kiểm cả kiểu của từng thuộc tính chứ không chỉ sự tồn tại: `capabilities` là object,
 * `domainType`/`toolId`/`version` là chuỗi. Một adapter khai `toolId: 42` sẽ đi qua một
 * guard chỉ `in` được, rồi sinh một khoá `"monitoring:42"` không khớp gì trong catalog.
 */
export function assertIsDomainAdapter(
  value: unknown,
  at: string,
): asserts value is DomainAdapter {
  if (typeof value !== "object" || value === null) {
    throw new InvalidAdapterError(at, "export mặc định không phải object");
  }
  const obj = value as Record<string, unknown>;

  for (const m of DOMAIN_ADAPTER_METHODS) {
    if (typeof obj[m] !== "function") {
      throw new InvalidAdapterError(at, `thiếu phương thức ${m}`);
    }
  }
  for (const p of DOMAIN_ADAPTER_PROPERTIES) {
    if (!(p in obj)) throw new InvalidAdapterError(at, `thiếu thuộc tính ${p}`);
  }
  for (const p of ["domainType", "toolId", "version", "scope"]) {
    if (typeof obj[p] !== "string") {
      throw new InvalidAdapterError(at, `${p} phải là chuỗi`);
    }
  }
  if (typeof obj["capabilities"] !== "object" || obj["capabilities"] === null) {
    throw new InvalidAdapterError(at, "capabilities phải là object");
  }
}

function subdirs(dir: string): string[] {
  return readdirSync(dir).filter((e) => {
    try {
      return statSync(join(dir, e)).isDirectory();
    } catch {
      return false;
    }
  });
}

export interface LoadedAdapter {
  key: string;
  adapter: DomainAdapter;
  /** Đường dẫn đã nạp — để thông điệp lỗi nói được adapter nào ở đâu */
  at: string;
}

/**
 * Nạp mọi adapter dưới `root`, theo hai tầng.
 *
 * Thư mục tầng một phải kết thúc bằng `suffix`; mọi thư mục khác bị bỏ qua **im lặng**,
 * và đó là đúng: `modules/` còn chứa `capability/`, `credential/`, `provisioning/`...
 * Nhưng một thư mục ĐÚNG hậu tố mà bên trong không nạp được thì NÉM — im lặng ở đó là
 * cách một adapter biến mất khỏi hệ thống mà không ai biết.
 */
export async function loadAdapters(
  options: RegistryOptions,
): Promise<LoadedAdapter[]> {
  const suffix = options.suffix ?? "-adapter";
  const out: LoadedAdapter[] = [];

  let tier1: string[];
  try {
    tier1 = subdirs(options.root);
  } catch (err) {
    throw new InvalidAdapterError(
      options.root,
      `không đọc được gốc registry: ${err instanceof Error ? err.name : "lỗi lạ"}`,
    );
  }

  for (const domainDir of tier1.filter((d) => d.endsWith(suffix)).sort()) {
    const domainPath = join(options.root, domainDir);
    for (const toolDir of subdirs(domainPath).sort()) {
      const at = join(domainPath, toolDir);
      /** `index.js` trong NGUỒN — xem chi tiết 2 ở chú thích đầu tệp */
      const url = pathToFileURL(join(at, "index.js")).href;

      let mod: unknown;
      try {
        mod = await import(url);
      } catch (err) {
        throw new InvalidAdapterError(
          at,
          `không import được: ${err instanceof Error ? err.message : "lỗi lạ"}`,
        );
      }

      const candidate = (mod as { default?: unknown }).default;
      if (candidate === undefined) {
        throw new InvalidAdapterError(at, "không có export mặc định");
      }
      assertIsDomainAdapter(candidate, at);

      const key = registryKey(candidate);
      if (out.some((x) => x.key === key)) {
        throw new InvalidAdapterError(at, `khoá trùng: ${key}`);
      }
      out.push({ key, adapter: candidate, at });
    }
  }
  return out;
}

/** Registry đã nạp, tra theo `(domainType, toolId)` */
export interface DomainAdapterRegistry {
  get(domainType: string, toolId: string): DomainAdapter | undefined;
  all(): readonly LoadedAdapter[];
}

export async function createRegistry(
  options: RegistryOptions,
): Promise<DomainAdapterRegistry> {
  const loaded = await loadAdapters(options);
  const byKey = new Map(loaded.map((l) => [l.key, l.adapter]));
  return {
    get: (domainType, toolId) =>
      byKey.get(`${domainType.toLowerCase()}:${toolId.toLowerCase()}`),
    all: () => loaded,
  };
}
