import type { PipelineTemplateParams } from "@udp/adapter-core";

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

/** Giá trị chung mà mọi template điền vào */
export function templateValues(
  params: PipelineTemplateParams,
): Record<string, string> {
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
  };
}

/**
 * Lệnh shell "báo UDP": biến vào là `UDP_STATUS`, `COMMIT_SHA`, `COMMIT_TS`, `IMAGE_REF`,
 * `PIPELINE_ID`, `REPO`, `REF`, `ACTOR`, `UDP_ENVIRONMENT`, `UDP_WEBHOOK_URL` (địa chỉ ĐẦY ĐỦ mà
 * Portal hiện, đã gồm project và provider), `UDP_WEBHOOK_SECRET`. `PIPELINE_ID` phải khác nhau
 * giữa hai lượt chạy lại của cùng pipeline — UDP chống trùng theo nó.
 * Trường rỗng (timestamp, image khi build hỏng) bị bỏ khỏi thân — schema của UDP không nhận chuỗi
 * rỗng. `signatureHeader` là dòng `-H` của nhà cung cấp, dùng `$SIG` hay `$UDP_WEBHOOK_SECRET`.
 */
export function notifyScript(signatureHeader: string): string[] {
  return [
    "BODY=$(jq -nc \\",
    '  --arg env "$UDP_ENVIRONMENT" --arg status "$UDP_STATUS" \\',
    '  --arg sha "$COMMIT_SHA" --arg ts "$COMMIT_TS" --arg image "$IMAGE_REF" \\',
    '  --arg wl "%PROJECT%" --arg run "$PIPELINE_ID" --arg repo "$REPO" \\',
    '  --arg ref "$REF" --arg actor "$ACTOR" \\',
    "  '{environment:$env, status:$status, commitSha:$sha, commitTimestamp:$ts,",
    "    imageRef:$image, workloadName:$wl, pipelineId:$run, repo:$repo, ref:$ref,",
    '    actor:$actor} | with_entries(select(.value != ""))\')',
    "SIG=$(printf '%s' \"$BODY\" | openssl dgst -sha256 -hmac \"$UDP_WEBHOOK_SECRET\" -hex | sed 's/^.* //')",
    'curl -sS --fail -X POST "$UDP_WEBHOOK_URL" \\',
    "  -H 'Content-Type: application/json' \\",
    `  ${signatureHeader} \\`,
    '  --data-binary "$BODY"',
  ];
}

/** Biểu thức shell ra environment của nhánh: `main` ⇒ production, khác ⇒ cùng tên */
export const environmentExpr = (branchVar: string): string =>
  `$([ "${branchVar}" = "main" ] && echo "%PROD%" || echo "${branchVar}")`;

/** Lệnh shell đặt `UDP_ENVIRONMENT` theo nhánh */
export const environmentOfBranch = (branchVar: string): string =>
  `UDP_ENVIRONMENT=${environmentExpr(branchVar)}`;
