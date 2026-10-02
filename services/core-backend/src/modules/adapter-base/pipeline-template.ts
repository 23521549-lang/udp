import type { PipelineTemplateParams, RebaseSchedule } from "@udp/adapter-core";
import { testStep } from "./packaging/build-script.js";

/**
 * Phần dùng chung của template pipeline Golden Path (§11, Plan #36 QĐ-6) — sáu nhà cung cấp, một
 * quy ước:
 *
 *  - image = `<registryRef>/<projectSlug>:<commit>`, workload = `projectSlug`;
 *  - nhánh `main` ⇒ environment production, nhánh khác ⇒ environment CÙNG tên;
 *  - bước cuối "báo UDP" dựng thân JSON của UDP rồi ký ĐÚNG chuỗi byte gửi đi (bản v3 ký một JSON
 *    rồi gửi một JSON khác — verify luôn hỏng).
 *
 * Template là văn bản với chỗ trống `%TÊN%` — không dùng template literal của TypeScript vì cả
 * GitHub (`${{ }}`) lẫn shell (`${VAR}`) đều dùng `${`.
 */

export function fillTemplate(
  lines: readonly string[],
  values: Readonly<Record<string, string>>,
): string {
  return `${lines
    .join("\n")
    .replace(/%([A-Z_]+)%/g, (whole, key: string) => values[key] ?? whole)}\n`;
}

/** Bước test chạy trong container của runtime — cho CI có Docker trên máy chạy (GitHub, CircleCI, Jenkins) */
export const TEST_IN_CONTAINER =
  'docker run --rm -v "$PWD:/w" -w /w %TEST_IMAGE% sh -c "%TEST%"';

/** Giá trị chung mà mọi template điền vào */
export function templateValues(
  params: PipelineTemplateParams,
): Record<string, string> {
  // [Plan #61 QĐ-9] Lệnh test đến từ kế hoạch build: chạy, tắt tường minh, hay thiếu lệnh ⇒ dừng pipeline
  const test = testStep(params.build);
  const production =
    params.environments.find((e) => e.isProduction)?.name ?? "production";
  const branches = [
    "main",
    ...params.environments.filter((e) => !e.isProduction).map((e) => e.name),
  ];
  return {
    PROJECT: params.projectSlug,
    IMAGE: `${params.registryRef}/${params.projectSlug}`,
    PROD: production,
    BRANCHES: branches.join(", "),
    BRANCH_LIST: branches.join(" "),
    FLAGS: params.flagKeys.join(","),
    ROLLOUT: params.rolloutStrategy,
    TEST: test.command,
    TEST_IMAGE: test.image,
  };
}

/**
 * Lệnh shell "báo UDP": biến vào là `UDP_STATUS`, `COMMIT_SHA`, `COMMIT_TS`, `IMAGE_REF`,
 * `PIPELINE_ID`, `REPO`, `REF`, `ACTOR`, `UDP_ENVIRONMENT`, `UDP_WEBHOOK_URL` (địa chỉ ĐẦY ĐỦ mà
 * Portal hiện, đã gồm project và provider), `UDP_WEBHOOK_SECRET`, và hai biến tuỳ chọn: `UDP_KIND`
 * (`rebase` ở lượt theo lịch, Plan #61 QĐ-13), `UDP_SIGNATURE_B64` (bundle chữ ký image dạng base64 một
 * dòng — đi qua được biến môi trường của mọi CI — cổng deploy kiểm, QĐ-16). `PIPELINE_ID` phải khác nhau
 * giữa hai lượt chạy lại của cùng pipeline — UDP chống trùng theo nó.
 * Trường rỗng (timestamp, image khi build hỏng) bị bỏ khỏi thân — schema của UDP không nhận chuỗi
 * rỗng. `signatureHeader` là dòng `-H` của nhà cung cấp, dùng `$SIG` hay `$UDP_WEBHOOK_SECRET`.
 */
export function notifyScript(
  signatureHeader: string,
  /**
   * [Plan #61 QĐ-17, 61d-2a] Dòng shell đặt `UDP_OIDC_TOKEN`, cho nhà cung cấp phải lấy token bằng lệnh.
   *
   * Phải đi QUA đây chứ không ghép ở adapter: mỗi adapter áp phép thụt lề của riêng nó, và ở hai trong sáu
   * chỗ phép đó chỉ áp cho kết quả của hàm này — nên dòng ghép bên ngoài rơi sai cột và sinh YAML không
   * hợp lệ. Bộ hợp đồng CI/CD bắt đúng lỗi đó, nên chỗ nối duy nhất là tham số này.
   *
   * GitLab không dùng nó: `id_tokens:` của GitLab tiêm token thành biến ở mức YAML, không cần lệnh nào.
   */
  tokenLines: readonly string[] = [],
): string[] {
  return [
    ...tokenLines,
    "BODY=$(jq -nc \\",
    '  --arg env "$UDP_ENVIRONMENT" --arg status "$UDP_STATUS" \\',
    '  --arg sha "$COMMIT_SHA" --arg ts "$COMMIT_TS" --arg image "$IMAGE_REF" \\',
    '  --arg wl "%PROJECT%" --arg run "$PIPELINE_ID" --arg repo "$REPO" \\',
    '  --arg ref "$REF" --arg actor "$ACTOR" --arg kind "${UDP_KIND:-}" \\',
    '  --arg sig "${UDP_SIGNATURE_B64:-}" \\',
    "  '{environment:$env, status:$status, commitSha:$sha, commitTimestamp:$ts,",
    "    imageRef:$image, workloadName:$wl, pipelineId:$run, repo:$repo, ref:$ref,",
    "    actor:$actor, kind:$kind,",
    '    signature:(if $sig == "" then "" else ($sig | @base64d | fromjson) end)}',
    '    | with_entries(select(.value != ""))\')',
    "SIG=$(printf '%s' \"$BODY\" | openssl dgst -sha256 -hmac \"$UDP_WEBHOOK_SECRET\" -hex | sed 's/^.* //')",
    'curl -sS --fail -X POST "$UDP_WEBHOOK_URL" \\',
    "  -H 'Content-Type: application/json' \\",
    `  ${signatureHeader} \\`,
    // [Plan #61 QD-17, 61d-2a] Trusted Deploy: token OIDC cua CHINH luot chay nay, neu nha cung cap cap
    // duoc. Rong thi KHONG gui header — pipeline cua project chua bat che do bat buoc khong doi hanh vi.
    '  ${UDP_OIDC_TOKEN:+-H "Authorization: Bearer $UDP_OIDC_TOKEN"} \\',
    '  --data-binary "$BODY"',
  ];
}

/** Biểu thức shell ra environment của nhánh: `main` ⇒ production, khác ⇒ cùng tên */
export const environmentExpr = (branchVar: string): string =>
  `$([ "${branchVar}" = "main" ] && echo "%PROD%" || echo "${branchVar}")`;

/** Lệnh shell đặt `UDP_ENVIRONMENT` theo nhánh */
export const environmentOfBranch = (branchVar: string): string =>
  `UDP_ENVIRONMENT=${environmentExpr(branchVar)}`;

/**
 * [Plan #61 QĐ-13] Biến của bước báo UDP sau lượt rebase: luôn `success` (rebase hỏng thì job đỏ và không báo), luôn
 * environment production, `kind: rebase`. `imageRef` là biểu thức shell ra ảnh có digest mới.
 */
export const rebaseNotifyVars = (
  ref: string,
  imageRef = '"$UDP_IMAGE_REF"',
): string[] => [
  `UDP_STATUS=success UDP_KIND=rebase UDP_ENVIRONMENT=%PROD% IMAGE_REF=${imageRef} COMMIT_TS= REF=${ref}`,
];

/** `HH:MM` của lịch rebase — cho chú thích trong tệp pipeline */
export const rebaseTimeOf = (schedule: RebaseSchedule): string =>
  `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
