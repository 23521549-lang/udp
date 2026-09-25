import { UnprocessableError } from "@udp/http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CredentialDecryptError } from "../src/modules/credential/credential.crypto.js";
import {
  isSealed,
  KEPT_SECRET,
  maskSecrets,
  openSecrets,
  resolveKept,
  sealSecrets,
  secretFieldsOf,
} from "../src/modules/domain/tool-secrets.js";

/** Bí mật trong `tool_config` (Plan #31 P1, QĐ-1) — thuần trên máy mã hoá §4.3 */

const SENTINEL = "canhBiMatToolP31a9f3c1e7";
const schema = z.object({
  site: z.string(),
  apiKey: z.string().min(8).describe("secret"),
  licenseKey: z.string().describe("secret").optional(),
  replicas: z.number().int().default(1),
});
const scope = {
  schema,
  projectId: "0f0f0f0f-1111-4222-8333-444455556666",
  domainType: "MONITORING",
};

describe("bí mật của tool", () => {
  it("nhận ra trường .describe('secret'), kể cả khi bọc optional", () => {
    expect(secretFieldsOf(schema)).toEqual(["apiKey", "licenseKey"]);
    expect(secretFieldsOf(z.string())).toEqual([]);
  });

  it("niêm phong ⇒ không còn một byte bản rõ; mở lại ⇒ đúng giá trị", () => {
    const sealed = sealSecrets(scope, { site: "eu", apiKey: SENTINEL });
    expect(isSealed(sealed.apiKey)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(SENTINEL);
    expect(sealed.site).toBe("eu");
    expect(openSecrets(scope, sealed).apiKey).toBe(SENTINEL);
  });

  it("ciphertext dán sang trường khác hay project khác là thất bại xác thực", () => {
    const sealed = sealSecrets(scope, { apiKey: SENTINEL });
    expect(() => openSecrets(scope, { licenseKey: sealed.apiKey })).toThrow(
      CredentialDecryptError,
    );
    expect(() =>
      openSecrets(
        { ...scope, projectId: "11111111-2222-4333-8444-555555555555" },
        sealed,
      ),
    ).toThrow(CredentialDecryptError);
  });

  it("giữ chỗ ⇒ bản rõ của bí mật đã lưu; giữ chỗ khi chưa lưu gì ⇒ 422", () => {
    const stored = sealSecrets(scope, { apiKey: SENTINEL });
    expect(
      resolveKept(scope, { apiKey: { ...KEPT_SECRET } }, stored).apiKey,
    ).toBe(SENTINEL);
    expect(() =>
      resolveKept(scope, { apiKey: { ...KEPT_SECRET } }, null),
    ).toThrow(UnprocessableError);
  });

  it("lên dây: bí mật thành giá trị giữ chỗ; trường vắng vẫn vắng", () => {
    const masked = maskSecrets(
      sealSecrets(scope, { site: "eu", apiKey: SENTINEL }),
    );
    expect(masked).toEqual({ site: "eu", apiKey: KEPT_SECRET });
    expect(JSON.stringify(masked)).not.toContain(SENTINEL);
  });
});
