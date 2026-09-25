import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import {
  SecretBuffer,
  type CredentialMode,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { z } from "zod";
import { GatewayError } from "../core/gateway.js";
import type { AwsSession } from "./clients.js";
import { aws } from "./errors.js";
import { required } from "./resources/types.js";

/**
 * Đổi credential AWS đã lưu thành `ResolvedCredential` ngắn hạn (Credential Manager §4.3).
 *
 * - `AWS_ROLE` (mặc định, federation): identity NỀN của UDP gọi `sts:AssumeRole` vào role
 *   của khách, kèm `ExternalId` theo project (chống "confused deputy") ⇒ khoá phiên 1 giờ.
 *   UDP không giữ bí mật dài hạn nào của khách; khách thu hồi bằng cách xoá trust policy.
 * - `AWS_KEY` (dự phòng): khoá tĩnh của khách, dùng trực tiếp, sống tối đa 15 phút trong RAM.
 * - `MANAGED`: identity nền của chính UDP (IRSA / instance role), không đổi gì.
 */

/** Hình của payload ĐÃ LƯU (mã hoá) theo `authKind` */
export const awsStoredPayloadSchemas = {
  AWS_ROLE: z
    .object({
      roleArn: z
        .string()
        .regex(
          /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/,
          "roleArn không hợp lệ",
        ),
    })
    .strict(),
  AWS_KEY: z
    .object({
      accessKeyId: z
        .string()
        .regex(/^(AKIA|ASIA)[A-Z0-9]{12,}$/, "accessKeyId không hợp lệ"),
      secretAccessKey: z.string().min(20),
    })
    .strict(),
} as const;

export const STATIC_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
const SESSION_SECONDS = 3600;

export interface AwsExchangeInput {
  mode: CredentialMode;
  authKind: "AWS_ROLE" | "AWS_KEY";
  /** Payload đã giải mã — bên gọi `dispose()` sau khi hàm này trả về */
  stored: SecretBuffer;
  projectId: string;
  /** HMAC theo project do Service 1 tính (spec QĐ-5) — chỉ dùng với AWS_ROLE */
  externalId: string;
  region: string;
  /** STS của identity nền UDP; tiêm được để test */
  baseSts?: STSClient;
  now?: () => number;
}

function resolved(
  mode: CredentialMode,
  authKind: "AWS_ROLE" | "AWS_KEY",
  session: AwsSession,
  expiresAt: Date,
): ResolvedCredential {
  const payload = new SecretBuffer(JSON.stringify(session));
  return {
    provider: "aws",
    mode,
    authKind,
    payload,
    expiresAt,
    dispose: () => payload.dispose(),
  };
}

function parseStored<K extends keyof typeof awsStoredPayloadSchemas>(
  kind: K,
  stored: SecretBuffer,
): z.infer<(typeof awsStoredPayloadSchemas)[K]> {
  return stored.use((buf) => {
    const parsed = awsStoredPayloadSchemas[kind].safeParse(
      JSON.parse(buf.toString("utf8")),
    );
    if (!parsed.success) {
      throw new GatewayError(
        "configuration",
        `payload ${kind} đã lưu sai hình`,
      );
    }
    return parsed.data;
  });
}

const sessionFrom = (c: {
  AccessKeyId?: string | undefined;
  SecretAccessKey?: string | undefined;
  SessionToken?: string | undefined;
}): AwsSession => ({
  accessKeyId: required(c.AccessKeyId, "AccessKeyId"),
  secretAccessKey: required(c.SecretAccessKey, "SecretAccessKey"),
  sessionToken: required(c.SessionToken, "SessionToken"),
});

export async function exchangeAwsCredential(
  input: AwsExchangeInput,
): Promise<ResolvedCredential> {
  const now = input.now ?? Date.now;

  if (input.mode === "MANAGED") {
    const base = await aws(() => fromNodeProviderChain()());
    return resolved(
      "MANAGED",
      input.authKind,
      {
        accessKeyId: base.accessKeyId,
        secretAccessKey: base.secretAccessKey,
        ...(base.sessionToken === undefined
          ? {}
          : { sessionToken: base.sessionToken }),
      },
      base.expiration ?? new Date(now() + STATIC_CREDENTIAL_TTL_MS),
    );
  }

  if (input.authKind === "AWS_KEY") {
    const key = parseStored("AWS_KEY", input.stored);
    return resolved(
      "BYOC",
      "AWS_KEY",
      key,
      new Date(now() + STATIC_CREDENTIAL_TTL_MS),
    );
  }

  const { roleArn } = parseStored("AWS_ROLE", input.stored);
  const sts =
    input.baseSts ?? new STSClient({ region: input.region, maxAttempts: 1 });
  const res = await aws(() =>
    sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        ExternalId: input.externalId,
        RoleSessionName: `udp-${input.projectId.replace(/-/g, "").slice(0, 32)}`,
        DurationSeconds: SESSION_SECONDS,
      }),
    ),
  );
  const creds = required(res.Credentials, "Credentials của AssumeRole");
  return resolved(
    "BYOC",
    "AWS_ROLE",
    sessionFrom(creds),
    creds.Expiration ?? new Date(now() + SESSION_SECONDS * 1000),
  );
}
