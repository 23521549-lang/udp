import type {
  InvitationLookupWire,
  ProjectDetailResponseWire,
  TeamDetailWire,
} from "@udp/shared-types/wire";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { safeRedirect } from "../src/features/auth/AuthPages";
import { pendingInvite } from "../src/features/invitation/invitation-api";
import { useLocaleStore } from "../src/i18n";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp, USER } from "./render";

/**
 * [Plan #55 AC-5] Lời mời bằng đường dẫn và nhóm trên Portal — body lấy từ golden capture của Service 1.
 *
 * Ba điều chính: "Mời" một email chưa có tài khoản hiện ĐƯỜNG DẪN (token ở fragment, không bao giờ ở path hay
 * query); trang `/invite` cất token rồi xoá nó khỏi URL, nên đường quay lại sau đăng nhập không mang token; và
 * mọi người vào được project qua nhóm hiện ra ở phần "Nhóm có quyền".
 */

const TOKEN = `udp_inv_${"a".repeat(43)}`;

afterEach(() => {
  pendingInvite.clear();
});

const notFound = (detail: string) =>
  HttpResponse.json(
    {
      type: "about:blank",
      title: "NOT_FOUND",
      status: 404,
      detail,
      instance: "/api/v1/x",
      traceId: "t-1",
    },
    { status: 404 },
  );

/** Ba lời gọi thêm của tab Thành viên từ Plan #55 */
function useMembersTabHandlers(): { sent: { path: string; body: unknown }[] } {
  const sent: { path: string; body: unknown }[] = [];
  const invitations = golden<{ invitations: unknown[] }>(
    "GET /projects/{id}/invitations",
  );
  server.use(
    http.get(`${API}/projects/:id/invitations`, () =>
      HttpResponse.json(invitations),
    ),
    http.get(`${API}/projects/:id/teams`, () =>
      HttpResponse.json(golden("GET /projects/{id}/teams")),
    ),
    http.get(`${API}/teams`, () => HttpResponse.json(golden("GET /teams"))),
    http.post(`${API}/projects/:id/members`, async ({ request }) => {
      sent.push({ path: "members", body: await request.json() });
      return notFound("Chưa có tài khoản nào dùng email này");
    }),
    http.post(`${API}/projects/:id/invitations`, async ({ request }) => {
      const body = (await request.json()) as { email: string };
      sent.push({ path: "invitations", body });
      const created = golden<{
        invitation: { email: string };
        token: string;
      }>("POST /projects/{id}/invitations");
      created.invitation.email = body.email;
      created.token = TOKEN;
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post(`${API}/projects/:id/teams`, async ({ request }) => {
      sent.push({ path: "teams", body: await request.json() });
      return HttpResponse.json(golden("POST /projects/{id}/teams"), {
        status: 201,
      });
    }),
  );
  return { sent };
}

const membersTab = (detail: ProjectDetailResponseWire) =>
  `/app/projects/${detail.project.id}/settings?tab=members`;

describe("tab Thành viên — lời mời và nhóm (Plan #55)", () => {
  it("OWNER mời email chưa có tài khoản ⇒ đường dẫn mời hiện MỘT lần, token ở fragment", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { sent } = useMembersTabHandlers();
    renderApp(membersTab(detail));

    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email thành viên mới" }),
      "khach@congty.vn",
    );
    await userEvent.click(screen.getByRole("button", { name: "Mời" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Đường dẫn mời",
    });
    const link = within(dialog).getByRole("region", {
      name: "Đường dẫn mời",
    }).textContent;
    expect(link).toMatch(new RegExp(`/invite#${TOKEN}$`));
    expect(link).not.toMatch(/\?/);
    expect(sent.map((s) => s.path)).toEqual(["members", "invitations"]);
    expect(sent[1]?.body).toEqual({
      email: "khach@congty.vn",
      projectRole: "DEVELOPER",
    });
  });

  it("thấy lời mời đang chờ và mọi người vào được qua nhóm", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    useMembersTabHandlers();
    renderApp(membersTab(detail));

    const pending = await screen.findByRole("list", {
      name: "Lời mời đang chờ",
    });
    const invited = golden<{ invitations: { email: string }[] }>(
      "GET /projects/{id}/invitations",
    ).invitations;
    for (const i of invited) {
      expect(within(pending).getByText(i.email)).toBeInTheDocument();
    }

    const teams = await screen.findByRole("list", {
      name: "Nhóm có quyền trên project",
    });
    const granted = golden<{
      teams: { name: string; members: { name: string }[] }[];
    }>("GET /projects/{id}/teams").teams[0];
    if (granted === undefined) throw new Error("mẫu thiếu nhóm");
    expect(within(teams).getByText(granted.name)).toBeInTheDocument();
    expect(
      within(teams).getByText(new RegExp(`${granted.members.length} người`)),
    ).toBeInTheDocument();
  });

  it("OWNER cấp quyền cho nhóm của mình chưa có quyền ở đây", async () => {
    const detail = projectFixture("OWNER");
    useProjectHandlers(detail);
    const { sent } = useMembersTabHandlers();
    renderApp(membersTab(detail));

    const mine = golden<{ teams: { id: string; name: string }[] }>("GET /teams")
      .teams[0];
    if (mine === undefined) throw new Error("mẫu thiếu nhóm");
    const picker = await screen.findByRole("combobox", { name: "Nhóm" });
    expect(within(picker).getByText(mine.name)).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Vai của nhóm" }),
      "VIEWER",
    );
    await userEvent.click(screen.getByRole("button", { name: "Cấp quyền" }));
    await waitFor(() => {
      expect(sent).toContainEqual({
        path: "teams",
        body: { teamId: mine.id, projectRole: "VIEWER" },
      });
    });
  });

  it("VIEWER chỉ xem: không form mời, không lời mời đang chờ, nhóm không sửa được", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useMembersTabHandlers();
    renderApp(membersTab(detail));

    await screen.findByRole("list", { name: "Nhóm có quyền trên project" });
    expect(
      screen.queryByRole("textbox", { name: "Email thành viên mới" }),
    ).toBeNull();
    expect(screen.queryByRole("list", { name: "Lời mời đang chờ" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Gỡ quyền/ })).toBeNull();
  });
});

describe("trang Nhóm (Plan #55)", () => {
  it("danh sách nhóm của tôi; tạo nhóm đi thẳng tới trang nhóm", async () => {
    const created = golden<{ team: TeamDetailWire }>("POST /teams");
    server.use(
      http.get(`${API}/teams`, () => HttpResponse.json(golden("GET /teams"))),
      http.post(`${API}/teams`, () =>
        HttpResponse.json(created, { status: 201 }),
      ),
      http.get(`${API}/teams/:teamId`, () => HttpResponse.json(created)),
      http.get(`${API}/teams/:teamId/invitations`, () =>
        HttpResponse.json({ invitations: [] }),
      ),
    );
    const { router } = renderApp("/app/teams");

    const list = await screen.findByRole("list", { name: "Nhóm của bạn" });
    const first = golden<{ teams: { name: string }[] }>("GET /teams").teams[0];
    expect(within(list).getByText(first?.name ?? "")).toBeInTheDocument();

    await userEvent.type(
      screen.getByRole("textbox", { name: "Tên nhóm mới" }),
      created.team.name,
    );
    await userEvent.click(screen.getByRole("button", { name: "Tạo nhóm" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/app/teams/${created.team.id}`,
      );
    });
  });

  it("thành viên thường: không sửa được nhóm, chỉ rời được — rời xong về danh sách", async () => {
    const { team } = golden<{ team: TeamDetailWire }>("GET /teams/{id}");
    team.myRole = "MEMBER";
    const self = team.members.find((x) => x.teamRole === "MEMBER");
    if (self === undefined) throw new Error("mẫu thiếu thành viên thường");
    self.userId = USER.id;
    self.user = { id: USER.id, email: USER.email, name: USER.name };
    const removed: string[] = [];
    server.use(
      http.get(`${API}/teams/:teamId`, () => HttpResponse.json({ team })),
      http.delete(`${API}/teams/:teamId/members/:userId`, ({ params }) => {
        removed.push(String(params.userId));
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${API}/teams`, () => HttpResponse.json({ teams: [] })),
    );
    const { router } = renderApp(`/app/teams/${team.id}`);

    await screen.findByRole("list", { name: "Thành viên của nhóm" });
    expect(
      screen.queryByRole("textbox", { name: "Email thành viên mới" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Gỡ / })).toBeNull();
    expect(screen.queryByRole("region", { name: "Cài đặt nhóm" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Rời nhóm" }));
    const dialog = await screen.findByRole("dialog", { name: "Rời nhóm?" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Rời nhóm" }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/app/teams");
    });
    expect(removed).toEqual([USER.id]);
  });

  it("chủ nhóm mời email chưa có tài khoản ⇒ lời mời vào nhóm và đường dẫn", async () => {
    const { team } = golden<{ team: TeamDetailWire }>("GET /teams/{id}");
    team.myRole = "OWNER";
    server.use(
      http.get(`${API}/teams/:teamId`, () => HttpResponse.json({ team })),
      http.get(`${API}/teams/:teamId/invitations`, () =>
        HttpResponse.json(golden("GET /teams/{id}/invitations")),
      ),
      http.post(`${API}/teams/:teamId/members`, () =>
        notFound("Chưa có tài khoản nào dùng email này"),
      ),
      http.post(`${API}/teams/:teamId/invitations`, () => {
        const created = golden<{ token: string }>(
          "POST /teams/{id}/invitations",
        );
        created.token = TOKEN;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    renderApp(`/app/teams/${team.id}`);

    await userEvent.type(
      await screen.findByRole("textbox", { name: "Email thành viên mới" }),
      "moi@congty.vn",
    );
    await userEvent.click(screen.getByRole("button", { name: "Mời" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Đường dẫn mời",
    });
    expect(dialog.textContent).toContain(`/invite#${TOKEN}`);
  });

  it("tiếng Anh: khung trang Nhóm không còn chữ tiếng Việt", async () => {
    server.use(
      http.get(`${API}/teams`, () => HttpResponse.json(golden("GET /teams"))),
    );
    act(() => useLocaleStore.getState().setLocale("en"));
    renderApp("/app/teams");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Teams" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create team" })).toBeVisible();
    expect(
      await screen.findByRole("list", { name: "Your teams" }),
    ).toBeVisible();
  });
});

describe("trang nhận lời mời /invite (Plan #55)", () => {
  const lookup = (): InvitationLookupWire =>
    golden<{ invitation: InvitationLookupWire }>("POST /invitations/lookup")
      .invitation;

  it("chưa đăng nhập: thấy lời mời; token rời URL vào sessionStorage; đăng nhập quay về /invite không mang token", async () => {
    const sentTokens: unknown[] = [];
    server.use(
      http.post(`${API}/invitations/lookup`, async ({ request }) => {
        sentTokens.push(await request.json());
        return HttpResponse.json({ invitation: lookup() });
      }),
    );
    const { router } = renderApp(`/invite#${TOKEN}`, { user: null });

    const invitation = lookup();
    expect(await screen.findByText(invitation.target.name)).toBeInTheDocument();
    expect(sentTokens).toEqual([{ token: TOKEN }]);
    await waitFor(() => {
      expect(router.state.location.hash).toBe("");
    });
    expect(pendingInvite.read()).toBe(TOKEN);

    const signIn = screen.getByRole("link", { name: "Đăng nhập" });
    expect(signIn.getAttribute("href")).toBe("/login?redirectTo=%2Finvite");
    expect(signIn.getAttribute("href")).not.toContain(TOKEN);
  });

  it("đăng nhập đúng email ⇒ nhận ⇒ vào thẳng project", async () => {
    const invitation = lookup();
    const accepted = golden<{ target: { id: string } }>(
      "POST /invitations/accept",
    );
    const detail = projectFixture("DEVELOPER");
    detail.project.id = accepted.target.id;
    useProjectHandlers(detail);
    server.use(
      http.post(`${API}/invitations/lookup`, () =>
        HttpResponse.json({ invitation }),
      ),
      http.post(`${API}/invitations/accept`, () => HttpResponse.json(accepted)),
      http.get(`${API}/home`, () => HttpResponse.json(golden("GET /home"))),
    );
    const { router } = renderApp(`/invite#${TOKEN}`, {
      user: { ...USER, email: invitation.email },
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Nhận lời mời" }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/app/projects/${accepted.target.id}`,
      );
    });
    expect(pendingInvite.read()).toBeNull();
  });

  it("đăng nhập SAI email ⇒ nói rõ và cho đăng xuất, không có nút nhận", async () => {
    server.use(
      http.post(`${API}/invitations/lookup`, () =>
        HttpResponse.json({ invitation: lookup() }),
      ),
    );
    renderApp(`/invite#${TOKEN}`);
    expect(
      await screen.findByText(
        new RegExp(`Bạn đang đăng nhập bằng ${USER.email}`),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Nhận lời mời" })).toBeNull();
  });

  it("lời mời không còn hiệu lực ⇒ một câu, và token bị quên", async () => {
    server.use(
      http.post(`${API}/invitations/lookup`, () =>
        notFound("Lời mời không còn hiệu lực"),
      ),
    );
    renderApp(`/invite#${TOKEN}`, { user: null });
    expect(
      await screen.findByRole("heading", {
        name: "Lời mời không còn hiệu lực",
      }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(pendingInvite.read()).toBeNull();
    });
  });

  it("không có token ⇒ nói đường dẫn không đầy đủ, không gọi máy chủ", async () => {
    renderApp("/invite", { user: null });
    expect(
      await screen.findByText(/Đường dẫn mời không đầy đủ/),
    ).toBeInTheDocument();
  });

  it("safeRedirect nhận /invite, vẫn chặn trang ngoài", () => {
    expect(safeRedirect("/invite")).toBe("/invite");
    expect(safeRedirect("https://evil.example/invite")).toBe("/app/home");
    expect(safeRedirect("/invitex")).toBe("/app/home");
  });
});
