import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { SecretBuffer } from "@udp/adapter-core";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import {
  exchangeAwsCredential,
  STATIC_CREDENTIAL_TTL_MS,
} from "../../src/aws/credentials.js";

/** Đổi credential AWS (§4.3, Plan #26 AC-9) */

const sts = mockClient(STSClient);
afterEach(() => sts.reset());

const PROJECT = "11111111-2222-3333-4444-555555555555";
const stored = (v: unknown) => new SecretBuffer(JSON.stringify(v));

describe("AWS_ROLE (federation mặc định)", () => {
  it("AssumeRole kèm ExternalId của project, phiên 1 giờ, payload là khoá PHIÊN", async () => {
    const expiration = new Date(Date.now() + 3_600_000);
    sts.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "ASIAEXAMPLEEXAMPLE",
        SecretAccessKey: "tmp-secret",
        SessionToken: "tmp-token",
        Expiration: expiration,
      },
    });
    const cred = await exchangeAwsCredential({
      mode: "BYOC",
      authKind: "AWS_ROLE",
      stored: stored({
        roleArn: "arn:aws:iam::123456789012:role/udp-deployer",
      }),
      projectId: PROJECT,
      externalId: "ext-123",
      region: "ap-southeast-1",
      baseSts: new STSClient({ region: "ap-southeast-1" }),
    });
    const input = sts.commandCalls(AssumeRoleCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      RoleArn: "arn:aws:iam::123456789012:role/udp-deployer",
      ExternalId: "ext-123",
      DurationSeconds: 3600,
    });
    expect(input?.RoleSessionName).toBe("udp-11111111222233334444555555555555");
    expect(cred.expiresAt).toEqual(expiration);
    const session = cred.payload.use(
      (b) => JSON.parse(b.toString("utf8")) as unknown,
    );
    expect(session).toEqual({
      accessKeyId: "ASIAEXAMPLEEXAMPLE",
      secretAccessKey: "tmp-secret",
      sessionToken: "tmp-token",
    });
    cred.dispose();
    expect(cred.payload.everyByteIsZero()).toBe(true);
  });

  it("roleArn sai hình ⇒ configuration, KHÔNG gọi STS", async () => {
    await expect(
      exchangeAwsCredential({
        mode: "BYOC",
        authKind: "AWS_ROLE",
        stored: stored({ roleArn: "khong-phai-arn" }),
        projectId: PROJECT,
        externalId: "e",
        region: "ap-southeast-1",
        baseSts: new STSClient({ region: "ap-southeast-1" }),
      }),
    ).rejects.toMatchObject({ errorClass: "configuration" });
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });

  it("khách đã xoá trust policy ⇒ permission", async () => {
    sts
      .on(AssumeRoleCommand)
      .rejects(Object.assign(new Error("x"), { name: "AccessDenied" }));
    await expect(
      exchangeAwsCredential({
        mode: "BYOC",
        authKind: "AWS_ROLE",
        stored: stored({ roleArn: "arn:aws:iam::123456789012:role/r" }),
        projectId: PROJECT,
        externalId: "e",
        region: "ap-southeast-1",
        baseSts: new STSClient({ region: "ap-southeast-1" }),
      }),
    ).rejects.toMatchObject({ errorClass: "permission" });
  });
});

describe("AWS_KEY (dự phòng)", () => {
  it("dùng trực tiếp, sống TỐI ĐA 15 phút", async () => {
    const t0 = 1_800_000_000_000;
    const cred = await exchangeAwsCredential({
      mode: "BYOC",
      authKind: "AWS_KEY",
      stored: stored({
        accessKeyId: "AKIAEXAMPLEEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCY",
      }),
      projectId: PROJECT,
      externalId: "e",
      region: "ap-southeast-1",
      now: () => t0,
    });
    expect(cred.expiresAt.getTime() - t0).toBe(STATIC_CREDENTIAL_TTL_MS);
    expect(sts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
});
