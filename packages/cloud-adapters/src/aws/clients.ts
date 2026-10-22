import { EC2Client } from "@aws-sdk/client-ec2";
import { EKSClient } from "@aws-sdk/client-eks";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { IAMClient } from "@aws-sdk/client-iam";
import { ResourceGroupsTaggingAPIClient } from "@aws-sdk/client-resource-groups-tagging-api";
import { STSClient } from "@aws-sdk/client-sts";
import type { ResolvedCredential } from "@udp/adapter-core";
import { z } from "zod";
import { GatewayError } from "../core/gateway.js";

/**
 * Payload của `ResolvedCredential` AWS SAU khi đổi token (Credential Manager, §4.3):
 * một bộ khoá phiên — với AWS_ROLE là khoá tạm của `AssumeRole` (1 giờ), với AWS_KEY là
 * khoá tĩnh (sống tối đa 15 phút trong RAM).
 */
export const awsSessionSchema = z
  .object({
    accessKeyId: z.string().min(16),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1).optional(),
  })
  .strict();
export type AwsSession = z.infer<typeof awsSessionSchema>;

export interface AwsClients {
  ec2: EC2Client;
  eks: EKSClient;
  iam: IAMClient;
  sts: STSClient;
  tagging: ResourceGroupsTaggingAPIClient;
  elb: ElasticLoadBalancingV2Client;
}

/**
 * Nhà cung cấp credential cho SDK: đọc payload qua `SecretBuffer.use()` MỖI lần SDK hỏi,
 * không giữ bản sao nào ở phạm vi module. SDK buộc phải nhận chuỗi — đó là giới hạn của
 * SDK, và bản sao chuỗi chỉ sống trong phạm vi một lời ký (§4.3 "Giới hạn thật").
 */
export function awsCredentialsOf(credential: ResolvedCredential) {
  return () =>
    Promise.resolve().then(() => {
      if (credential.expiresAt.getTime() <= Date.now()) {
        throw new GatewayError("permission", "credential AWS đã hết hạn");
      }
      return credential.payload.use((buf) => {
        const parsed = awsSessionSchema.safeParse(
          JSON.parse(buf.toString("utf8")),
        );
        if (!parsed.success) {
          throw new GatewayError(
            "configuration",
            "payload credential AWS sai hình",
          );
        }
        const { accessKeyId, secretAccessKey, sessionToken } = parsed.data;
        return {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken === undefined ? {} : { sessionToken }),
          expiration: credential.expiresAt,
        };
      });
    });
}

export function awsClientsFor(
  credential: ResolvedCredential,
  region: string,
): AwsClients {
  const credentials = awsCredentialsOf(credential);
  // Thử lại là việc của runner (Plan #26 P1): tắt retry ngầm của SDK để số lời gọi trung thực
  const base = { region, credentials, maxAttempts: 1 };
  return {
    ec2: new EC2Client(base),
    eks: new EKSClient(base),
    iam: new IAMClient({ ...base, region: "us-east-1" }),
    sts: new STSClient(base),
    tagging: new ResourceGroupsTaggingAPIClient(base),
    elb: new ElasticLoadBalancingV2Client(base),
  };
}
