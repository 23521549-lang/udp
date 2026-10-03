import type {
  ArchitectureWire,
  AuditEntryWire,
  HomeWire,
  ProjectDetailResponseWire,
  PublicMemberWire,
  SdkKeyWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { registerErrors } from "../src/features/auth/AuthPages";
import { authMessages } from "../src/features/auth/auth.messages";
import { givenNameOf } from "../src/features/home/HomePage";
import {
  allDone,
  startFacts,
  type StartInput,
} from "../src/features/project/getting-started";
import {
  auditOptionLabel,
  auditSentence,
  auditTarget,
} from "../src/features/project/settings/audit-labels";
import { quickstartCode } from "../src/features/project/settings/sdk-quickstart";
import { useLocaleStore } from "../src/i18n";
import { useShortcutStore } from "../src/lib/shortcuts";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * [Plan #58] Khu project của đợt tối ưu UX: lời chào theo ngôn ngữ, lần đầu vào, thẻ "Bắt đầu", sức khoẻ tách khỏi
 * vòng đời, cài SDK, chọn domain cho người mới, wizard có thanh bước, nhật ký đọc được, bảng lệnh.
 */

describe("lời chào (UX-24)", () => {
  it("tiếng Việt gọi chữ cuối, tiếng Anh gọi chữ đầu", () => {
    expect(givenNameOf("Nguyễn Thị Lan")).toBe("Lan");
    expect(givenNameOf("Jane Doe")).toBe("Jane");
    expect(givenNameOf("  Jane   Doe ")).toBe("Jane");
    expect(givenNameOf("Madonna")).toBe("Madonna");
    // Tên Việt giữ thứ tự Việt kể cả khi giao diện tiếng Anh, kể cả khi gõ không dấu
    expect(givenNameOf("Nguyen Van Minh")).toBe("Minh");
    expect(givenNameOf("Châu Ngọc Hân")).toBe("Hân");
    expect(givenNameOf("")).toBe("");
  });
});

describe("thẻ Bắt đầu: tự đánh dấu (UX-12)", () => {
  const key = (status: SdkKeyWire["status"]) =>
    ({ status }) as unknown as SdkKeyWire;
  const arch = (cloud: boolean, tools: number) =>
    ({
      cloud: cloud ? {} : null,
      tools: Array.from({ length: tools }, () => ({})),
    }) as unknown as ArchitectureWire;
  const none: StartInput = {
    keysByEnv: [undefined, undefined],
    flagTotal: undefined,
    architecture: undefined,
    latestByEnv: [undefined, undefined],
  };

  it("chưa tải gì ⇒ chưa biết, không đánh dấu", () => {
    expect(startFacts(none)).toEqual({
      sdkKey: undefined,
      flag: undefined,
      cloud: undefined,
      domains: undefined,
      deploy: undefined,
    });
  });

  it("một env có key đang dùng là đủ; key đã thu hồi không tính; mọi env trả lời mới kết luận 'chưa'", () => {
    expect(
      startFacts({ ...none, keysByEnv: [undefined, [key("active")]] }).sdkKey,
    ).toBe(true);
    expect(startFacts({ ...none, keysByEnv: [[], undefined] }).sdkKey).toBe(
      undefined,
    );
    expect(
      startFacts({ ...none, keysByEnv: [[key("revoked")], []] }).sdkKey,
    ).toBe(false);
  });

  it("flag, cloud, domain, deploy đọc từ dữ liệu của Tổng quan; đủ năm thì xong", () => {
    const facts = startFacts({
      keysByEnv: [[key("active")]],
      flagTotal: 0,
      architecture: arch(false, 0),
      latestByEnv: [{ deployment: null }, { deployment: null }],
    });
    expect(facts).toMatchObject({
      flag: false,
      cloud: false,
      domains: false,
      deploy: false,
    });
    const done = startFacts({
      keysByEnv: [[key("active")]],
      flagTotal: 3,
      architecture: arch(true, 2),
      latestByEnv: [{ deployment: null }, { deployment: {} }],
    });
    expect(allDone(done)).toBe(true);
  });
});

describe("nhật ký đọc được (UX-35)", () => {
  const members = golden<{ members: PublicMemberWire[] }>(
    "GET /projects/{id}/members",
  ).members;
  const owner = members[0]!;
  const entry = (over: Partial<AuditEntryWire>): AuditEntryWire => ({
    id: "00000000-0000-4000-8000-000000000001",
    action: "flag.create",
    actorType: "USER",
    actorUserId: owner.userId,
    targetType: "FeatureFlag",
    targetId: "12345678-aaaa-4bbb-8ccc-000000000000",
    environmentId: null,
    before: null,
    after: { key: "new-checkout" },
    occurredAt: "2026-09-30T10:00:00.000Z",
    ...over,
  });

  it("ai làm + câu + đối tượng; mã lạ giữ nguyên", () => {
    expect(auditSentence(entry({}), members)).toBe(
      `${owner.user.name} tạo flag`,
    );
    expect(auditTarget(entry({}), members)).toBe("new-checkout");
    expect(auditSentence(entry({ action: "flag.teleport" }), members)).toBe(
      undefined,
    );
    expect(
      auditSentence(entry({ actorType: "SYSTEM", actorUserId: null }), members),
    ).toBe("UDP tạo flag");
    expect(
      auditSentence(
        entry({ actorUserId: "abcdef12-0000-4000-8000-000000000000" }),
        members,
      ),
    ).toBe("Người dùng abcdef12 tạo flag");
  });

  it("đối tượng: email thành viên, tên domain, hay mã ngắn", () => {
    const member = members[1]!;
    expect(
      auditTarget(
        entry({ action: "member.add", targetId: member.userId, after: null }),
        members,
      ),
    ).toBe(member.user.email);
    expect(
      auditTarget(entry({ after: { domainType: "GITOPS" } }), members),
    ).toBe("GitOps");
    expect(auditTarget(entry({ after: null }), members)).toBe("12345678");
  });

  it("tiếng Anh; nhãn lựa chọn viết hoa chữ đầu", () => {
    useLocaleStore.setState({ locale: "en" });
    expect(auditSentence(entry({ action: "sdkkey.revoke" }), members)).toBe(
      `${owner.user.name} revoked an SDK key`,
    );
    expect(auditOptionLabel("flag.create")).toBe("Created a flag");
    useLocaleStore.setState({ locale: "vi" });
    expect(auditOptionLabel("flag.create")).toBe("Tạo flag");
  });

  it("tab Nhật ký: câu thay cho mã, lọc bằng danh sách theo nhóm", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const actions: (string | null)[] = [];
    server.use(
      http.get(`${API}/projects/:id/audit`, ({ request }) => {
        actions.push(new URL(request.url).searchParams.get("action"));
        return HttpResponse.json(golden("GET /projects/{id}/audit"));
      }),
    );
    renderApp(`/app/projects/${detail.project.id}/settings?tab=audit`);
    const list = await screen.findByRole("list", { name: "Nhật ký" });
    expect(
      await within(list).findByText(/thêm thành viên$/),
    ).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Lọc theo hành động" }),
      "sdkkey.revoke",
    );
    await waitFor(() => expect(actions).toContain("sdkkey.revoke"));
  });
});

describe("đăng ký: luật nói trước, lỗi nói cách sửa (UX-24)", () => {
  it("thiếu tên, email sai, mật khẩu ngắn ⇒ ba lỗi kèm cách sửa", () => {
    const m = authMessages.vi;
    expect(
      registerErrors(
        { name: " ", email: "a@b", password: "123", agree: false },
        m,
      ),
    ).toEqual({
      name: m.nameRequired,
      email: m.emailInvalid,
      password: m.passwordShort(8),
      // [Plan #60 QĐ-6] Ô đồng ý chưa tích cũng là một lỗi nói cách sửa
      acceptTerms: m.consentRequired,
    });
    expect(
      registerErrors(
        {
          name: "Lan",
          email: "lan@congty.vn",
          password: "12345678",
          agree: true,
        },
        m,
      ),
    ).toEqual({});
  });

  it("trang đăng ký hiện độ dài tối thiểu trước khi gõ, gắn vào ô", async () => {
    renderApp("/register", { user: null });
    const password = await screen.findByLabelText("Mật khẩu");
    expect(password).toHaveAccessibleDescription("Ít nhất 8 ký tự.");
  });
});

describe("cài SDK (UX-13)", () => {
  it("tên gói thật của UDP và địa chỉ đã điền sẵn", () => {
    const [nodeInstall, nodeInit] = quickstartCode("node", "https://udp.vn");
    expect(nodeInstall).toBe(
      "npm install @openfeature/server-sdk udp-openfeature",
    );
    expect(nodeInit).toContain('host: "https://udp.vn"');
    expect(nodeInit).toContain("process.env.UDP_SDK_KEY");
    expect(quickstartCode("python", "https://udp.vn")[0]).toContain(
      "udp-openfeature",
    );
    expect(quickstartCode("browser", "https://udp.vn")[0]).toContain(
      "@openfeature/ofrep-web-provider",
    );
  });

  it("env chưa có key ⇒ nói vì sao và có nút; tạo xong ⇒ ba bước ngay trong hộp", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/environments/:envId/keys`, () =>
        HttpResponse.json({ keys: [] }),
      ),
      http.post(`${API}/projects/:id/environments/:envId/keys`, () =>
        HttpResponse.json(
          golden("POST /projects/{id}/environments/{id}/keys"),
          { status: 201 },
        ),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/settings?tab=keys`);
    expect(
      await screen.findByText(/^Chưa có SDK key nào ở /),
    ).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Các bước cài SDK" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "Tạo key" })[0]!);
    const create = await screen.findByRole("dialog");
    await user.click(within(create).getByRole("button", { name: "Tạo key" }));
    const created = await screen.findByRole("dialog", { name: "Key đã tạo" });
    const inDialog = within(created).getByRole("list", {
      name: "Các bước cài SDK",
    });
    expect(inDialog).toHaveTextContent("npm install");
    // Key server: Node và Python, không có trình duyệt
    expect(
      within(created).getByRole("button", { name: "Python" }),
    ).toBeInTheDocument();
    expect(
      within(created).queryByRole("button", { name: "Trình duyệt" }),
    ).toBeNull();
  });
});

describe("lần đầu vào (UX-11)", () => {
  it("chưa có project ⇒ không ba số 0; một câu, ba bước, một nút", async () => {
    server.use(
      http.get(`${API}/home`, () =>
        HttpResponse.json({
          home: {
            projects: [],
            rollouts: [],
            attention: [],
            deploys: [],
            generatedAt: new Date().toISOString(),
          },
        }),
      ),
    );
    renderApp("/app/home");
    const intro = await screen.findByRole("region", {
      name: "Bắt đầu với UDP",
    });
    expect(within(intro).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(intro).getByRole("link", { name: "Tạo project đầu tiên" }),
    ).toHaveAttribute("href", "/app/projects/new");
    expect(screen.queryByText("việc cần xử lý")).toBeNull();
  });
});

describe("Tổng quan (UX-5, UX-12, UX-29)", () => {
  function setup(): ProjectDetailResponseWire {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const home = golden<{ home: HomeWire }>("GET /home");
    home.home.projects[0]!.id = detail.project.id;
    home.home.projects[0]!.attention = 2;
    server.use(http.get(`${API}/home`, () => HttpResponse.json(home)));
    return detail;
  }

  it("vòng đời 'Đang hoạt động' và sức khoẻ riêng; số thành viên dẫn tới ô mời", async () => {
    const detail = setup();
    renderApp(`/app/projects/${detail.project.id}`);
    expect(await screen.findByText("Đang hoạt động")).toBeInTheDocument();
    expect(await screen.findByText("2 việc cần xử lý")).toBeInTheDocument();
    const members = await screen.findByRole("link", { name: /2 thành viên/ });
    // Router ghi "1" dạng JSON ("%221%22") để giữ kiểu chuỗi; đọc lại vẫn là "1"
    expect(members.getAttribute("href")).toContain(
      `/app/projects/${detail.project.id}/settings?tab=members&new=`,
    );
  });

  it("thẻ Bắt đầu: việc tự đánh dấu, mỗi việc là link; Ẩn thì không hiện lại", async () => {
    const detail = setup();
    const view = renderApp(`/app/projects/${detail.project.id}`);
    const card = await screen.findByRole("region", { name: "Bắt đầu" });
    const sdk = within(card).getByRole("link", { name: "Tạo SDK key" });
    expect(sdk.getAttribute("href")).toContain("tab=keys");
    await waitFor(() => expect(sdk.closest("li")).toHaveTextContent("Xong"));
    expect(
      within(card).getByRole("link", { name: "Kết nối cloud" }).closest("li"),
    ).toHaveTextContent("Xong");

    await userEvent.click(
      within(card).getByRole("button", { name: "Ẩn thẻ này" }),
    );
    expect(screen.queryByRole("region", { name: "Bắt đầu" })).toBeNull();
    view.unmount();
    renderApp(`/app/projects/${detail.project.id}`);
    await screen.findByRole("region", { name: "Cloud" });
    expect(screen.queryByRole("region", { name: "Bắt đầu" })).toBeNull();
  });

  it("Ctrl K: 'Mời thành viên' và 'Tạo SDK key'; phím số tắt được", async () => {
    const detail = setup();
    const ordered = [...detail.environments].sort((a, b) => a.rank - b.rank);
    const { router } = renderApp(`/app/projects/${detail.project.id}`);
    await screen.findByRole("region", { name: "Cloud" });
    const user = userEvent.setup();

    useShortcutStore.setState({ enabled: false });
    await user.keyboard("2");
    expect(router.state.location.search).not.toMatchObject({
      env: ordered[1]!.id,
    });

    await user.keyboard("{Control>}k{/Control}");
    const palette = await screen.findByRole("dialog", { name: "Tìm nhanh" });
    expect(
      within(palette).getByRole("option", { name: /Tạo SDK key/ }),
    ).toBeInTheDocument();
    await user.click(
      within(palette).getByRole("option", { name: /Mời thành viên/ }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: "members",
        new: "1",
      }),
    );
    expect(
      await screen.findByRole("textbox", { name: "Email thành viên mới" }),
    ).toHaveFocus();
  });
});

describe("chọn domain cho người mới (UX-14)", () => {
  it("nhóm theo việc, một câu công dụng, gói khuyến nghị bật ba domain", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/domains/catalog`, () =>
        HttpResponse.json(golden("GET /domains/catalog")),
      ),
      http.get(`${API}/projects/:id/domains`, () =>
        HttpResponse.json({
          ...golden<object>("GET /projects/{id}/domains"),
          domains: [],
        }),
      ),
      http.post(`${API}/projects/:id/domains/validate`, () =>
        HttpResponse.json(golden("POST /projects/{id}/domains/validate")),
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/domains`);
    expect(await screen.findByText(/không phải tên miền/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Build và giao hàng" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Cốt lõi" })).toBeNull();
    expect(
      screen.getByText("Tự build, test và đóng image mỗi lần bạn push code."),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Khuyến nghị cho người mới" }),
    );
    for (const name of ["CI/CD", "Container Registry", "Monitoring"]) {
      expect(screen.getByRole("switch", { name: `Bật ${name}` })).toBeChecked();
    }
    expect(
      screen.getByRole("switch", { name: "Bật Logging" }),
    ).not.toBeChecked();
  });
});

describe("wizard: thanh năm bước và Quay lại (UX-15)", () => {
  it("bước domain: bước cloud bấm được để quay lại; nút Quay lại về bước trước", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/domains/catalog`, () =>
        HttpResponse.json(golden("GET /domains/catalog")),
      ),
      http.get(`${API}/projects/:id/domains`, () =>
        HttpResponse.json(golden("GET /projects/{id}/domains")),
      ),
    );
    renderApp(`/app/projects/new?project=${detail.project.id}&step=domains`);
    const steps = await screen.findByRole("navigation", {
      name: "Các bước tạo project",
    });
    const current = within(steps)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveTextContent("Domain");
    const back = `/app/projects/new?project=${detail.project.id}&step=cloud`;
    expect(within(steps).getByRole("link", { name: /Cloud/ })).toHaveAttribute(
      "href",
      back,
    );
    expect(screen.getByRole("link", { name: "Quay lại" })).toHaveAttribute(
      "href",
      back,
    );
  });
});
