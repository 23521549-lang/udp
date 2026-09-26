import type {
  JobDetailWire,
  ProjectDetailResponseWire,
  ProvisionPreviewWire,
} from "@udp/shared-types/wire";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API, golden, server } from "./msw";
import { projectFixture, useProjectHandlers } from "./project-fixtures";
import { renderApp } from "./render";

/**
 * Trang Hạ tầng và bước 4–5 (Plan #28 P6, AC-9). Body lấy từ golden capture của Service 1;
 * luồng SSE là một EventSource giả: Portal chỉ `invalidateQueries` khi nhận sự kiện.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const previewWith = (
  over: Partial<ProvisionPreviewWire>,
): { preview: ProvisionPreviewWire } => {
  const { preview } = golden<{ preview: ProvisionPreviewWire }>(
    "GET /projects/{id}/preview",
  );
  return { preview: { ...preview, ...over } };
};

const jobDetail = (state: JobDetailWire["job"]["state"]): JobDetailWire => {
  const d = golden<JobDetailWire>("GET /projects/{id}/jobs/{id}");
  d.job.state = state;
  d.job.cancellable = ["QUEUED", "NETWORK", "CLUSTER"].includes(state);
  return d;
};

function useInfraHandlers(options: {
  preview?: { preview: ProvisionPreviewWire };
  jobs?: JobDetailWire["job"][];
  job?: () => JobDetailWire;
}) {
  const provisions: { body: unknown; key: string | null }[] = [];
  const cancels: string[] = [];
  let jobReads = 0;
  server.use(
    http.get(`${API}/projects/:id/preview`, () =>
      HttpResponse.json(
        options.preview ?? golden("GET /projects/{id}/preview"),
      ),
    ),
    http.get(`${API}/projects/:id/jobs`, () =>
      HttpResponse.json({ jobs: options.jobs ?? [] }),
    ),
    http.get(`${API}/projects/:id/jobs/:jobId`, () => {
      jobReads += 1;
      return HttpResponse.json(options.job?.() ?? jobDetail("QUEUED"));
    }),
    http.post(`${API}/projects/:id/provision`, async ({ request }) => {
      provisions.push({
        body: await request.json(),
        key: request.headers.get("Idempotency-Key"),
      });
      return HttpResponse.json(golden("POST /projects/{id}/provision"), {
        status: 202,
      });
    }),
    http.post(`${API}/projects/:id/jobs/:jobId/cancel`, ({ params }) => {
      cancels.push(String(params.jobId));
      return HttpResponse.json(golden("POST /projects/{id}/jobs/{id}/cancel"), {
        status: 202,
      });
    }),
  );
  return { provisions, cancels, jobReads: () => jobReads };
}

const infraUrl = (detail: ProjectDetailResponseWire) =>
  `/app/projects/${detail.project.id}/infra`;

describe("trang Hạ tầng", () => {
  it("OWNER: ba mục chi phí bắt buộc + thứ tự dựng; phải tích xác nhận con số rồi mới triển khai", async () => {
    const detail = projectFixture("OWNER");
    detail.project.status = "DRAFT";
    useProjectHandlers(detail);
    const preview = previewWith({ blockers: [] });
    const calls = useInfraHandlers({ preview });
    renderApp(infraUrl(detail));

    const costs = await screen.findByRole("table", {
      name: "Chi phí ước tính mỗi tháng",
    });
    for (const item of ["Control plane", "NAT gateway", "Load balancer"]) {
      expect(within(costs).getByText(item)).toBeInTheDocument();
    }
    expect(
      within(
        screen.getByRole("list", { name: "Thứ tự dựng tài nguyên" }),
      ).getAllByRole("listitem")[0],
    ).toHaveTextContent("vpc");

    const start = screen.getByRole("button", { name: /Bắt đầu triển khai/ });
    expect(start).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(start);

    await waitFor(() => expect(calls.provisions).toHaveLength(1));
    expect(calls.provisions[0]?.body).toEqual({
      confirmedMonthlyUsd: preview.preview.cost.monthlyUsd,
    });
    expect(calls.provisions[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByRole("region", { name: "Tiến độ triển khai" }),
    ).toBeInTheDocument();
  });

  it("lý do chặn hiện thành câu, nút triển khai khoá", async () => {
    const detail = projectFixture("OWNER");
    detail.project.status = "DRAFT";
    useProjectHandlers(detail);
    useInfraHandlers({
      preview: previewWith({ blockers: ["cloud-not-validated"] }),
    });
    renderApp(infraUrl(detail));
    const note = await screen.findByRole("status", {
      name: "Chưa triển khai được",
    });
    expect(note).toHaveTextContent("Credential cloud chưa được kiểm");
    expect(
      screen.getByRole("button", { name: /Bắt đầu triển khai/ }),
    ).toBeDisabled();
  });

  it("MAINTAINER xem được chi phí nhưng không có nút triển khai", async () => {
    const detail = projectFixture("MAINTAINER");
    detail.project.status = "DRAFT";
    useProjectHandlers(detail);
    useInfraHandlers({ preview: previewWith({ blockers: [] }) });
    renderApp(infraUrl(detail));
    await screen.findByRole("table", { name: "Chi phí ước tính mỗi tháng" });
    expect(
      screen.queryByRole("button", { name: /Bắt đầu triển khai/ }),
    ).not.toBeInTheDocument();
  });
});

describe("chi phí thực tế (Plan #38)", () => {
  function useCostHandlers(status = 200) {
    const asked: string[] = [];
    server.use(
      http.get(`${API}/projects/:id/cost`, ({ request }) => {
        asked.push(new URL(request.url).searchParams.get("days") ?? "");
        return status === 200
          ? HttpResponse.json(golden("GET /projects/{id}/cost"))
          : HttpResponse.json(
              {
                type: "https://udp.dev/problems/cost-not-enabled",
                title: "CONFLICT",
                status: 409,
              },
              { status: 409 },
            );
      }),
    );
    return asked;
  }

  it("project đang chạy, MAINTAINER: bảng chi phí theo environment; đổi cửa sổ ⇒ hỏi lại với days mới", async () => {
    const detail = projectFixture("MAINTAINER");
    detail.project.status = "ACTIVE";
    useProjectHandlers(detail);
    useInfraHandlers({});
    const asked = useCostHandlers();
    renderApp(infraUrl(detail));
    const table = await screen.findByRole("table", {
      name: "Chi phí theo environment",
    });
    expect(within(table).getByText("prod")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "30 ngày" }));
    await waitFor(() => expect(asked).toContain("30"));
    expect(asked).toContain("7");
  });

  it("chưa bật Cost ⇒ hướng dẫn bật, không phải lỗi; VIEWER không thấy thẻ", async () => {
    const detail = projectFixture("MAINTAINER");
    detail.project.status = "ACTIVE";
    useProjectHandlers(detail);
    useInfraHandlers({});
    useCostHandlers(409);
    const { unmount } = renderApp(infraUrl(detail));
    expect(
      await screen.findByText("Chưa bật Cost Management"),
    ).toBeInTheDocument();
    unmount();

    const viewer = projectFixture("VIEWER");
    viewer.project.status = "ACTIVE";
    useProjectHandlers(viewer);
    renderApp(infraUrl(viewer));
    await screen.findByRole("heading", { name: "Hạ tầng" });
    expect(screen.queryByText("Chi phí thực tế")).not.toBeInTheDocument();
  });
});

describe("tiến độ job", () => {
  it("SSE snapshot ⇒ đọc lại job; tới trạng thái cuối ⇒ đóng luồng", async () => {
    const detail = projectFixture("VIEWER");
    detail.project.status = "PROVISIONING";
    useProjectHandlers(detail);
    let state: JobDetailWire["job"]["state"] = "NETWORK";
    const running = jobDetail("NETWORK");
    const calls = useInfraHandlers({
      jobs: [running.job],
      job: () => jobDetail(state),
    });
    renderApp(infraUrl(detail));

    expect(
      await screen.findByText("Dựng mạng", { selector: ".chip.soft" }),
    ).toBeInTheDocument();
    // Khung project cũng mở luồng cấu hình của nó (Plan #41) — ở đây chỉ xét luồng job
    const jobStreams = () =>
      FakeEventSource.instances.filter((s) => s.url.includes("/jobs/"));
    await waitFor(() => expect(jobStreams()).toHaveLength(1));
    const source = jobStreams()[0];
    expect(source?.url).toContain(`/jobs/${running.job.id}/stream`);
    expect(
      screen.queryByRole("button", { name: "Hủy triển khai" }),
    ).not.toBeInTheDocument();

    const before = calls.jobReads();
    state = "DONE";
    source?.emit("snapshot", jobDetail("DONE"));
    expect(
      await screen.findByText("Hoàn tất", { selector: ".chip.soft" }),
    ).toBeInTheDocument();
    expect(calls.jobReads()).toBeGreaterThan(before);
    expect(source?.closed).toBe(true);
  });

  it("OWNER hủy: hộp xác nhận rồi mới gửi", async () => {
    const detail = projectFixture("OWNER");
    detail.project.status = "PROVISIONING";
    useProjectHandlers(detail);
    const job = jobDetail("CLUSTER");
    const calls = useInfraHandlers({ jobs: [job.job], job: () => job });
    renderApp(infraUrl(detail));

    await userEvent.click(
      await screen.findByRole("button", { name: "Hủy triển khai" }),
    );
    expect(calls.cancels).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Hủy và dọn" }));
    await waitFor(() => expect(calls.cancels).toEqual([job.job.id]));
  });
});
