import type { BuildViewWire } from "@udp/shared-types/wire";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { parseIdentityLine } from "../src/features/code/PackagingPanel";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * [Plan #61 QĐ-9] Mục Đóng gói của trang Mã nguồn: nói UDP build thế nào và vì sao (câu viết theo MÃ của máy chủ), việc
 * cần làm, danh tính build (dán dòng kết quả của script), cài đặt build — chỉ MAINTAINER đổi được.
 */

/**
 * Mẫu thật của Service 1, ghim hai phần phụ thuộc project mà bộ test tích hợp tạo ngẫu nhiên: registry (ECR, đẩy bằng
 * danh tính) và giờ rebase (theo slug của tên project)
 */
const view = (): BuildViewWire => ({
  ...golden<BuildViewWire>("GET /projects/{id}/build"),
  registry: {
    server: "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com",
    push: "aws-ecr",
    effectivePush: "aws-ecr",
  },
  rebase: { hour: 4, minute: 17, cron: "17 4 * * *", schedule: "pipeline" },
});

const ROLE = "arn:aws:iam::123456789012:role/udp/udp-build-web";

function serve(
  data: BuildViewWire,
  onPut?: (body: unknown) => BuildViewWire,
): void {
  server.use(
    // Project mẫu là Create New: trang Mã nguồn cũng mở cây Golden Path cho người từ DEVELOPER trở lên
    http.get(`${API}/projects/:id/golden-path`, () =>
      HttpResponse.json(golden("GET /projects/{id}/golden-path")),
    ),
    http.get(`${API}/projects/:id/build`, () => HttpResponse.json(data)),
    http.put(`${API}/projects/:id/build`, async ({ request }) =>
      HttpResponse.json(
        onPut === undefined ? data : onPut(await request.json()),
      ),
    ),
  );
}

describe("mục Đóng gói", () => {
  it("tóm tắt: build bằng gì và vì sao, ngôn ngữ, đẩy vào đâu, kiến trúc, bước test", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    serve(view());
    renderApp(`/app/projects/${detail.project.id}/code`);
    const panel = await screen.findByRole("region", {
      name: "Đóng gói container",
    });
    expect(
      within(panel).getByText("Dockerfile (BuildKit)"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Mẫu dự án (Golden Path) có sẵn Dockerfile."),
    ).toBeInTheDocument();
    expect(within(panel).getByText("linux/amd64")).toBeInTheDocument();
    expect(
      within(panel).getByText("danh tính build, không khoá"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("npm ci && npm test")).toBeInTheDocument();
    // VIEWER không đổi được cài đặt, không có ô dán danh tính
    expect(
      within(panel).getByText(
        "Chỉ Người bảo trì trở lên đổi được cài đặt build.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByLabelText("Dòng kết quả của script"),
    ).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: "Lưu cài đặt" }),
    ).toBeNull();
  });

  it("việc cần làm theo mã: secret của đúng CI, lệnh test thiếu, Dockerfile cần cho Rust", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    serve({
      ...view(),
      language: { value: "rust", source: "scan" },
      prediction: { strategy: "unknown", reason: "SCAN_NEEDS_DOCKERFILE" },
      test: { kind: "missing", language: "rust" },
      identity: { required: false, configured: false, cloud: null },
      identityScript: null,
      todo: [
        {
          code: "CI_SECRETS",
          ci: "gitlab-ci",
          names: ["UDP_REGISTRY_USERNAME", "UDP_REGISTRY_PASSWORD"],
        },
        { code: "NEEDS_DOCKERFILE", language: "rust" },
        { code: "TEST_COMMAND", language: "rust" },
      ],
    });
    renderApp(`/app/projects/${detail.project.id}/code`);
    const panel = await screen.findByRole("region", {
      name: "Đóng gói container",
    });
    expect(
      within(panel).getByText(
        "Thêm biến CI/CD (masked) UDP_REGISTRY_USERNAME, UDP_REGISTRY_PASSWORD ở Settings, CI/CD, Variables.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(
        /Buildpacks không build được Rust: thêm Dockerfile/,
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Chưa có lệnh test cho Rust"),
    ).toBeInTheDocument();
  });

  it("MAINTAINER dán dòng kết quả của script ⇒ PUT kèm danh tính; dán sai thì báo lỗi gắn ô", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const puts: unknown[] = [];
    const before = view();
    serve(before, (body) => {
      puts.push(body);
      return {
        ...before,
        settings: {
          ...before.settings,
          identity: { cloud: "aws", roleArn: ROLE },
        },
        identity: { required: true, configured: true, cloud: "aws" },
        todo: before.todo.filter((t) => t.code !== "BUILD_IDENTITY"),
      };
    });
    renderApp(`/app/projects/${detail.project.id}/code`);
    const box = await screen.findByLabelText("Dòng kết quả của script");
    await userEvent.type(box, "khong phai json");
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu danh tính" }),
    );
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(puts).toHaveLength(0);

    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste(
      `UDP_BUILD_IDENTITY={"cloud":"aws","roleArn":"${ROLE}"}`,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu danh tính" }),
    );
    expect(
      await screen.findByText("Đã có danh tính build."),
    ).toBeInTheDocument();
    expect(puts).toEqual([
      { ...before.settings, identity: { cloud: "aws", roleArn: ROLE } },
    ]);
  });

  it("dòng kết quả mang khoá ký ⇒ khoá lên ĐẦU danh sách (khoá đang ký), khoá cũ vẫn giữ", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const puts: { signing: { keys: { kms: string }[] } }[] = [];
    const before = withKeys(view(), false);
    serve(before, (body) => {
      puts.push(body as (typeof puts)[number]);
      return before;
    });
    renderApp(`/app/projects/${detail.project.id}/code`);
    const box = await screen.findByLabelText("Dòng kết quả của script");
    await userEvent.click(box);
    await userEvent.paste(
      `UDP_BUILD_IDENTITY=${JSON.stringify({
        cloud: "aws",
        roleArn: ROLE,
        signing: { key: NEW_KMS, publicKey: NEW_KEY },
      })}`,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu danh tính" }),
    );
    await screen.findByText("Đã có danh tính build.");
    expect(puts[0]?.signing.keys.map((k) => k.kms)).toEqual([NEW_KMS, KMS]);
  });

  it("cài đặt: đường dẫn có .. bị chặn ở Portal; ghim Buildpacks và tự khai lệnh test ⇒ PUT đúng hình", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const puts: unknown[] = [];
    serve(view(), (body) => {
      puts.push(body);
      return view();
    });
    renderApp(`/app/projects/${detail.project.id}/code`);
    const context = await screen.findByLabelText("Thư mục build");
    await userEvent.clear(context);
    await userEvent.type(context, "../khac");
    await userEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    expect(context).toHaveAttribute("aria-invalid", "true");
    expect(puts).toHaveLength(0);

    await userEvent.clear(context);
    await userEvent.type(context, "services/web");
    await userEvent.selectOptions(
      screen.getByLabelText("Chiến lược"),
      "buildpacks",
    );
    await userEvent.selectOptions(screen.getByLabelText("Bước test"), "custom");
    await userEvent.type(
      screen.getByLabelText("Lệnh test"),
      "bundle exec rspec",
    );
    await userEvent.type(screen.getByLabelText("Image chạy test"), "ruby:3.4");
    await userEvent.click(screen.getByRole("button", { name: "Lưu cài đặt" }));
    expect(
      await screen.findByText("Đã lưu cài đặt build."),
    ).toBeInTheDocument();
    expect(puts[0]).toMatchObject({
      strategy: "buildpacks",
      context: "services/web",
      test: { mode: "custom", command: "bundle exec rspec", image: "ruby:3.4" },
    });
  });
});

describe("mục Đóng gói: vá image nền (Plan #61 QĐ-13)", () => {
  const panel = async () =>
    screen.findByRole("region", { name: "Đóng gói container" });

  it("GitHub Actions: giờ chạy UTC, lịch có sẵn trong tệp workflow", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    serve(view());
    renderApp(`/app/projects/${detail.project.id}/code`);
    const region = await panel();
    expect(
      within(region).getByText("Mỗi ngày lúc 04:17 UTC"),
    ).toBeInTheDocument();
    expect(
      within(region).getByText("Lịch có sẵn trong tệp workflow."),
    ).toBeInTheDocument();
  });

  it("GitLab: chỉ đúng chỗ tạo lịch và cron; ghim Dockerfile ⇒ nói cách lấy bản vá; chưa bật CI ⇒ không có dòng", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    serve({
      ...view(),
      ci: "gitlab-ci",
      rebase: {
        hour: 2,
        minute: 5,
        cron: "5 2 * * *",
        schedule: "ci-settings",
      },
    });
    const { unmount } = renderApp(`/app/projects/${detail.project.id}/code`);
    expect(
      within(await panel()).getByText(
        'Tạo lịch ở Build, Pipeline schedules: nhánh main, cron "5 2 * * *", múi giờ UTC.',
      ),
    ).toBeInTheDocument();
    unmount();

    serve({ ...view(), rebase: null });
    const second = renderApp(`/app/projects/${detail.project.id}/code`);
    expect(
      within(await panel()).getByText(
        "Chiến lược ghim Dockerfile: lấy bản vá của image nền bằng cách cập nhật FROM rồi build lại.",
      ),
    ).toBeInTheDocument();
    second.unmount();

    serve({ ...view(), ci: null, rebase: null });
    renderApp(`/app/projects/${detail.project.id}/code`);
    expect(within(await panel()).queryByText("Vá image nền")).toBeNull();
  });
});

const KMS =
  "awskms:///arn:aws:kms:ap-southeast-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const NEW_KMS =
  "awskms:///arn:aws:kms:ap-southeast-1:123456789012:key/1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";
/** Khoá CÔNG KHAI P-256 (khoá bí mật không tồn tại ở đâu) */
const KEY =
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE92As3/UzUlUytfW39VSLIABMe+N4\nWIlYslUbfoP6nNqQ1xMw/qNyyjMw1XV+qwrxwHPAqozvHYR57HIXLgULfg==\n-----END PUBLIC KEY-----\n";
const NEW_KEY =
  "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqdzw6sbEWzVrQEjvRSRdi70PBHIP\nazmx7HJs8bBnvFiLzmb2crDEQi/zADbyhD6FgyrhCkTMZjfULHDWO+xYlA==\n-----END PUBLIC KEY-----\n";

/** Mục Đóng gói có danh tính và một khoá ký; `enforce` theo đối số */
function withKeys(base: BuildViewWire, enforce: boolean): BuildViewWire {
  return {
    ...base,
    settings: {
      ...base.settings,
      identity: { cloud: "aws", roleArn: ROLE },
      signing: {
        keys: [
          {
            id: "3f9a1c0b7d2e4a55",
            publicKey: KEY,
            kms: KMS,
            addedAt: "2026-09-20T08:00:00.000Z",
          },
        ],
        compat: true,
        enforce,
      },
    },
    identity: { required: true, configured: true, cloud: "aws" },
    signing: { available: true, reason: null },
    todo: [],
  };
}

describe("mục Đóng gói: ký image (Plan #61 QĐ-14, QĐ-16)", () => {
  const section = async () =>
    (await screen.findByRole("heading", { name: /Ký image/ })).closest(
      "div",
    ) as HTMLElement;

  it("đã bắt buộc: khoá đang ký với dấu vân tay và URI KMS; tắt bắt buộc phải xác nhận ⇒ PUT riêng", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const enforced = withKeys(view(), true);
    const calls: unknown[] = [];
    serve(enforced);
    server.use(
      http.put(
        `${API}/projects/:id/build/signing-enforce`,
        async ({ request }) => {
          calls.push(await request.json());
          return HttpResponse.json(withKeys(view(), false));
        },
      ),
    );
    renderApp(`/app/projects/${detail.project.id}/code`);
    const box = await section();
    expect(within(box).getByText("3f9a1c0b7d2e4a55")).toBeInTheDocument();
    expect(within(box).getByText("Đang ký")).toBeInTheDocument();
    expect(within(box).getByText(KMS)).toBeInTheDocument();
    expect(
      within(box).getByText(
        "Bắt buộc: image không có chữ ký hợp lệ không được deploy.",
      ),
    ).toBeInTheDocument();

    await userEvent.click(
      within(box).getByRole("button", { name: "Tắt bắt buộc" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Tắt bắt buộc chữ ký?",
    });
    expect(calls).toHaveLength(0);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Tắt bắt buộc" }),
    );
    expect(
      await screen.findByText(/Chờ chữ ký hợp lệ đầu tiên/),
    ).toBeInTheDocument();
    expect(calls).toEqual([{ enforce: false }]);
  });

  it("chưa ký được ⇒ nói lý do theo mã; VIEWER không có nút nào", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    serve({
      ...withKeys(view(), false),
      signing: { available: false, reason: "CIRCLECI_AZURE" },
    });
    renderApp(`/app/projects/${detail.project.id}/code`);
    const box = await section();
    expect(
      within(box).getByText(/CircleCI chưa ký được trên Azure/),
    ).toBeInTheDocument();
    for (const name of [/bắt buộc/i, /Gỡ khoá/]) {
      expect(within(box).queryByRole("button", { name })).toBeNull();
    }
    expect(
      within(box).getByRole("switch", { name: "Chữ ký tương thích" }),
    ).toBeDisabled();
  });
});

describe("parseIdentityLine", () => {
  it("dòng của script mới mang khoá ký: tách được URI KMS và khoá công khai; khoá bí mật bị từ chối", () => {
    const line = parseIdentityLine(
      `UDP_BUILD_IDENTITY=${JSON.stringify({
        cloud: "aws",
        roleArn: ROLE,
        signing: { key: KMS, publicKey: KEY },
      })}`,
    );
    expect(line).toEqual({
      cloud: "aws",
      roleArn: ROLE,
      signing: { key: KMS, publicKey: KEY },
    });
    expect(
      parseIdentityLine(
        JSON.stringify({
          cloud: "aws",
          roleArn: ROLE,
          signing: {
            key: KMS,
            publicKey: KEY.replaceAll("PUBLIC", "PRIVATE"),
          },
        }),
      ),
    ).toBeNull();
  });

  it("nhận dòng có tiền tố, giữa nhiều dòng, hay JSON trần; từ chối khoá và cloud lạ", () => {
    const line = `UDP_BUILD_IDENTITY={"cloud":"aws","roleArn":"${ROLE}"}`;
    expect(parseIdentityLine(line)).toEqual({ cloud: "aws", roleArn: ROLE });
    expect(parseIdentityLine(`xong\n${line}\n`)).toEqual({
      cloud: "aws",
      roleArn: ROLE,
    });
    expect(
      parseIdentityLine(
        '{"cloud":"azure","clientId":"11111111-2222-3333-4444-555555555555","tenantId":"66666666-7777-8888-9999-000000000000"}',
      )?.cloud,
    ).toBe("azure");
    expect(
      parseIdentityLine('{"cloud":"aws","roleArn":"AKIAABCDEFGHIJKLMNOP"}'),
    ).toBeNull();
    expect(parseIdentityLine('{"cloud":"oci"}')).toBeNull();
    expect(parseIdentityLine("")).toBeNull();
  });
});
