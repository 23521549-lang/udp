import type { Client } from "@openfeature/server-sdk";
import { Router } from "express";

/** Flag mẫu — tạo trên Portal (kiểu BOOLEAN) rồi rollout nó để thấy nhãn `ff` trên /metrics */
export const HELLO_FLAG = "hello-v2";

/**
 * Route nghiệp vụ mẫu: đánh giá một flag theo người dùng của request. `targetingKey` là khoá dính
 * (sticky) của phân phối phần trăm — cùng người dùng luôn rơi vào cùng nhánh.
 */
export function helloRouter(flags: Client): Router {
  const router = Router();
  router.get("/hello", (req, res, next) => {
    const user =
      typeof req.query["user"] === "string" ? req.query["user"] : "anonymous";
    flags
      .getBooleanValue(HELLO_FLAG, false, { targetingKey: user })
      .then((v2) => {
        res.json({ message: v2 ? `Xin chào ${user} 👋` : `Chào ${user}`, v2 });
      })
      .catch(next);
  });
  return router;
}
