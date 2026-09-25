import { createHash } from "node:crypto";
import type { ObjectRef } from "@udp/adapter-core";

/**
 * Bí mật của tool TRÊN cluster (Plan #31 QĐ-5) — dùng chung cho hai lớp nền.
 *
 * Khoá API, license key của agent đi vào một `Secret` trong namespace của release, KHÔNG
 * BAO GIỜ vào ConfigMap: cluster chỉ đối xử với `Secret` như bí mật (mã hoá at-rest, che
 * trong `kubectl describe`, công cụ sao lưu/GitOps loại trừ), ConfigMap thì không. Bản băm
 * của phần bí mật được vào ConfigMap: đổi khoá ⇒ ConfigMap đổi ⇒ release thấy giá trị mới
 * (cùng lý lẽ với chú thích `checksum/secret` của Helm). Băm không mở thêm đường nào: trong
 * `udp-system` chỉ `udp-tooling` đọc được ConfigMap, và nó đọc được chính `Secret` (§12.2).
 */

export interface ToolSecret {
  ref: ObjectRef;
  /** Thân `Secret`; `stringData` để API server tự mã base64 */
  body: { type: "Opaque"; stringData: Record<string, string> };
  /** `sha256:<hex>` của `stringData` theo thứ tự khoá — ổn định qua mỗi lượt áp */
  digest: string;
}

export const secretRef = (namespace: string, name: string): ObjectRef => ({
  apiVersion: "v1",
  kind: "Secret",
  namespace,
  name,
});

export function toolSecret(
  namespace: string,
  name: string,
  stringData: Record<string, string>,
): ToolSecret {
  const ordered = Object.keys(stringData)
    .sort()
    .map((k) => [k, stringData[k]]);
  return {
    ref: secretRef(namespace, name),
    body: { type: "Opaque", stringData },
    digest: `sha256:${createHash("sha256").update(JSON.stringify(ordered)).digest("hex")}`,
  };
}
