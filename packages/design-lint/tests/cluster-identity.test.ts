import { IDENTITY_SERVICE_ACCOUNTS } from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { readDesignDoc } from "../src/design-doc.js";

/**
 * [v4.10] AC-18 — hằng số `identity → ServiceAccount` đối chiếu bảng §12.2.
 *
 * Vì sao chốt này cần thiết: `IDENTITY_SERVICE_ACCOUNTS` là bản chép thứ hai của bảng
 * §12.2, và nó là bản chép mà **mã chạy thật** dùng để xin token. Nếu hai bản trôi khỏi
 * nhau, hệ thống xin token của một ServiceAccount không tồn tại (lỗi rõ ràng, dễ), hoặc —
 * tệ hơn nhiều — xin token của một SA **khác** đang tồn tại, và lúc đó bất biến I25 ("ba
 * bên ghi vào cluster nhưng không bao giờ chồng quyền") vỡ trong im lặng: `udp-traffic`
 * chạy bằng quyền của `udp-workload` thì API server không từ chối gì cả.
 *
 * `design-lint` là package DUY NHẤT thấy được cả tài liệu và mã, nên chốt nằm ở đây.
 */

/**
 * Hàng của bảng trong §12.2, và CHỈ trong §12.2.
 *
 * Quét cả tài liệu bằng một regex `^\| `udp-...`` là quét sai: §7 có một bảng khác mà ô
 * đầu là `` `udp-driven` `` (chế độ điều khiển rollout, không liên quan gì tới
 * ServiceAccount), và phép kiểm sẽ đỏ với một danh sách bốn phần tử — đúng, nhưng vì một
 * lý do không liên quan tới điều nó đang kiểm. Nên phải chặn phạm vi theo tiêu đề mục.
 */
function serviceAccountsInDesign(): string[] {
  const lines = readDesignDoc();
  const start = lines.findIndex((l) => l.startsWith("### 12.2"));
  if (start < 0) throw new Error("không tìm thấy mục §12.2 trong tài liệu");
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    /** Dừng ở tiêu đề mục kế tiếp cùng cấp hoặc cao hơn */
    if (/^#{1,3} /.test(line)) break;
    const m = /^\|\s*`(udp-[a-z]+)`\s*\|/.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

describe("identity → ServiceAccount đối chiếu §12.2", () => {
  it("bảng §12.2 khai đúng ba ServiceAccount", () => {
    /**
     * Số CHÍNH XÁC, không phải `toContain`.
     *
     * §12.2 nói "ba SA chứ không phải một là điều kiện để **API server** cưỡng chế bất
     * biến I25". Thêm một SA thứ tư mà không ai đối chiếu nghĩa là có một bên chạm vào
     * cluster bằng quyền không ai soát; bớt một SA nghĩa là hai bên dùng chung một token.
     */
    expect(serviceAccountsInDesign()).toEqual([
      "udp-workload",
      "udp-traffic",
      "udp-tooling",
    ]);
  });

  it("hằng số trong mã trỏ đúng ba SA đó, trong namespace udp-system", () => {
    const fromDesign = serviceAccountsInDesign();
    expect(Object.keys(IDENTITY_SERVICE_ACCOUNTS)).toEqual([
      "workload",
      "traffic",
      "tooling",
    ]);
    expect(Object.values(IDENTITY_SERVICE_ACCOUNTS)).toEqual(
      fromDesign.map((sa) => `udp-system/${sa}`),
    );
  });

  /**
   * THỨ TỰ cũng phải khớp, và đó không phải sự kỹ tính.
   *
   * Ba khoá của hằng số là `workload | traffic | tooling`, và ba hàng của bảng cũng theo
   * thứ tự đó. Nếu chỉ so theo tập, một lần đổi chỗ hai giá trị — `traffic` trỏ tới
   * `udp-tooling` và ngược lại — vẫn xanh, trong khi đó chính là hình dạng của lỗi vỡ
   * I25: mỗi bên vẫn có một token, chỉ là không phải token của mình.
   */
  it("không có cặp nào bị đổi chỗ", () => {
    expect(IDENTITY_SERVICE_ACCOUNTS.workload).toBe("udp-system/udp-workload");
    expect(IDENTITY_SERVICE_ACCOUNTS.traffic).toBe("udp-system/udp-traffic");
    expect(IDENTITY_SERVICE_ACCOUNTS.tooling).toBe("udp-system/udp-tooling");
  });
});
