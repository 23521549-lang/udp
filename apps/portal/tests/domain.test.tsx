import type {
  DomainValidationWire,
  JobDetailWire,
  ProjectDetailResponseWire,
  ProjectDomainWire,
  ProjectDomainsResponseWire,
  PutDomainsResponseWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  chooseTool,
  draftFrom,
  setEnabled,
  targetOf,
} from "../src/features/domain/domain-model";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * Trang Domain (Plan #27 P3, AC-7). Catalog, cấu hình và kết quả kiểm đều từ golden capture
 * của Service 1 — catalog là của registry THẬT (datadog, prometheus-grafana).
 */

const savedWith = (enabled: boolean): ProjectDomainsResponseWire => {
  const saved = golden<ProjectDomainsResponseWire>(
    "GET /projects/{id}/domains",
  );
  saved.domains = saved.domains.map((d) =>
    d.domainType === "MONITORING" ? { ...d, isEnabled: enabled } : d,
  );
  return saved;
};

function useDomainHandlers(options: {
  saved: ProjectDomainsResponseWire;
  validation?: DomainValidationWire;
  putStatus?: number;
  /** Project ĐANG chạy: PUT trả 202 kèm job DOMAIN_APPLY (mẫu golden) */
  running?: boolean;
}) {
  const puts: unknown[] = [];
  let validations = 0;
  server.use(
    http.get(`${API}/domains/catalog`, () =>
      HttpResponse.json(golden("GET /domains/catalog")),
    ),
    http.get(`${API}/projects/:id/domains`, () =>
      HttpResponse.json(options.saved),
    ),
    http.post(`${API}/projects/:id/domains/validate`, () => {
      validations += 1;
      return HttpResponse.json(
        options.validation === undefined
          ? golden("POST /projects/{id}/domains/validate")
          : { validation: options.validation },
      );
    }),
    http.put(`${API}/projects/:id/domains`, async ({ request }) => {
      puts.push(await request.json());
      return options.putStatus === 409
        ? HttpResponse.json(
            {
              type: "https://udp.dev/problems/optimistic-lock",
              title: "Resource was modified by someone else",
              status: 409,
              code: "OPTIMISTIC_LOCK",
              traceId: "t",
            },
            { status: 409 },
          )
        : options.running === true
          ? HttpResponse.json(golden("PUT /projects/{id}/domains"), {
              status: 202,
            })
          : HttpResponse.json({
              ...golden<PutDomainsResponseWire>("PUT /projects/{id}/domains"),
              job: null,
            });
    }),
    http.get(`${API}/projects/:id/jobs/:jobId`, () => {
      const d = golden<JobDetailWire>("GET /projects/{id}/jobs/{id}");
      d.job.jobType = "DOMAIN_APPLY";
      return HttpResponse.json(d);
    }),
  );
  return { puts, validationCount: () => validations };
}

const domainsUrl = (detail: ProjectDetailResponseWire) =>
  `/app/projects/${detail.project.id}/domains`;

describe("trang Domain", () => {
  it("MAINTAINER: bật Monitoring ⇒ form dựng từ schema của adapter, kiểm trực tiếp, lưu cả tập", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const saved = savedWith(false);
    const { puts } = useDomainHandlers({ saved });
    renderApp(domainsUrl(detail));

    await userEvent.click(
      await screen.findByRole("switch", { name: "Bật Monitoring" }),
    );
    // Trường của datadog: enum `site`, hai khoá bí mật, số `maxHosts` mặc định 50
    expect(screen.getByLabelText("site *")).toBeInTheDocument();
    expect(screen.getByLabelText("maxHosts")).toHaveValue(50);

    const status = await screen.findByRole("status", { name: "Kiểm cấu hình" });
    expect(within(status).getByText(/Cấu hình hợp lệ/)).toBeInTheDocument();
    expect(within(status).getByText(/traces.sink/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Lưu cấu hình domain" }),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      lastKnownDomainSetVersion: saved.domainSetVersion,
      domains: [{ domainType: "MONITORING", toolId: "datadog" }],
      preferences: saved.preferences,
    });
  });

  it("ô bí mật: 'Đã lưu' thay cho giá trị; Đổi ⇒ gửi khoá mới, Giữ khoá cũ ⇒ gửi lại giữ chỗ (Plan #31)", async () => {
    const NEW_KEY = "0123456789abcdef0123456789abcdef";
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const { puts } = useDomainHandlers({ saved: savedWith(true) });
    renderApp(domainsUrl(detail));

    // Đã lưu: chỉ có nút "Đổi", không một ô nào mang giá trị
    await userEvent.click(await screen.findByLabelText("apiKey *"));
    const apiKey = screen.getByLabelText("apiKey *");
    expect(apiKey).toHaveAttribute("type", "password");
    await userEvent.type(apiKey, NEW_KEY);

    await userEvent.click(screen.getByLabelText("appKey *"));
    await userEvent.click(
      screen.getByRole("button", { name: "Giữ khoá cũ của appKey" }),
    );
    expect(screen.getByLabelText("appKey *")).toHaveTextContent("Đổi");
    expect(screen.queryByText(NEW_KEY)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Lưu cấu hình domain" }),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toMatchObject({
      domains: [
        {
          domainType: "MONITORING",
          config: { apiKey: NEW_KEY, appKey: { $udpSecret: "kept" } },
        },
      ],
    });
  });

  it("lỗi MISSING_CAPABILITY có nút Bật đúng tool gợi ý", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useDomainHandlers({
      saved: savedWith(false),
      validation: {
        valid: false,
        errors: [
          {
            code: "MISSING_CAPABILITY",
            subject: "monitoring:prometheus-grafana",
            detail: ["registry.oci"],
            suggestedAction: {
              type: "ENABLE_DOMAIN",
              domainType: "MONITORING",
              toolId: "datadog",
            },
          },
        ],
        warnings: [],
        deployOrder: null,
      },
    });
    renderApp(domainsUrl(detail));
    await userEvent.click(
      await screen.findByRole("switch", { name: "Bật Monitoring" }),
    );
    expect(
      await screen.findByText(
        /prometheus-grafana \(Monitoring\) cần registry.oci/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bật datadog" }),
    ).toBeInTheDocument();
  });

  it("lỗi CLOUD_MISMATCH nói cloud nào và có nút Đổi sang tool đúng cloud (Plan #37)", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useDomainHandlers({
      saved: savedWith(false),
      validation: {
        valid: false,
        errors: [
          {
            code: "CLOUD_MISMATCH",
            subject: "monitoring:prometheus-grafana",
            detail: ["AWS", "GCP"],
            suggestedAction: {
              type: "SWITCH_TOOL",
              domainType: "MONITORING",
              toolId: "datadog",
            },
          },
        ],
        warnings: [],
        deployOrder: null,
      },
    });
    renderApp(domainsUrl(detail));
    await userEvent.click(
      await screen.findByRole("switch", { name: "Bật Monitoring" }),
    );
    expect(
      await screen.findByText(/chỉ chạy trên AWS, còn project dùng GCP/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Đổi sang datadog" }),
    ).toBeInTheDocument();
  });

  it("409 khi lưu ⇒ báo người khác vừa lưu và tải lại bản mới", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useDomainHandlers({ saved: savedWith(false), putStatus: 409 });
    renderApp(domainsUrl(detail));
    await userEvent.click(
      await screen.findByRole("switch", { name: "Bật Monitoring" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu cấu hình domain" }),
    );
    expect(await screen.findByText(/người khác sửa/)).toBeInTheDocument();
  });

  it("VIEWER: chỉ xem, không kiểm, không lưu", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    const { validationCount } = useDomainHandlers({ saved: savedWith(true) });
    renderApp(domainsUrl(detail));
    expect(
      await screen.findByRole("switch", { name: "Bật Monitoring" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Lưu cấu hình domain" }),
    ).toBeNull();
    expect(validationCount()).toBe(0);
  });

  it("domain chưa có công cụ nói đúng điều đó", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useDomainHandlers({ saved: savedWith(true) });
    renderApp(domainsUrl(detail));
    expect(
      (await screen.findAllByText("Chưa có công cụ nào cho domain này."))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe("project đang chạy (Plan #30)", () => {
  it("lưu ⇒ tiến độ áp cấu hình hiện ngay; bảng vẫn là cấu hình đang chạy", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const { puts } = useDomainHandlers({
      saved: savedWith(false),
      running: true,
    });
    renderApp(domainsUrl(detail));

    await userEvent.click(
      await screen.findByRole("switch", { name: "Bật Monitoring" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Lưu cấu hình domain" }),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(
      await screen.findByRole("region", { name: "Đang áp cấu hình domain" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("region", { name: "Tiến độ triển khai" }),
    ).toBeInTheDocument();
  });
});

function useDetailHandlers(adapterVersion: string) {
  const upgrades: unknown[] = [];
  let scans = 0;
  server.use(
    http.get(`${API}/domains/catalog`, () =>
      HttpResponse.json(golden("GET /domains/catalog")),
    ),
    http.get(`${API}/projects/:id/domains/MONITORING`, () => {
      const d = golden<{ domain: ProjectDomainWire }>(
        "GET /projects/{id}/domains/MONITORING",
      );
      d.domain = { ...d.domain, isEnabled: true, adapterVersion };
      return HttpResponse.json(d);
    }),
    http.get(`${API}/projects/:id/domains/MONITORING/drift`, () =>
      HttpResponse.json({
        drift: { verdict: "CLEAN", message: null, at: null },
      }),
    ),
    http.post(`${API}/projects/:id/domains/MONITORING/drift`, () => {
      scans += 1;
      return HttpResponse.json(
        golden("POST /projects/{id}/domains/MONITORING/drift"),
      );
    }),
    http.post(
      `${API}/projects/:id/domains/MONITORING/upgrade`,
      async ({ request }) => {
        upgrades.push(await request.json());
        return HttpResponse.json(
          golden("POST /projects/{id}/domains/MONITORING/upgrade"),
          { status: 202 },
        );
      },
    ),
    http.get(`${API}/projects/:id/jobs/:jobId`, () =>
      HttpResponse.json(golden("GET /projects/{id}/jobs/{id}")),
    ),
  );
  return { upgrades, scanCount: () => scans };
}

describe("thao tác Day-2 ở chi tiết domain", () => {
  it("MAINTAINER: quét ngay ⇒ phán quyết mới thay kết quả cũ", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const calls = useDetailHandlers("1.0.0");
    renderApp(`${domainsUrl(detail)}/MONITORING`);

    await userEvent.click(
      await screen.findByRole("button", { name: /Quét drift ngay/ }),
    );
    await waitFor(() => expect(calls.scanCount()).toBe(1));
    const result = await screen.findByRole("status", { name: "Kết quả drift" });
    expect(within(result).getByText(/Đã trôi/)).toBeInTheDocument();
  });

  it("bản đang chạy cũ hơn registry ⇒ nút nâng cấp; production đòi gõ tên domain rồi hiện tiến độ", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const calls = useDetailHandlers("0.9.0");
    renderApp(`${domainsUrl(detail)}/MONITORING`);

    await userEvent.click(
      await screen.findByRole("button", { name: /Nâng cấp lên 1.0.0/ }),
    );
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Nâng cấp" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox"), "MONITORING");
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(calls.upgrades).toEqual([{ confirm: "MONITORING" }]),
    );
    expect(
      await screen.findByRole("region", { name: "Tiến độ triển khai" }),
    ).toBeInTheDocument();
  });

  it("bản đang chạy đã mới nhất ⇒ không có nút nâng cấp; VIEWER không có thao tác nào", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useDetailHandlers("1.0.0");
    renderApp(`${domainsUrl(detail)}/MONITORING`);
    await screen.findByRole("button", { name: /Quét drift ngay/ });
    expect(
      screen.queryByRole("button", { name: /Nâng cấp/ }),
    ).not.toBeInTheDocument();
  });
});

describe("chi tiết domain", () => {
  it("drift: hiện CHỖ trôi mà lượt quét ghi, không chỉ huy hiệu", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    server.use(
      http.get(`${API}/projects/:id/domains/MONITORING`, () =>
        HttpResponse.json(golden("GET /projects/{id}/domains/MONITORING")),
      ),
      http.get(`${API}/projects/:id/domains/MONITORING/drift`, () =>
        HttpResponse.json(
          golden("GET /projects/{id}/domains/MONITORING/drift"),
        ),
      ),
    );
    renderApp(`${domainsUrl(detail)}/MONITORING`);
    const result = await screen.findByRole("status", { name: "Kết quả drift" });
    expect(within(result).getByText(/Đã trôi/)).toBeInTheDocument();
    expect(within(result).getByText(/retention 15d/)).toBeInTheDocument();
  });
});

describe("webhook CI/CD ở chi tiết domain (Plan #36)", () => {
  /** Chi tiết domain CICD dựng từ mẫu MONITORING — cùng hình, đổi domain và tool */
  function useCicdHandlers(secretSet: boolean) {
    const one = golden<{ domain: ProjectDomainWire }>(
      "GET /projects/{id}/domains/MONITORING",
    );
    one.domain = {
      ...one.domain,
      domainType: "CICD",
      selectedTool: "github-actions",
      isEnabled: true,
    };
    const status = golden<{ cicd: { secretSet: boolean } }>(
      "GET /projects/{id}/domains/CICD/webhook",
    );
    status.cicd.secretSet = secretSet;
    const rotated = golden<{ secret: string }>(
      "POST /projects/{id}/domains/CICD/webhook-secret",
    );
    let posts = 0;
    server.use(
      http.get(`${API}/domains/catalog`, () =>
        HttpResponse.json(golden("GET /domains/catalog")),
      ),
      http.get(`${API}/projects/:id/domains/CICD`, () =>
        HttpResponse.json(one),
      ),
      http.get(`${API}/projects/:id/domains/CICD/drift`, () =>
        HttpResponse.json(
          golden("GET /projects/{id}/domains/MONITORING/drift"),
        ),
      ),
      http.get(`${API}/projects/:id/domains/CICD/webhook`, () =>
        HttpResponse.json(
          posts > 0 ? { cicd: { ...status.cicd, secretSet: true } } : status,
        ),
      ),
      http.post(`${API}/projects/:id/domains/CICD/webhook-secret`, () => {
        posts += 1;
        return HttpResponse.json(rotated);
      }),
      http.get(`${API}/projects/:id/domains/CICD/pipeline-template`, () =>
        HttpResponse.json(
          golden("GET /projects/{id}/domains/CICD/pipeline-template"),
        ),
      ),
    );
    return { secret: rotated.secret, posts: () => posts };
  }

  it("MAINTAINER: địa chỉ webhook đầy đủ; sinh secret ⇒ hiện MỘT lần trong hộp, đóng là mất", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    const calls = useCicdHandlers(false);
    renderApp(`${domainsUrl(detail)}/CICD`);

    const url = await screen.findByLabelText("Địa chỉ webhook");
    expect(url.textContent).toMatch(
      /^http:\/\/localhost(:\d+)?\/api\/v1\/webhooks\/cicd\/.+\/github-actions$/,
    );
    expect(screen.getByText(/Chưa sinh/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sinh secret" }));
    const ask = await screen.findByRole("dialog");
    await userEvent.click(
      within(ask).getByRole("button", { name: "Sinh secret" }),
    );
    const shown = await screen.findByLabelText("Giá trị secret webhook");
    expect(shown.textContent).toBe(calls.secret);
    expect(calls.posts()).toBe(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Đã lưu secret" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(calls.secret)).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByText(/Đã sinh \(không xem lại được\)/),
    ).toBeInTheDocument();
  });

  it("secret đã có ⇒ nút xoay, hộp cảnh báo CI cũ nhận 401 trước khi bấm", async () => {
    const detail = projectFixture("MAINTAINER");
    useProjectHandlers(detail);
    useCicdHandlers(true);
    renderApp(`${domainsUrl(detail)}/CICD`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Xoay secret" }),
    );
    const ask = await screen.findByRole("dialog");
    expect(within(ask).getByText(/nhận 401/)).toBeInTheDocument();
  });

  it("DEVELOPER: xem được template, không sinh được secret", async () => {
    const detail = projectFixture("DEVELOPER");
    useProjectHandlers(detail);
    useCicdHandlers(false);
    renderApp(`${domainsUrl(detail)}/CICD`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Xem template pipeline" }),
    );
    const template = await screen.findByLabelText(
      "Template pipeline github-actions",
    );
    expect(template.textContent).toContain("X-Hub-Signature-256");
    expect(
      screen.queryByRole("button", { name: /Sinh secret|Xoay secret/ }),
    ).not.toBeInTheDocument();
  });

  it("VIEWER: chỉ thấy địa chỉ và trạng thái", async () => {
    const detail = projectFixture("VIEWER");
    useProjectHandlers(detail);
    useCicdHandlers(false);
    renderApp(`${domainsUrl(detail)}/CICD`);
    await screen.findByLabelText("Địa chỉ webhook");
    expect(
      screen.queryByRole("button", { name: /secret|template/ }),
    ).not.toBeInTheDocument();
  });
});

describe("catalog quản trị", () => {
  it("liệt kê domain và công cụ registry đã nạp", async () => {
    server.use(
      http.get(`${API}/domains/catalog`, () =>
        HttpResponse.json(golden("GET /domains/catalog")),
      ),
    );
    renderApp("/admin/catalog", {
      user: {
        id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
        email: "admin@udp.local",
        name: "Admin",
        platformRole: "PLATFORM_ADMIN",
      },
    });
    const table = await screen.findByRole("table", { name: "Catalog domain" });
    expect(within(table).getByText(/datadog 1.0.0/)).toBeInTheDocument();
  });
});

describe("mô hình bản nháp (thuần)", () => {
  const catalog = golden<{ domains: Parameters<typeof draftFrom>[0] }>(
    "GET /domains/catalog",
  ).domains;
  const monitoring = catalog.find((c) => c.domainType === "MONITORING");

  it("trạng thái đích chỉ gồm domain bật; đổi tool về cấu hình mặc định của tool mới", () => {
    if (monitoring === undefined)
      throw new Error("catalog mẫu thiếu MONITORING");
    const draft = draftFrom(catalog, savedWith(true));
    expect(targetOf(draft).domains.map((d) => d.toolId)).toEqual(["datadog"]);
    expect(targetOf(setEnabled(draft, "MONITORING", false)).domains).toEqual(
      [],
    );
    const switched = chooseTool(draft, monitoring, "prometheus-grafana");
    expect(switched.entries.MONITORING?.config).toEqual({
      dashboards: true,
      storageGb: 20,
    });
  });
});
