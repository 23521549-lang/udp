import type { Server, ServerResponse } from "node:http";
import type { Express, RequestHandler } from "express";
import { notFoundHandler } from "./error-handler.js";

/**
 * Đóng một listener: ngừng nhận kết nối mới, xong khi mọi kết nối đã đóng.
 *
 * `server.close()` của Node 22 chỉ đóng kết nối RẢNH đúng lúc gọi. Một kết nối keep-alive đang bận vẫn sống, vẫn
 * quảng cáo keep-alive trong phản hồi và nhận tiếp request - bên gọi có nhịp đều (vòng reconcile của Service 3, client
 * của Service 1) giữ nó mãi, và tắt êm rơi vào thoát cưỡng bức sau 10 giây: hàng đợi không nhả lease, database không
 * đóng. Đo (Plan #66, QA vòng C): 392 request vẫn được phục vụ sau `close()`, 12 giây chưa đóng. Nên từ lúc tắt, mọi
 * phản hồi mang `connection: close` - kết nối đóng ngay sau request đang dở. `prependListener` chứ không `on`: listener
 * phải chạy TRƯỚC handler của Express, vốn gửi header đồng bộ.
 */
export function closeServer(server: Server): Promise<void> {
  server.prependListener("request", (_req, res: ServerResponse) => {
    if (!res.headersSent) res.setHeader("connection", "close");
  });
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/**
 * [Plan #66] Listener nội bộ trên CÙNG app - mở khi có cổng, không mở gì khi không (dev, test).
 * `close()` của bản không mở xong ngay, nên đường tắt êm không phải rẽ nhánh.
 */
export function listenInternal(
  app: Express,
  port: number | undefined,
  onListening: (port: number) => void,
): { close(): Promise<void> } {
  if (port === undefined) return { close: () => Promise.resolve() };
  const server = app.listen(port, () => {
    onListening(port);
  });
  return { close: () => closeServer(server) };
}

/**
 * [Plan #66] `/internal/*` chỉ được phục vụ trên cổng nội bộ.
 *
 * Service 1 và Service 2 mở HAI listener trên cùng một app: cổng công khai (qua Traefik, NodePort) và cổng nội bộ mà
 * NetworkPolicy chỉ mở cho bên gọi hợp lệ (T12). Chốt này đọc cổng của socket nhận request - thứ bên gọi không giả
 * được bằng header - và trả cho cổng công khai đúng 404 của `notFoundHandler`, giống hệt một route không tồn tại, để
 * cổng công khai không nói ra route nội bộ nào có thật.
 *
 * Mount ở ĐẦU app, trước mọi router `/internal` (Service 2 có router mount trước parser JSON). Không cấu hình cổng nội
 * bộ thì đừng mount: dev và test chạy một cổng như trước.
 */
export function internalPortOnly(internalPort: number): RequestHandler {
  return (req, res, next) => {
    if (req.socket.localPort === internalPort) {
      next();
      return;
    }
    notFoundHandler(req, res, next);
  };
}
