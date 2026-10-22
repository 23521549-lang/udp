/**
 * `@udp/cluster-access/in-cluster` [Plan #67] - API server của CHÍNH cụm chạy UDP: dò từ môi trường của pod, và
 * `TokenReview` cho lớp danh tính của `/internal/*`.
 *
 * Subpath riêng vì Service 2 dùng nó mà không dùng `ClusterAccess` của cụm khách: entry này chỉ nạp `node:fs`,
 * `node:crypto` và `undici` (qua `transport.ts`), không nạp `direct.ts` hay `@udp/adapter-core`.
 */
export * from "./api.js";
export * from "./identity.js";
export * from "./token-review.js";
