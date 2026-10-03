import { z } from "zod";

/**
 * Cấu hình repo Git mà một công cụ GitOps đồng bộ (Plan #34) — dùng chung cho Argo CD và Flux.
 *
 * Chỉ `https://` (QĐ-6): `ssh://` cần known_hosts và khoá riêng, là một cấu hình khác hẳn;
 * `http://` là gửi token qua kênh trần. Nhánh và đường dẫn chỉ nhận ký tự của tên ref/đường dẫn
 * Git — giá trị đi thẳng vào CR của controller.
 */
export const gitRepoShape = {
  repoUrl: z
    .string()
    .regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?\/[A-Za-z0-9._~/-]+$/),
  revision: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,100}$/)
    .default("main"),
  path: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/)
    .default("."),
  /** Token đọc repo (PAT / deploy token) — bỏ trống cho repo công khai */
  token: z.string().min(8).max(512).describe("secret").optional(),
};

export const gitRepoSchema = z.object(gitRepoShape);
export type GitRepoConfig = z.infer<typeof gitRepoSchema>;
