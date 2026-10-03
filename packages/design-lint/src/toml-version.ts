/**
 * [Plan #62 62b-3] Đọc `[project].version` của một `pyproject.toml` — FAIL-CLOSED.
 *
 * Repo không có thư viện TOML nào (`grep -ic toml pnpm-lock.yaml` → 0) và Node cũng không, nên cổng lockstep phải
 * tự đọc. Ba mẫu regex "hồn nhiên" đều fail-open, đo trên 8 đầu vào thật:
 *
 *   - `/version\s*=\s*"([^"]+)"/` đọc ra `"py311"` khi `[tool.ruff]` được dời lên TRƯỚC `[project]`, vì
 *     `target-version` chứa chuỗi con `version`;
 *   - `/^version\s*=\s*"([^"]+)"/m` bị một dòng `# version = "9.9.9"` đánh lừa;
 *   - `/\[project\][\s\S]*?version\s*=\s*"([^"]+)"/` lấy giá trị của `[tool.poetry]`.
 *
 * Bộ đọc này đi THEO BẢNG, bỏ dòng comment, và **khẳng định lực lượng bằng 1**: 0 hay ≥2 khoá `version` trong
 * `[project]` đều NÉM, không trả về một giá trị.
 *
 * **Vì sao nó không gặp lỗi "chỉ thấy 42 trong 71" của `chartPinsOf`** (Plan #61): lỗi đó là một phép ĐẾM THIẾU
 * im lặng trên một tập hợp có lực lượng không biết trước — mẫu bỏ qua 29 chart mà `Map.size` vẫn là một số dương
 * trông hợp lý. Ở đây lực lượng **bằng 1 theo thiết kế**, và hàm khẳng định đúng lực lượng đó, nên mọi chế độ bỏ
 * sót (0) và mọi chế độ nhập nhằng (≥2) đều thành ngoại lệ chứ không thành một chuỗi.
 *
 * Chỉ nhận chuỗi nháy KÉP một dòng: TOML cho phép nháy đơn và chuỗi nhiều dòng, nhưng `pyproject.toml` của repo
 * này dùng nháy kép, và một dạng lạ phải là ĐỎ chứ không phải một phép đoán.
 */
export function projectVersionOf(source: string): string {
  return projectKeyOf(source, "version", /^\d+\.\d+\.\d+$/, "x.y.z");
}

/**
 * [Plan #62 62d-11] `[project].name` — đầu thứ tư của bất biến tên công khai. Không có ô này thì câu "một tên,
 * hai registry" là một khẩu hiệu: không gì buộc tên npm bằng tên PyPI, và hai registry không liên thông.
 */
export function projectNameOf(source: string): string {
  return projectKeyOf(source, "name", /^[a-z][a-z0-9-]*$/, "tên không scope");
}

function projectKeyOf(
  source: string,
  key: string,
  shape: RegExp,
  shapeName: string,
): string {
  let table: string | null = null;
  const hits: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, "");
    if (/^\s*#/.test(line)) continue;
    const header = /^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header !== null) {
      table = header[1] ?? null;
      continue;
    }
    /**
     * Mẫu TĨNH rồi so khoá, chứ không dựng regex từ `key`: một regex động phải qua thêm một tầng thoát ký tự, và
     * một `\s` hụt một gạch chéo cho ra một mẫu **vẫn chạy** mà khớp sai — đúng loại hỏng im lặng mà cả hàm này
     * tồn tại để chống.
     */
    const kv = /^\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*=\s*(.*)$/.exec(
      line,
    );
    const found = kv?.[1] ?? kv?.[2] ?? kv?.[3];
    if (kv === null || found !== key || table !== "project") continue;
    const value = /^"([^"]*)"\s*(#.*)?$/.exec((kv[4] ?? "").trim());
    if (value === null) {
      throw new Error(
        `[project].${key} không phải chuỗi nháy kép một dòng: ${kv[4] ?? ""}`,
      );
    }
    hits.push(value[1] ?? "");
  }
  if (hits.length !== 1) {
    throw new Error(
      `đợi ĐÚNG một [project].${key}, thấy ${String(hits.length)}`,
    );
  }
  const value = hits[0] ?? "";
  if (!shape.test(value)) {
    throw new Error(`[project].${key} không phải ${shapeName}: ${value}`);
  }
  return value;
}

/**
 * Khoảng mà Golden Path phải ghim cho một version — TÍNH RA, không phải "khoảng nào chứa version cũng được".
 *
 * `^0.1.0` và `>=0.1,<1` **không tương đương**: với version `0.2.0` thì `>=0.1,<1` vẫn chứa (xanh) còn `^0.1.0`
 * thì không (đỏ). Một phép kiểm "khoảng có chứa version" cho phép một khoảng rộng tuỳ ý, nên nó không bảo vệ được
 * tính chất mà AC-6 muốn: hai template ghim đúng dải của version đang phát hành.
 */
export function goldenPathPins(version: string): {
  providerRelease: string;
  requirement: string;
} {
  const [major, minor] = version.split(".");
  if (major === undefined || minor === undefined) {
    throw new Error(`version không phải x.y.z: ${version}`);
  }
  return {
    providerRelease: `^${major}.${minor}.0`,
    requirement: `udp-openfeature[metrics]>=${major}.${minor},<${String(Number(major) + 1)}`,
  };
}
