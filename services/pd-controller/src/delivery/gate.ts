import { env } from "@udp/config";
import type { PrismaClient } from "@udp/db";
import {
  asyncHandler,
  flaggerGateTokenMatches,
  isFlaggerGate,
  logger,
  type FlaggerGate,
} from "@udp/http";
import { decisionSchema, type Decision } from "@udp/shared-types";
import express, { Router } from "express";
import { z } from "zod";
import { metrics } from "../core/metrics.js";

/**
 * Webhook gate của Flagger (§7.3 "udp-driven qua Flagger — dùng webhook gate") [Plan #51 QĐ-9]: Flagger (trong
 * cluster tenant) hỏi Service 3 trước mỗi lần tăng traffic, trước khi promote, và ở mỗi vòng xem có rollback
 * không. 200 = cho đi, mọi mã khác = giữ (ngữ nghĩa của Flagger).
 *
 * Trả lời CHỈ ĐỌC database, không giữ lease: quyết định là của reconciler (`last_decision`, trạng thái session) và
 * của người dùng (intent). Gate chỉ đọc lại chúng — một control loop, không phải hai (ADR-01).
 */

export interface GateState {
  status: "PENDING" | "IN_PROGRESS" | "PAUSED" | "DONE" | "FAILED";
  strategy: "CANARY" | "ATTRIBUTE_SPLIT" | "BLUE_GREEN";
  controlMode: "UDP_DRIVEN" | "TOOL_DRIVEN";
  lastDecision: Decision | null;
  lastStepAt: Date | null;
  stepIntervalSeconds: number;
  /** Có ý định PROMOTE của người dùng (đã hay chưa xử lý) */
  promoteRequested: boolean;
  /** Có ý định ROLLBACK của người dùng */
  rollbackRequested: boolean;
}

export function gateVerdict(
  gate: FlaggerGate,
  s: GateState,
  now: number,
): { open: boolean; reason: string } {
  if (gate === "rollback") {
    if (s.status === "DONE") return { open: false, reason: "rollout đã xong" };
    if (s.status === "FAILED")
      return { open: true, reason: "rollout đã FAILED" };
    if (s.rollbackRequested)
      return { open: true, reason: "người dùng ROLLBACK" };
    return s.lastDecision?.decision === "ROLLBACK"
      ? { open: true, reason: s.lastDecision.reason }
      : { open: false, reason: "không có quyết định rollback" };
  }
  // Session đã xong: UDP không còn điều khiển workload — deploy sau đi qua Flagger như thường (QĐ-10)
  if (s.status === "DONE") return { open: true, reason: "rollout đã xong" };
  if (s.status === "FAILED")
    return { open: false, reason: "rollout đã FAILED" };
  if (s.status === "PAUSED")
    return { open: false, reason: "rollout đang PAUSED" };
  if (s.promoteRequested) return { open: true, reason: "người dùng PROMOTE" };
  if (s.controlMode === "TOOL_DRIVEN") {
    return { open: true, reason: "tool-driven — Flagger tự quyết" };
  }
  if (s.strategy === "ATTRIBUTE_SPLIT") {
    // Không tự quyết (§7.2): promotion chỉ khi người dùng bấm; A/B không có bậc tăng traffic
    return gate === "confirm-promotion"
      ? { open: false, reason: "ATTRIBUTE_SPLIT chờ người dùng PROMOTE" }
      : { open: true, reason: "A/B không có bậc tăng traffic" };
  }
  if (s.lastDecision?.decision !== "PROMOTE") {
    return {
      open: false,
      reason: s.lastDecision?.reason ?? "chưa có phép đo nào",
    };
  }
  const dwellMs = s.stepIntervalSeconds * 1000;
  if (s.lastStepAt !== null && now - s.lastStepAt.getTime() < dwellMs) {
    return { open: false, reason: "chưa đủ thời gian ở bậc hiện tại" };
  }
  return { open: true, reason: s.lastDecision.reason };
}

const bodySchema = z.object({
  metadata: z.object({ token: z.string().min(1) }).passthrough(),
});
const UUID = z.string().uuid();

async function stateOf(
  db: PrismaClient,
  sessionId: string,
): Promise<GateState | null> {
  const session = await db.rolloutSession.findUnique({
    where: { id: sessionId },
    select: {
      rolloutScope: true,
      status: true,
      strategy: true,
      controlMode: true,
      lastDecision: true,
      lastStepAt: true,
      stepIntervalSeconds: true,
    },
  });
  if (session === null || session.rolloutScope !== "SERVICE_LEVEL") return null;
  const intents = await db.rolloutEvent.findMany({
    where: {
      sessionId,
      isIntent: true,
      action: { in: ["PROMOTE", "ROLLBACK"] },
    },
    select: { action: true },
  });
  const decision = decisionSchema.safeParse(session.lastDecision);
  return {
    status: session.status,
    strategy: session.strategy,
    controlMode: session.controlMode,
    lastDecision: decision.success ? decision.data : null,
    lastStepAt: session.lastStepAt,
    stepIntervalSeconds: session.stepIntervalSeconds,
    promoteRequested: intents.some((i) => i.action === "PROMOTE"),
    rollbackRequested: intents.some((i) => i.action === "ROLLBACK"),
  };
}

export function createFlaggerGateRouter(options: {
  db: PrismaClient;
  now?: () => number;
}): Router {
  const now = options.now ?? Date.now;
  const router = Router();
  router.post(
    "/webhooks/flagger/:sessionId/:gate",
    express.json({ limit: "16kb" }),
    asyncHandler(async (req, res) => {
      const sessionId = UUID.safeParse(req.params["sessionId"]);
      const gate = req.params["gate"] ?? "";
      const body = bodySchema.safeParse(req.body);
      // Token sai hay gate lạ: 401 — với Flagger mọi mã khác 200 đều là "giữ", không mở được gì
      if (
        !sessionId.success ||
        !isFlaggerGate(gate) ||
        !body.success ||
        !flaggerGateTokenMatches(
          env.INTERNAL_SERVICE_SECRET,
          sessionId.data,
          body.data.metadata.token,
        )
      ) {
        metrics.flaggerGate.inc({ gate: "invalid", verdict: "denied" });
        res.status(401).json({ open: false });
        return;
      }
      const state = await stateOf(options.db, sessionId.data);
      if (state === null) {
        metrics.flaggerGate.inc({ gate, verdict: "unknown-session" });
        res.status(404).json({ open: false });
        return;
      }
      const verdict = gateVerdict(gate, state, now());
      metrics.flaggerGate.inc({
        gate,
        verdict: verdict.open ? "open" : "closed",
      });
      logger.info(
        { sessionId: sessionId.data, gate, ...verdict },
        "Gate Flagger",
      );
      res.status(verdict.open ? 200 : 403).json(verdict);
    }),
  );
  return router;
}
