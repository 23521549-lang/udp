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
  width: number;
  height: number;
  /** Vị trí các chú thích đánh số, phần trăm theo bề rộng và chiều cao của ảnh */
  marks: readonly (readonly number[])[];
}

export function useShot(name: ShotName): Shot {
  const { theme } = useTheme();
  const locale = useLocale();
  const variant = `${theme}-${locale}` as const;
  const size = meta[name][variant];
  return {
    src: URLS[`./shots/${name}-${variant}.webp`] ?? "",
    width: size.width,
    height: size.height,
    marks: size.marks,
  };
}
