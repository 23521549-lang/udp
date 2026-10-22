import { useTheme } from "../../app/theme";
import { useLocale } from "../../i18n";
import meta from "./shots/shots.json";

/**
 * [Plan #59] Ảnh chụp thật của Portal cho trang giới thiệu, theo giao diện và ngôn ngữ người xem đang chọn. Tệp và
 * `shots.json` do `demo/landing-shots.pw.ts` sinh ra từ bản xem thử; không sửa tay. Chỉ ảnh đang hiện được tải (URL
 * nằm trong bundle, tệp thì không).
 */
const URLS = import.meta.glob<string>("./shots/*.webp", {
  eager: true,
  import: "default",
  query: "?url",
});

export type ShotName = keyof typeof meta;

export interface Shot {
  src: string;
  /**
   * [Plan #60 QĐ-9] Bản tối khi người xem ĐỂ giao diện theo hệ thống — `<picture>` để trình duyệt chọn ngay từ HTML
   * dựng sẵn (chưa có JS), không tải bản sáng rồi mới đổi. `undefined` khi người xem đã chọn tay (đã biết chắc).
   */
  darkSrc: string | undefined;
  width: number;
  height: number;
  /** Vị trí các chú thích đánh số, phần trăm theo bề rộng và chiều cao của ảnh */
  marks: readonly (readonly number[])[];
}

const urlOf = (name: ShotName, variant: string): string =>
  URLS[`./shots/${name}-${variant}.webp`] ?? "";

export function useShot(name: ShotName): Shot {
  const { theme, preference } = useTheme();
  const locale = useLocale();
  const system = preference === "system";
  // Theo hệ thống: bản sáng là mặc định của <img>, bản tối nằm ở <source media>
  const variant = `${system ? "light" : theme}-${locale}` as const;
  const size = meta[name][variant];
  return {
    src: urlOf(name, variant),
    darkSrc: system ? urlOf(name, `dark-${locale}`) : undefined,
    width: size.width,
    height: size.height,
    marks: size.marks,
  };
}
