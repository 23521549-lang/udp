# Plan #41 — PLAN (theo `plan41-spec.md` v1) — XONG 26/09/2026

| Pha | Làm gì                                                                                                                                | Cổng                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| P1  | S1: hub `config_version` theo lô + `GET /projects/:id/stream` (khuôn thuần có cổng như `job-stream`); §9                              | đơn vị + tích hợp (AC-1/2) |
| P2  | S1: `total` và `isEnabled` cho `GET /flags`; `limit/offset/total` cho `GET /projects`; wire + golden                                  | tích hợp (AC-4)            |
| P3  | Portal: luồng project (chỉ invalidate, mở lại có backoff); trang Flag theo trang; bảng lệnh, tổng quan, tạo rollout bằng truy vấn nhỏ | Portal (AC-3/5)            |
| P4  | Harness đo p95 200 × 3, số thô vào `raw/`; sổ nợ trả `portal-sse`, `portal-pagination`; §10.14/§16; bàn giao; cổng đầy đủ             | cổng đầy đủ (AC-6/7)       |
