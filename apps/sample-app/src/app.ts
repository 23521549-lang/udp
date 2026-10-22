import type { Client } from "@openfeature/server-sdk";
import { udpMetricsMiddleware } from "@udp/openfeature-provider/metrics";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from "express";
import type { Registry } from "prom-client";
import { z } from "zod";
import type { Branch, ChaosState } from "./chaos.js";
import type { RolloutObserver } from "./observer.js";
import type { Timeline } from "./timeline.js";

/**
 * Ứng dụng khách mẫu (§11 Golden Path, §13.4) [v4.8] — hiện thực tham chiếu của
 * cách một ứng dụng dùng UDP: provider OpenFeature (hook nhãn `ff` tự gắn),
 * `udpMetricsMiddleware` bọc mọi route nghiệp vụ, `/metrics` cho Prometheus.
 *
 * `/healthz`, `/metrics` và `/chaos/*` đăng ký TRƯỚC middleware đo: chúng không
 * phải lưu lượng người dùng — đếm chúng là làm bẩn tỉ lệ lỗi mà Service 3 phân
 * tích và số route R của E14, và đo chính công cụ đo.
 */

export interface AppDeps {
  client: Client;
  registry: Registry;
  chaos: ChaosState;
  observer: RolloutObserver;
  timeline: Timeline;
  checkoutFlagKey: string;
  chaosEnabled: boolean;
  serviceName: string;
}

const PRODUCTS = Array.from({ length: 10 }, (_, i) => ({
  id: `p-${String(i + 1)}`,
  name: `Sản phẩm ${String(i + 1)}`,
  price: (i + 1) * 10_000,
}));

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const faultQuery = z.object({
  scope: z.enum(["flag-on", "shared"]).default("flag-on"),
});

function chaosRouter(deps: AppDeps): Router {
  const router = express.Router();
  const turnedOn = async (res: Response): Promise<void> => {
    const cohort = await deps.observer.captureCohort();
    res.json({ ...deps.chaos.describe(), cohort });
  };

  router.post("/error-rate", (req, res, next) => {
    const parsed = faultQuery
      .extend({ p: z.coerce.number().min(0).max(1) })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }
    deps.chaos.setErrorRate(parsed.data.p, parsed.data.scope);
    turnedOn(res).catch(next);
  });

  router.post("/latency", (req, res, next) => {
    const parsed = faultQuery
      .extend({
        ms: z.coerce.number().int().min(0).max(60_000),
        rampSeconds: z.coerce.number().int().min(0).max(3_600).default(0),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message });
      return;
    }
    const { ms, rampSeconds, scope } = parsed.data;
    deps.chaos.setLatency(ms, rampSeconds, scope);
    turnedOn(res).catch(next);
  });

  router.post("/reset", (_req, res) => {
    deps.chaos.reset();
    res.json(deps.chaos.describe());
  });

  /** Phiên đo mới: xoá dòng thời gian và blast radius */
  router.post("/session", (_req, res) => {
    deps.chaos.clearSession();
    res.json(deps.chaos.describe());
  });

  router.get("/timeline", (_req, res) => {
    res.json({ ...deps.chaos.describe(), events: deps.timeline.list() });
  });

  return router;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/metrics", (_req, res, next) => {
    deps.registry
      .metrics()
      .then((text) => {
        res.set("Content-Type", deps.registry.contentType);
        res.end(text);
      })
      .catch(next);
  });

  if (deps.chaosEnabled) {
    app.use("/chaos", chaosRouter(deps));
  } else {
    // Tắt mặc định: một ứng dụng thật không bao giờ phơi công cụ bơm lỗi
    app.use("/chaos", (_req, res) => {
      res.status(404).json({ error: "chaos đang tắt (CHAOS_ENABLED=false)" });
    });
  }

  app.use(
    udpMetricsMiddleware({
      registry: deps.registry,
      serviceName: deps.serviceName,
    }),
  );
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/products", (_req, res) => {
    res.json({ items: PRODUCTS });
  });

  app.get("/api/products/:id", (req, res) => {
    const product = PRODUCTS.find((p) => p.id === req.params["id"]);
    if (product === undefined) {
      res.status(404).json({ error: "không có sản phẩm" });
      return;
    }
    res.json(product);
  });

  /**
   * Luồng thanh toán — nhánh `on` của flag canary là "code mới". `x-user-id` là
   * `targetingKey`: canary theo hash cần định danh ổn định (§6.4).
   */
  app.post("/api/checkout", (req, res, next) => {
    const userId = req.get("x-user-id");
    if (userId === undefined || userId.length === 0) {
      res.status(400).json({ error: "thiếu header x-user-id" });
      return;
    }
    const handle = async (): Promise<void> => {
      const useNew = await deps.client.getBooleanValue(
        deps.checkoutFlagKey,
        false,
        { targetingKey: userId },
      );
      const branch: Branch = useNew ? "on" : "off";
      const decision = deps.chaos.decide(branch);
      if (decision.delayMs > 0) await sleep(decision.delayMs);
      deps.chaos.recordServed(branch, decision.fail);
      if (decision.fail) {
        res.status(500).json({ error: "thanh toán lỗi (chaos)" });
        return;
      }
      res.json({
        orderId: `o-${Date.now().toString(36)}`,
        algorithm: useNew ? "v2" : "v1",
      });
    };
    handle().catch(next);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "không có route" });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "lỗi" });
  });
  return app;
}
