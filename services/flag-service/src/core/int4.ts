/**
 * Khoảng của kiểu INTEGER (int4) trong PostgreSQL.
 *
 * Mọi con số đi từ dây xuống một cột int4 — `config_version`, `RolloutSession.version`,
 * `priority` — phải bị chặn ở ranh giới HTTP: lọt xuống Postgres thì nó ném `22003`
 * và thành 500 thay vì 400. Một chỗ khai cho mọi nơi kiểm, thay vì mỗi nơi một bản
 * chép tay có thể gõ lệch một chữ số.
 */
export const INT4_MIN = -2_147_483_648;
export const INT4_MAX = 2_147_483_647;
