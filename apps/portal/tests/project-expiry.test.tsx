import type { projectListResponseWire } from "@udp/shared-types/wire";
import type { z } from "zod";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { API, golden, server } from "./msw";
import { renderApp } from "./render";

/**
 * Nhãn hết hạn (Plan #29 P5, §4.4 lớp 3): `WARN` là mặc định của BYOC và máy chủ KHÔNG xoá,
 * nên danh sách project là nơi người dùng thấy TTL đã qua.
 */

type ProjectListResponseWire = z.infer<typeof projectListResponseWire>;

const listWith = (expiresAt: string | null): ProjectListResponseWire => {
  const list = golden<ProjectListResponseWire>("GET /projects");
  const first = list.projects[0];
  if (first === undefined) throw new Error("mẫu golden không có project");
  list.projects = [{ ...first, expiresAt }];
  return list;
};

describe("danh sách project", () => {
  it("TTL đã qua ⇒ nhãn Hết hạn", async () => {
    server.use(
      http.get(`${API}/projects`, () =>
        HttpResponse.json(listWith("2020-01-01T00:00:00.000Z")),
      ),
    );
    renderApp("/app/projects");
    expect(await screen.findByText("Hết hạn")).toBeInTheDocument();
  });

  it("TTL còn xa ⇒ không nhãn", async () => {
    server.use(
      http.get(`${API}/projects`, () =>
        HttpResponse.json(listWith("2099-01-01T00:00:00.000Z")),
      ),
    );
    renderApp("/app/projects");
    await screen.findByRole("list");
    expect(screen.queryByText("Hết hạn")).not.toBeInTheDocument();
  });
});
