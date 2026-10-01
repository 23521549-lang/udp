import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { env } from "@udp/config";
import { createPrismaClient } from "@udp/db";
import { FakeMetricsProvider } from "@udp/metrics-provider/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createFlagServiceClient } from "../src/core/clients/flag-service.client.js";
import { API, testWorld, type Actor, type TestWorld } from "./helpers/api.js";
import {
  noRepoSource,
  inertCloudPlatform,
  inertProvisioning,
  noDomainAdapters,
  outsidePlatform,
  noExternalAuth,
} from "./helpers/inert-deps.js";

/**
 * Plan #41 AC-1 — `GET /projects/:id/stream` trên server HTTP THẬT với cookie phiên thật:
 * `ready` khi mở, `flag_changed` cho ĐÚNG environment vừa tăng `config_version` (mọi lần ghi cấu
 * hình đều tăng nó, ADR-05), và không gì cho project khác. Người ngoài project ⇒ 404 như mọi route.
 */

const admin = createPrismaClient({
  connectionString: env.DATABASE_URL,
  max: 2,
  cacheKey: "__udp_prisma_config_stream_test_admin",
});
const app = createApp({
  metricsFor: () => new FakeMetricsProvider(),
  flagService: createFlagServiceClient({
    baseUrl: "http://127.0.0.1:9",
    secret: env.INTERNAL_SERVICE_SECRET,
  }),
  oidcIssuer: null,
  cloud: inertCloudPlatform,
  repoSource: noRepoSource,
  platform: outsidePlatform,
  auth: noExternalAuth,
  domainRegistry: noDomainAdapters,
  provisioning: inertProvisioning,
});

let server: Server;
let base: string;
let world: TestWorld;
let owner: Actor;
let stranger: Actor;

beforeAll(async () => {
  server = app.listen(0);
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  world = testWorld(app, admin);
  owner = await world.newActor("stream-owner");
  stranger = await world.newActor("stream-stranger");
});

afterAll(async () => {
  server.close();
  await world.cleanup();
  await admin.$disconnect();
});

const cookieOf = (actor: Actor) =>
  actor.cookies.map((c) => c.split(";")[0]).join("; ");

/** Mở luồng, gom sự kiện theo tên cho tới khi `until` đúng hoặc hết hạn */
async function listen(
  actor: Actor,
  projectId: string,
  until: (events: { event: string; data: string }[]) => boolean,
  act: () => Promise<void>,
  timeoutMs = 5_000,
) {
  const controller = new AbortController();
  const res = await fetch(`${base}${API}/projects/${projectId}/stream`, {
    headers: { cookie: cookieOf(actor) },
    signal: controller.signal,
  });
  const events: { event: string; data: string }[] = [];
  if (res.body === null) return { status: res.status, events };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acted = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !until(events)) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 500),
        ),
      ]);
      if (value !== undefined) buffer += decoder.decode(value);
      for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        events.push({ event, data });
      }
      if (!acted && events.some((e) => e.event === "ready")) {
        acted = true;
        // Hub ghi mốc ở vòng đầu; thay đổi phải tới SAU mốc đó
        await new Promise((r) => setTimeout(r, 1_500));
        await act();
      }
      if (done && value === undefined && res.status !== 200) break;
    }
  } finally {
    controller.abort();
  }
  return { status: res.status, events };
}

describe("GET /projects/:id/stream (Plan #41)", () => {
  it("ready khi mở; tăng config_version của dev ⇒ flag_changed cho ĐÚNG dev; project khác im lặng", async () => {
    const { projectId, envs } = await world.newProject(owner);
    const other = await world.newProject(owner);
    const dev = envs.dev as { id: string };

    const { status, events } = await listen(
      owner,
      projectId,
      (e) => e.some((x) => x.event === "flag_changed"),
      async () => {
        await admin.$executeRaw`UPDATE environments SET config_version = config_version + 1 WHERE id IN (${dev.id}::uuid, ${(other.envs.dev as { id: string }).id}::uuid)`;
      },
    );

    expect(status).toBe(200);
    expect(events[0]?.event).toBe("ready");
    const changed = events.filter((e) => e.event === "flag_changed");
    expect(changed).toHaveLength(1);
    expect(JSON.parse(changed[0]?.data ?? "{}")).toEqual({
      environmentId: dev.id,
      configVersion: 1,
    });
  });

  it("người ngoài project ⇒ 404, không mở luồng", async () => {
    const { projectId } = await world.newProject(owner);
    const res = await fetch(`${base}${API}/projects/${projectId}/stream`, {
      headers: { cookie: cookieOf(stranger) },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("event-stream");
  });
});
