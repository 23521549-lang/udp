import { randomUUID } from "node:crypto";
import { env } from "@udp/config";
import { flaggerGateToken, type FlaggerGate } from "@udp/http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { gateVerdict, type GateState } from "../src/delivery/gate.js";
import {
  admin,
  dropProject,
  newIntent,
  newProject,
  newServiceSession,
} from "./helpers/fixture.js";

/**
 * Webhook gate của Flagger (§7.3) [Plan #51 AC-6, QĐ-9] — bảng phán quyết, và router qua HTTP thật trên database
 * thật: token của ĐÚNG session, trả lời chỉ đọc trạng thái mà reconciler và người dùng đã ghi.
 */

const NOW = Date.parse("2026-09-29T12:00:00Z");

const state = (over: Partial<GateState> = {}): GateState => ({
  status: "IN_PROGRESS",
  strategy: "CANARY",
  controlMode: "UDP_DRIVEN",
  lastDecision: {
    decision: "PROMOTE",
    reason: "ổn",
    at: NOW,
    breach: false,
    breachStreak: 0,
    breachAt: null,
    metricSnapshot: null,
    detail: { code: "WITHIN_THRESHOLDS" },
  },
  lastStepAt: null,
  stepIntervalSeconds: 300,
  promoteRequested: false,
  rollbackRequested: false,
  ...over,
});

const open = (gate: FlaggerGate, s: GateState) =>
  gateVerdict(gate, s, NOW).open;

describe("gateVerdict", () => {
  it("udp-driven CANARY: tăng traffic khi phân tích PROMOTE VÀ đủ dwell; HOLD hay chưa đủ dwell ⇒ giữ", () => {
    expect(open("confirm-traffic-increase", state())).toBe(true);
    expect(
      open(
        "confirm-traffic-increase",
        state({ lastStepAt: new Date(NOW - 60_000) }),
      ),
    ).toBe(false);
    const hold = state();
    hold.lastDecision = { ...hold.lastDecision!, decision: "HOLD" };
    expect(open("confirm-promotion", hold)).toBe(false);
  });

  it("rollback mở khi FAILED, khi người dùng ROLLBACK, khi phân tích ROLLBACK; không bao giờ khi DONE", () => {
    expect(open("rollback", state())).toBe(false);
    expect(open("rollback", state({ status: "FAILED" }))).toBe(true);
    expect(open("rollback", state({ rollbackRequested: true }))).toBe(true);
    const breach = state();
    breach.lastDecision = { ...breach.lastDecision!, decision: "ROLLBACK" };
    expect(open("rollback", breach)).toBe(true);
    expect(
      open("rollback", state({ status: "DONE", rollbackRequested: true })),
    ).toBe(false);
  });

  it("ATTRIBUTE_SPLIT không tự quyết: promotion CHỈ khi người dùng PROMOTE; PAUSED giữ mọi gate xác nhận; DONE thả", () => {
    const ab = state({ strategy: "ATTRIBUTE_SPLIT" });
    expect(open("confirm-promotion", ab)).toBe(false);
    expect(open("confirm-promotion", { ...ab, promoteRequested: true })).toBe(
      true,
    );
    expect(open("confirm-traffic-increase", state({ status: "PAUSED" }))).toBe(
      false,
    );
    expect(open("confirm-promotion", state({ status: "DONE" }))).toBe(true);
    expect(open("confirm-promotion", state({ status: "FAILED" }))).toBe(false);
  });
});

describe("POST /webhooks/flagger/:sessionId/:gate", () => {
  let project: Awaited<ReturnType<typeof newProject>>;
  const app = createApp();
  const call = (sessionId: string, gate: string, token: string) =>
    request(app).post(`/webhooks/flagger/${sessionId}/${gate}`).send({
      name: "web",
      namespace: "ns",
      phase: "Progressing",
      metadata: { token },
    });
  const tokenOf = (id: string) =>
    flaggerGateToken(env.INTERNAL_SERVICE_SECRET, id);

  beforeAll(async () => {
    project = await newProject();
  }, 60_000);

  afterAll(async () => {
    await dropProject(project.projectId);
  });

  it("token của đúng session ⇒ phán quyết từ database; token session khác ⇒ 401; session lạ ⇒ 404", async () => {
    const id = await newServiceSession(project, { status: "IN_PROGRESS" });
    // Chưa có phép đo nào ⇒ giữ
    await call(id, "confirm-traffic-increase", tokenOf(id)).expect(403);
    await admin.rolloutSession.update({
      where: { id },
      data: { lastDecision: state().lastDecision! },
    });
    const opened = await call(
      id,
      "confirm-traffic-increase",
      tokenOf(id),
    ).expect(200);
    expect(opened.body).toMatchObject({ open: true });

    await call(id, "confirm-traffic-increase", tokenOf(randomUUID())).expect(
      401,
    );
    await call(id, "pre-rollout", tokenOf(id)).expect(401);
    const stranger = randomUUID();
    await call(stranger, "rollback", tokenOf(stranger)).expect(404);

    await call(id, "rollback", tokenOf(id)).expect(403);
    await newIntent(id, "ROLLBACK", project.ownerId);
    await call(id, "rollback", tokenOf(id)).expect(200);
  });
});
