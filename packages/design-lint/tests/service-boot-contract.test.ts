import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * §1.2 nói một câu quy phạm cho MỌI service, không riêng service nào:
 *
 *   "Mỗi service nối bằng chuỗi kết nối riêng mang role của chính nó
 *    (`DATABASE_URL_S1`…), và khẳng định `current_user` lúc khởi động
 *    rồi mới mở cổng."
 *
 * Hôm nay chỉ `core-backend` có mã, và hành vi của nó đã được canh bằng một
 * test dựng thật tiến trình (`services/core-backend/tests/boot-identity.test.ts`).
 * Nhưng `flag-service` và `pd-controller` còn rỗng, và ngày chúng có mã thì
 * không có gì nhắc người viết rằng câu trên áp cho chúng nữa — trừ khi câu đó
 * được máy kiểm. Đó là việc của file này.
 *
 * Phân công rõ ràng giữa hai lớp canh:
 *   - Test dựng tiến trình đo HÀNH VI, sâu, nhưng mỗi service phải viết một cái.
 *   - Lint này đo DIỆN, nông, nhưng tự động phủ mọi service kể cả chưa tồn tại.
 *
 * Ba giới hạn đã biết, ghi ra để không ai tưởng lint này mạnh hơn thực tế. Hai
 * cái đầu đã được ĐO chứ không phải suy đoán: dựng lại đúng hai kiểu thoái cấp
 * rồi xem lưới nào bắt.
 *
 * 1. **Xoá lời gọi chốt ở entrypoint thì lint vẫn XANH.** Đã đo: bỏ hẳn khối
 *    `try` trong `index.ts`, `assertConnectedAs` vẫn còn trong `core/db.ts` nên
 *    luật "phải khẳng định danh tính" vẫn thoả, còn luật thứ tự thì bỏ qua vì
 *    file không còn lời gọi nào để xếp. Chỉ test dựng tiến trình bắt được.
 *    Ngược lại, khi dời chốt xuống sau `listen()` thì cả hai lưới cùng đỏ.
 * 2. **Chữ trong chú thích cũng tính.** Xoá lời gọi mà để lại chú thích nhắc
 *    tên hàm là qua được — bệnh chung của mọi lint đọc văn bản.
 * 3. Lint chỉ thấy service dựng client qua `createPrismaClient`; ai tự mở kết
 *    nối bằng `pg` thô sẽ lọt. Chấp nhận được vì `@udp/db` là đường đi chuẩn.
 *
 * Nói cách khác: lint này canh DIỆN, không canh SÂU. Nó tồn tại để service thứ
 * hai và thứ ba không ra đời mà quên mất §1.2, chứ không phải để thay thế test
 * hành vi của từng service.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../..");
const SERVICES = join(ROOT, "services");

/** Gọi hàm khẳng định danh tính — nhận cả tên gốc lẫn tên bọc của từng service */
const ASSERTS_IDENTITY = /\bassert(?:ConnectedAs|ServiceIdentity)\s*\(/;
const BUILDS_CLIENT = /\bcreatePrismaClient\s*\(/;
const OPENS_PORT = /\.listen\s*\(/;

interface SourceFile {
  /** đường dẫn tương đối từ gốc kho, để thông báo lỗi đọc được */
  rel: string;
  text: string;
}

interface Service {
  name: string;
  files: SourceFile[];
}

/** Mọi file .ts dưới `<service>/src`, bỏ mã sinh tự động và thư mục build */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function readServices(): Service[] {
  const out: Service[] = [];
  for (const name of readdirSync(SERVICES)) {
    const src = join(SERVICES, name, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue; // service mới đặt chỗ, chưa có src
    }
    out.push({
      name,
      files: sourceFiles(src).map((path) => ({
        rel: path.replace(ROOT, "").replace(/\\/g, "/"),
        text: readFileSync(path, "utf8"),
      })),
    });
  }
  return out;
}

const services = readServices();

describe("hợp đồng khởi động của service (§1.2)", () => {
  it("có đọc được thư mục services — nếu không, hai test dưới sẽ rỗng", () => {
    expect(services.map((s) => s.name)).toContain("core-backend");
  });

  it("service nào dựng Prisma client thì phải khẳng định danh tính kết nối", () => {
    const offenders = services
      .filter((s) => s.files.some((f) => BUILDS_CLIENT.test(f.text)))
      .filter((s) => !s.files.some((f) => ASSERTS_IDENTITY.test(f.text)))
      .map(
        (s) =>
          `${s.name}: dựng Prisma client nhưng không gọi assertConnectedAs — ` +
          `GRANT theo cột của §1.2 sẽ vô hiệu nếu chuỗi kết nối rơi về owner`,
      );

    expect(offenders).toEqual([]);
  });

  it("khẳng định danh tính đứng TRƯỚC lời gọi mở cổng", () => {
    /**
     * Chỉ xét file chứa cả hai. Nếu chốt được dời sang file khác mà cổng vẫn mở
     * ở đây, lint này im lặng — có chủ đích: nó không đủ thông tin để phán, và
     * một lint hay báo động giả sẽ bị người ta tắt. Trường hợp đó thuộc về test
     * hành vi, nơi thứ tự được đo chứ không được suy từ vị trí chữ.
     */
    const offenders: string[] = [];

    for (const service of services) {
      for (const file of service.files) {
        const assertAt = file.text.search(ASSERTS_IDENTITY);
        const listenAt = file.text.search(OPENS_PORT);
        if (assertAt === -1 || listenAt === -1) continue;
        if (assertAt > listenAt) {
          offenders.push(
            `${file.rel}: mở cổng ở ký tự ${String(listenAt)} trước khi khẳng định ` +
              `danh tính ở ${String(assertAt)} — cổng kịp phục vụ bằng role sai`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
