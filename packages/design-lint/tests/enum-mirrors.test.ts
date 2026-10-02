import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Những danh sách PHẢI có bản thứ hai — và chốt giữ hai bản không trôi khỏi nhau.
 *
 * `@udp/shared-types` không được import `@udp/db` (đó là chỗ duy nhất tạo được
 * vòng `db → shared-types → db`), nên mọi enum mà cả SDK lẫn database cùng cần
 * đều phải có một bản chép trong shared-types. Chép thì trôi — đúng hình dạng
 * của lỗi v3 ở §7.1, khi hai tập status khác nhau làm session PAUSED không bao
 * giờ được claim. `design-lint` là package DUY NHẤT thấy được cả hai bên, nên
 * chốt nằm ở đây.
 */
describe("enum của Prisma và bản chép trong shared-types", () => {
  it("RULE_TYPES trùng đúng enum RuleType", async () => {
    const { RuleType } = await import("@udp/db");
    const { RULE_TYPES } = await import("@udp/shared-types");

    expect(new Set(RULE_TYPES)).toEqual(new Set(Object.values(RuleType)));
  });

  it("FLAG_TYPES trùng đúng enum FlagType", async () => {
    /**
     * Một kiểu flag có trong database mà không có ở đây thì `createFlagSchema`
     * không có validator cho nó; ngược lại thì Portal cho chọn một kiểu mà
     * database từ chối.
     */
    const { FlagType } = await import("@udp/db");
    const { FLAG_TYPES } = await import("@udp/shared-types");

    expect(new Set(FLAG_TYPES)).toEqual(new Set(Object.values(FlagType)));
  });
});

/**
 * [v4.10] Ba danh sách của `@udp/adapter-core` đối chiếu enum của database.
 *
 * `@udp/adapter-core` KHÔNG được phụ thuộc `@udp/db` (ma trận writer §1.2, và có một
 * phép kiểm biên riêng cho điều đó), nên ba danh sách này là bản chép thứ hai — cùng
 * hình dạng rủi ro như shared-types, và cùng cần một chốt.
 *
 * `CloudProvider` là ca đặc biệt và là ca đã sai một lần: hai bên KHÁC chữ (`"aws"` so
 * với `AWS`), và chú thích trong `credential.ts` từng khẳng định chúng "trùng". Chúng
 * không trùng, nhưng chúng phải trùng SAU KHI gập hoa thường — nếu không thì codec
 * `providerToDb` của Service 1 thiếu một nhánh, và hàng sổ mang một nhà cung cấp sai.
 */
describe("enum của Prisma và bản chép trong adapter-core", () => {
  it("CLOUD_PROVIDERS trùng enum CloudProvider sau khi gập hoa thường", async () => {
    const { CloudProvider } = await import("@udp/db");
    const { CLOUD_PROVIDERS } = await import("@udp/adapter-core");

    expect(new Set(CLOUD_PROVIDERS.map((p) => p.toUpperCase()))).toEqual(
      new Set(Object.values(CloudProvider)),
    );
  });

  /**
   * Hai enum dưới đây trùng chữ, và chính vì thế chúng nguy hiểm hơn: `PrismaLedger` đọc
   * `row.status` từ Prisma rồi dùng nó như `ResourceStatus` không qua hàm dịch nào. Điều
   * đó đúng, nhưng chỉ đúng khi hai tập còn khớp từng giá trị — và không có phép kiểm thì
   * ngày chúng lệch, sổ trả về một trạng thái mà máy trạng thái §4.5 không có, im lặng.
   */
  it("RESOURCE_STATUSES trùng đúng enum ResourceStatus", async () => {
    const { ResourceStatus } = await import("@udp/db");
    const { RESOURCE_STATUSES } = await import("@udp/adapter-core");

    expect(new Set(RESOURCE_STATUSES)).toEqual(
      new Set(Object.values(ResourceStatus)),
    );
  });

  it("PROVISION_STEPS trùng đúng enum ProvisionStep", async () => {
    const { ProvisionStep } = await import("@udp/db");
    const { PROVISION_STEPS } = await import("@udp/adapter-core");

    expect(new Set(PROVISION_STEPS)).toEqual(
      new Set(Object.values(ProvisionStep)),
    );
  });
});

/**
 * [v4.11, Plan #55] Vai của nhóm và vai cấp được cho nhóm/lời mời trên dây — bản chép của enum database. Một vai
 * mới trong database mà dây không biết thì response đầu tiên mang nó làm `.strict()` đỏ ở Portal; một vai thừa trên
 * dây thì Portal cho chọn thứ database từ chối.
 */
describe("enum của Prisma và bản chép trên dây", () => {
  it("teamRoleWire trùng đúng enum TeamRole", async () => {
    const { TeamRole } = await import("@udp/db");
    const { teamRoleWire } = await import("@udp/shared-types/wire");

    expect(new Set(teamRoleWire.options)).toEqual(
      new Set(Object.values(TeamRole)),
    );
  });

  it("grantableProjectRoleWire là ProjectRole trừ OWNER", async () => {
    const { ProjectRole } = await import("@udp/db");
    const { grantableProjectRoleWire } = await import("@udp/shared-types/wire");

    expect(new Set(grantableProjectRoleWire.options)).toEqual(
      new Set(Object.values(ProjectRole).filter((r) => r !== "OWNER")),
    );
  });
});

/**
 * [v4.12, Plan #61 61d-2b-1] Lý do "Trusted Deploy chưa khả dụng" có BA bản chép, và không gì giữ chúng.
 *
 * Bản một: union `TrustedDeployUnavailable` trong `cicd/trusted-deploy.ts` (thứ mã backend dùng để quyết).
 * Bản hai: zod enum của `cicdStatusResponseWire` trong `wire.ts` (cổng của dây — một giá trị thiếu ở đây là
 * một response hợp lệ bị Portal từ chối ở tầng parse).
 * Bản ba: các nhánh `if` trong `CicdPanel.tsx` (câu người dùng đọc).
 *
 * Hình dạng của lỗi nếu trôi: backend thêm một lý do, dây từ chối nó ⇒ mục CI/CD của Portal **trắng** với
 * một lỗi parse, không phải một câu giải thích. Đợt 61d-2b-1 đổi đúng enum này (`IN_CLUSTER_CI` chết,
 * `CLUSTER_NOT_READY` ra đời), nên đây là lúc rẻ nhất để đóng chốt.
 */
describe("lý do Trusted Deploy chưa khả dụng: mã, dây, và Portal", () => {
  const ROOT = resolve(import.meta.dirname, "../../..");
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

  /** Các giá trị của union `TrustedDeployUnavailable` trong mã backend */
  function inCode(): string[] {
    const src = read(
      "services/core-backend/src/modules/cicd/trusted-deploy.ts",
    );
    const start = src.indexOf("export type TrustedDeployUnavailable =");
    expect(start, "không thấy TrustedDeployUnavailable").toBeGreaterThan(-1);
    const decl = src.slice(start, src.indexOf(";", start));
    return [...decl.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] ?? "").sort();
  }

  it("zod enum của dây khai ĐÚNG tập lý do của mã", () => {
    const src = read("packages/shared-types/src/wire.ts");
    const start = src.indexOf("unavailableReason: z");
    expect(start, "không thấy unavailableReason trong wire").toBeGreaterThan(
      -1,
    );
    const decl = src.slice(start, src.indexOf(".nullable()", start));
    const onWire = [...decl.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] ?? "");
    expect(onWire.sort()).toEqual(inCode());
  });

  it("Portal có một câu cho MỌI lý do, và không nhánh chết nào", () => {
    const panel = read("apps/portal/src/features/domain/CicdPanel.tsx");
    const handled = [
      ...panel.matchAll(/unavailableReason === "([A-Z_]+)"/g),
    ].map((m) => m[1] ?? "");
    /**
     * `NO_PROVIDER` cố ý KHÔNG có nhánh riêng: nó rơi vào câu mặc định ("chờ token hợp lệ đầu tiên"), vì
     * project chưa bật CI thì mục này còn chưa hiện. Mọi lý do CÒN LẠI phải có câu của nó.
     */
    expect(handled.sort()).toEqual(
      inCode().filter((code) => code !== "NO_PROVIDER"),
    );
  });
});
