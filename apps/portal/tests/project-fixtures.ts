import type { ProjectDetailResponseWire } from "@udp/shared-types/wire";
import { http, HttpResponse } from "msw";
import { API, golden, server } from "./msw";

/** Project mẫu (golden `GET /projects/{id}`) với vai trò của người đang xem */
export function projectFixture(
  role: "OWNER" | "MAINTAINER" | "DEVELOPER" | "VIEWER",
): ProjectDetailResponseWire {
  const detail = golden<ProjectDetailResponseWire>("GET /projects/{id}");
  detail.project.myRole = role;
  return detail;
}

/** Ba lời gọi mà khung project luôn gửi: chi tiết, rollout đang chạy, thành viên */
export function useProjectHandlers(detail: ProjectDetailResponseWire): void {
  server.use(
    http.get(`${API}/projects/:id`, () => HttpResponse.json(detail)),
    http.get(`${API}/projects/:id/rollouts`, () =>
      HttpResponse.json({ rollouts: [] }),
    ),
    http.get(`${API}/projects/:id/members`, () =>
      HttpResponse.json(golden("GET /projects/{id}/members")),
    ),
    // [Plan #45] Thẻ "Deploy gần nhất" của Tổng quan
    http.get(`${API}/projects/:id/deployments/latest`, () =>
      HttpResponse.json(golden("GET /projects/{id}/deployments/latest")),
    ),
  );
}
