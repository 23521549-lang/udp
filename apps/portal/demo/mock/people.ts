import { between, pick, type Rng } from "./random";

/**
 * Người dùng mẫu của nền tảng: nhóm thương mại điện tử có tên riêng ở `seed.ts`, cộng một đám đông các nhóm khác
 * (fintech, giáo dục, logistics, y tế…) sinh TẤT ĐỊNH từ họ, đệm, tên Việt — đủ để trang Người dùng có nhiều
 * trang, tìm kiếm có kết quả, và "mới trong 7 ngày" có số thật.
 */

const FAMILY = [
  "Nguyễn",
  "Trần",
  "Lê",
  "Phạm",
  "Hoàng",
  "Huỳnh",
  "Phan",
  "Vũ",
  "Võ",
  "Đặng",
  "Bùi",
  "Đỗ",
  "Hồ",
  "Ngô",
  "Dương",
  "Lý",
  "Trịnh",
  "Mai",
] as const;

const MIDDLE = [
  "Văn",
  "Thị",
  "Minh",
  "Quốc",
  "Thu",
  "Đức",
  "Ngọc",
  "Gia",
  "Thanh",
  "Hải",
  "Tuấn",
  "Bảo",
  "Hoài",
  "Phương",
  "Kim",
] as const;

const GIVEN = [
  "An",
  "Bình",
  "Châu",
  "Dũng",
  "Giang",
  "Hạnh",
  "Hiếu",
  "Hoa",
  "Hùng",
  "Khoa",
  "Long",
  "My",
  "Nam",
  "Nga",
  "Nhi",
  "Phong",
  "Phúc",
  "Quân",
  "Quyên",
  "Sơn",
  "Tâm",
  "Thảo",
  "Thịnh",
  "Trang",
  "Trí",
  "Tú",
  "Uyên",
  "Vy",
  "Xuân",
  "Duy",
] as const;

/** Tên miền của các nhóm dùng nền tảng — mỗi nhóm một công ty */
const TEAMS = [
  "shopnow.vn",
  "payfast.vn",
  "edulearn.vn",
  "logistix.vn",
  "medicare.vn",
  "udp.dev",
] as const;

export interface CrowdMember {
  name: string;
  email: string;
  joinedDaysAgo: number;
  admin: boolean;
}

/** "Đặng Gia Khánh" ⇒ "khanh.dang": bỏ dấu, đ thành d, tên trước họ */
export function emailLocalOf(name: string): string {
  const parts = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .split(/\s+/);
  return `${parts[parts.length - 1] ?? "user"}.${parts[0] ?? "udp"}`;
}

/**
 * `count` người khác nhau (không trùng email). Ngày tham gia trải từ hôm nay tới gần hai năm, dày hơn ở gần đây
 * — nền tảng đang được dùng thêm; một phần nhỏ là quản trị viên của nhóm vận hành.
 */
export function crowd(
  rng: Rng,
  count: number,
  taken: ReadonlySet<string>,
): CrowdMember[] {
  const out: CrowdMember[] = [];
  const emails = new Set(taken);
  while (out.length < count) {
    const name = `${pick(rng, FAMILY)} ${pick(rng, MIDDLE)} ${pick(rng, GIVEN)}`;
    const team = pick(rng, TEAMS);
    const local = emailLocalOf(name);
    let email = `${local}@${team}`;
    for (let n = 2; emails.has(email); n++)
      email = `${local}${String(n)}@${team}`;
    emails.add(email);
    const recent = rng() < 0.12;
    out.push({
      name,
      email,
      joinedDaysAgo: recent
        ? between(rng, 0, 6)
        : Math.round(7 + Math.pow(rng(), 1.6) * 640),
      admin: team === "udp.dev" && rng() < 0.08,
    });
  }
  return out;
}
