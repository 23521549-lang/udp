import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { MEASUREMENT_FILES } from "../src/features/admin/evidence/measurement-files";
import { EXPERIMENTS } from "../src/features/admin/evidence/experiments";
import { measurementsFrom } from "../src/features/admin/evidence/measurements";
import { useLocaleStore } from "../src/i18n";
import { API, golden, server } from "./msw";
import { renderApp, USER } from "./render";

/**
 * [Plan #56] Trang "Bằng chứng thực nghiệm" (`/admin/evidence`).
 *
 * Nửa đầu là phép kiểm KHÔNG TRÔI (QĐ-7): sổ thí nghiệm của Portal, bảng §14 của thiết kế, thư mục tệp thô và sổ
 * nợ là bốn nơi nói về cùng một tập phép đo — lệch nhau là đỏ ở đây, không phải một thẻ thiếu lúc bảo vệ luận văn.
 * Nửa sau dựng cả trang với tệp thô THẬT của repo (cùng chunk mà trang nạp) và E10 từ golden của Service 1.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("sổ thí nghiệm không trôi", () => {
  it("mã E* của sổ bằng đúng các phép đo trong bảng §14 của UDP_design.md", () => {
    const design = read("docs", "UDP_design.md");
    const start = design.indexOf("## 14. Kế hoạch đánh giá thực nghiệm");
    const end = design.indexOf("\n## 15.", start);
    expect(start).toBeGreaterThan(0);
    const inDesign = [
      ...design.slice(start, end).matchAll(/^\| \*\*(E\d+)\*\* \|/gm),
    ].map((m) => m[1]);
    const inRegistry = EXPERIMENTS.map((e) => e.id).filter((id) =>
      /^E\d+$/.test(id),
    );
    expect(new Set(inRegistry)).toEqual(new Set(inDesign));
    expect(inRegistry).toHaveLength(16);
  });

  it("mọi tiền tố tệp thô đều có thẻ trong sổ", () => {
    const loaded = measurementsFrom(MEASUREMENT_FILES);
    const ids = new Set<string>(EXPERIMENTS.map((e) => e.id));
    expect([...loaded.keys()].filter((k) => !ids.has(k))).toEqual([]);
  });

  it("mọi mã sổ nợ mà sổ khai là một mục có thật của kiem-chung-con-no.md", () => {
    const ledger = read("docs", "measurements", "kiem-chung-con-no.md");
    const codes = new Set([...ledger.matchAll(/^## (\S+)/gm)].map((m) => m[1]));
    const missing = EXPERIMENTS.flatMap((e) => e.debts).filter(
      (d) => !codes.has(d),
    );
    expect(missing).toEqual([]);
  });
});

describe("đọc tệp thô", () => {
  it("mọi tệp của repo qua schema; tệp mới nhất là số chính thức, lần đo cũ được đếm", () => {
    const loaded = measurementsFrom(MEASUREMENT_FILES);
    expect(
      [...loaded.values()].filter((x) => x.problem !== null).map((x) => x.file),
    ).toEqual([]);
    const e3 = loaded.get("E3");
    expect(e3?.file).toBe("E3-20260922-1906.json");
    expect(e3?.earlier).toEqual(["E3-20260922-1543.json"]);
    expect(loaded.get("E7")?.data).toBeDefined();
  });

  it("tệp hỏng ⇒ câu chỉ đúng trường sai, không ném", () => {
    const loaded = measurementsFrom({
      "x/E3-20990101-0000.json": JSON.stringify({
        experiment: "E3",
        at: "2099-01-01T00:00:00.000Z",
        environment: JSON.parse(
          MEASUREMENT_FILES[
            Object.keys(MEASUREMENT_FILES).find((p) =>
              p.endsWith("E3-20260922-1906.json"),
            ) ?? ""
          ] ?? "{}",
        ).environment,
        data: { local: "không phải mảng", remote: {} },
      }),
      "x/E9-20990101-0000.json": "{ hỏng",
    });
    expect(loaded.get("E3")?.problem).toMatch(/^data\.local/);
    expect(loaded.get("E9")?.problem).not.toBeNull();
  });
});

const ADMIN = { ...USER, platformRole: "PLATFORM_ADMIN" as const };

function useDoraHandler(): { days: string[] } {
  const days: string[] = [];
  server.use(
    // [Plan #58 UX-26] Huy hiệu của menu Bảng điều khiển đọc Tổng quan
    http.get(`${API}/admin/overview`, () =>
      HttpResponse.json(golden("GET /admin/overview")),
    ),
    http.get(`${API}/admin/evidence/dora`, ({ request }) => {
      days.push(new URL(request.url).searchParams.get("days") ?? "");
      return HttpResponse.json(golden("GET /admin/evidence/dora"));
    }),
  );
  return { days };
}

describe("trang Bằng chứng", () => {
  it("một thẻ cho MỖI phép đo, đúng trạng thái; biểu đồ từ tệp thô kèm nguồn và nút tải", async () => {
    useDoraHandler();
    renderApp("/admin/evidence", { user: ADMIN });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Bằng chứng thực nghiệm",
      }),
    ).toBeInTheDocument();
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(EXPERIMENTS.length);

    const card = (id: string) => {
      const found = cards.find((c) =>
        within(c).queryByRole("heading", { name: new RegExp(`^${id} · `) }),
      );
      if (found === undefined) throw new Error(`thiếu thẻ ${id}`);
      return found;
    };
    expect(within(card("E1")).getByText("Đã đo")).toBeInTheDocument();
    expect(within(card("E3")).getByText("Đo một phần")).toBeInTheDocument();
    expect(within(card("E5")).getByText("Chưa đo")).toBeInTheDocument();
    expect(within(card("E10")).getByText("Số sống")).toBeInTheDocument();
    expect(within(card("E11")).getByText("Cần người thật")).toBeInTheDocument();

    const e3 = card("E3");
    expect(
      within(e3).getByRole("heading", { name: "Độ trễ đánh giá theo ô lưới" }),
    ).toBeInTheDocument();
    expect(within(e3).getByText(/E3-20260922-1906\.json/)).toBeInTheDocument();
    expect(within(e3).getByText(/commit f39055a/)).toBeInTheDocument();
    expect(
      within(e3).getByText(/cây có thay đổi chưa commit/),
    ).toBeInTheDocument();
    expect(within(e3).getByText(/1 lần đo trước/)).toBeInTheDocument();
    expect(
      within(e3).getByRole("button", { name: "Tải tệp thô" }),
    ).toBeVisible();
    expect(
      within(e3).getByText(/Sổ nợ: E3-quiet, E3-stats/),
    ).toBeInTheDocument();

    // Ô KHÔNG ĐẠT hiện đúng như đo: ngưỡng 500 ms của danh sách flag
    expect(
      within(card("portal-pagination")).getByText("Ngưỡng 500 ms"),
    ).toBeInTheDocument();
  });

  it("E10 sống: deploy theo ngày và bảng DORA; đổi cửa sổ ghi lên URL và hỏi lại máy chủ", async () => {
    const { days } = useDoraHandler();
    const { router } = renderApp("/admin/evidence", { user: ADMIN });

    const evidence = golden<{
      evidence: {
        projects: {
          projectName: string;
          dora: { changeFailureRate: { total: number } };
        }[];
      };
    }>("GET /admin/evidence/dora").evidence;
    const first = evidence.projects.find(
      (p) => p.dora.changeFailureRate.total > 0,
    );
    if (first === undefined) throw new Error("golden thiếu project có deploy");
    expect(
      await screen.findByRole("rowheader", { name: first.projectName }),
    ).toBeInTheDocument();
    expect(days).toEqual(["30"]);

    await userEvent.click(screen.getByRole("tab", { name: "7 ngày" }));
    await waitFor(() => {
      expect(days).toContain("7");
    });
    expect(router.state.location.search).toEqual({ days: 7 });
  });

  it("người không phải quản trị nền tảng không vào được", async () => {
    server.use(
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const { router } = renderApp("/admin/evidence");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/app/home");
    });
  });

  it("tiếng Anh", async () => {
    useDoraHandler();
    act(() => useLocaleStore.getState().setLocale("en"));
    renderApp("/admin/evidence", { user: ADMIN });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Experimental evidence",
      }),
    ).toBeInTheDocument();
    expect(await screen.findAllByText("Measured")).not.toHaveLength(0);
  });
});
