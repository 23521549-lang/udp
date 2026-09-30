import { currentLocale, useLocaleStore, type Locale } from "../src/i18n";
import {
  PERSONAS,
  PLATFORM_SCENARIOS,
  storedSetup,
  storeSetup,
  type DemoSetup,
  type PersonaId,
  type PlatformScenario,
} from "./mock/persona";

/**
 * Dải "Bản xem thử" ở góc màn hình: nói rõ đây là dữ liệu mẫu, và cho người xem đổi VAI (quản trị viên, developer,
 * người mới chưa có gì) cùng tình huống của nền tảng. Đổi là tải lại trang: dữ liệu mẫu dựng lại từ đầu cho đúng
 * người đó. Ngoài `src/` nên chữ khai tại chỗ, hai ngôn ngữ theo lựa chọn `udp_locale` của Portal.
 */

interface Copy {
  region: string;
  title: string;
  note: string;
  persona: string;
  personas: Record<PersonaId, string>;
  platform: string;
  platforms: Record<PlatformScenario, string>;
}

const COPY: Record<Locale, Copy> = {
  vi: {
    region: "Bản xem thử",
    title: "Bản xem thử",
    note: "Dữ liệu mẫu, không kết nối hệ thống thật. Đổi lựa chọn là tải lại trang.",
    persona: "Xem với vai",
    personas: {
      admin: "Quản trị viên",
      developer: "Developer",
      newcomer: "Người mới",
    },
    platform: "Nền tảng",
    platforms: { healthy: "Ổn định", "at-risk": "Có rủi ro" },
  },
  en: {
    region: "Preview",
    title: "Preview",
    note: "Sample data, not connected to a real system. Changing a choice reloads the page.",
    persona: "View as",
    personas: {
      admin: "Platform admin",
      developer: "Developer",
      newcomer: "Newcomer",
    },
    platform: "Platform",
    platforms: { healthy: "Healthy", "at-risk": "At risk" },
  },
};

function select<T extends string>(
  label: string,
  options: readonly T[],
  names: Record<T, string>,
  value: T,
  onChange: (next: T) => void,
): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.append(label);
  const input = document.createElement("select");
  for (const option of options) {
    input.append(new Option(names[option], option, false, option === value));
  }
  input.addEventListener("change", () => {
    const next = options.find((o) => o === input.value);
    if (next !== undefined) onChange(next);
  });
  wrap.append(input);
  return wrap;
}

/** Nhớ lựa chọn rồi tải lại; đổi vai thì về trang chủ (trang đang mở có thể không thuộc về người mới) */
function apply(next: DemoSetup, current: DemoSetup): void {
  storeSetup(next);
  if (next.persona !== current.persona) window.location.hash = "#/app/home";
  window.location.reload();
}

export function mountDemoBanner(host: HTMLElement): void {
  const setup = storedSetup();
  const render = (): void => {
    const t = COPY[currentLocale()];
    host.setAttribute("aria-label", t.region);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${t.title} · ${t.personas[setup.persona]}`;
    const panel = document.createElement("div");
    panel.className = "demo-panel";
    const note = document.createElement("p");
    note.textContent = t.note;
    panel.append(
      note,
      select(t.persona, PERSONAS, t.personas, setup.persona, (persona) => {
        apply({ ...setup, persona }, setup);
      }),
    );
    // Tín hiệu của cụm chỉ quản trị viên thấy
    if (setup.persona === "admin") {
      panel.append(
        select(
          t.platform,
          PLATFORM_SCENARIOS,
          t.platforms,
          setup.platform,
          (platform) => {
            apply({ ...setup, platform }, setup);
          },
        ),
      );
    }
    details.append(summary, panel);
    host.replaceChildren(details);
  };
  render();
  useLocaleStore.subscribe(render);
}
