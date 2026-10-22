import type { PublicEnvironmentWire } from "@udp/shared-types/wire";

/**
 * Environment mặc định khi URL không nói env nào (§10.12): env KHÔNG phải production có
 * `rank` nhỏ nhất — để một cú refresh trang không bao giờ đưa người dùng vào production.
 * Project không có env nào ngoài production thì mới rơi về production.
 */
export function defaultEnvOf(
  envs: readonly PublicEnvironmentWire[],
): PublicEnvironmentWire | undefined {
  const byRank = [...envs].sort((a, b) => a.rank - b.rank);
  return byRank.find((e) => !e.isProduction) ?? byRank[0];
}

/**
 * Env đang chọn: `envId` trong URL nếu nó thuộc project, ngược lại env mặc định. Một id
 * lạ trên URL (dán từ project khác) KHÔNG được tin — nó sẽ làm mọi query của trang trỏ
 * sang dữ liệu không thuộc project này.
 */
export function resolveEnv(
  envs: readonly PublicEnvironmentWire[],
  envId: string | undefined,
): PublicEnvironmentWire | undefined {
  return envs.find((e) => e.id === envId) ?? defaultEnvOf(envs);
}

/** Ba env mặc định có tên cố định; env khác hiện đúng tên của nó */
export function envLabel(env: { name: string }): string {
  return env.name;
}
