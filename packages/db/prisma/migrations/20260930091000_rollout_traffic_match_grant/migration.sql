-- [v4.11] Sửa lệch I22 có từ Plan #51: `rollout_sessions.traffic_match` là cột CẤU HÌNH, thuộc phía Service 1
-- theo §1.2 (S1 ghi mọi cột trừ tám cột điều khiển của S3) — nhưng S1 thiếu UPDATE trên nó.
--
-- Vì sao lọt: `service_roles` dựng danh sách cột UPDATE bằng một khối DO lúc migration chạy. Danh sách đó đóng
-- băng tại thời điểm ấy; cột thêm về sau KHÔNG tự vào (lời chú thích "thêm cột mới về sau sẽ tự vào đúng phía" ở
-- migration đó là sai). Mỗi cột cấu hình mới của `rollout_sessions` hay `environments` phải GRANT như dưới đây,
-- và I22 (`allExcept`) là thứ bắt lỗi khi quên.
--
-- Đường lùi:
--   REVOKE UPDATE ("traffic_match") ON "rollout_sessions" FROM udp_s1;

GRANT UPDATE ("traffic_match") ON "rollout_sessions" TO udp_s1;
