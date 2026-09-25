import { z } from "zod";

/**
 * Định danh GitHub dùng chung cho các adapter registry của GitHub (GHCR, GitHub Packages) —
 * một chỗ khai, để hai thư mục adapter không import lẫn nhau.
 */

/** Người dùng hay tổ chức GitHub: 1–39 ký tự, chữ số và gạch ngang, không mở/đóng bằng gạch */
export const githubOwner = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/);

/** Token `read:packages` — classic `ghp_…` hay fine-grained `github_pat_…`; bí mật của tool */
export const githubPackagesToken = z
  .string()
  .regex(/^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})$/)
  .describe("secret");
