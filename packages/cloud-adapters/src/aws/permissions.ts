import {
  CreateVpcCommand,
  DescribeAccountAttributesCommand,
  DescribeAddressesCommand,
} from "@aws-sdk/client-ec2";
import { SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { GatewayError, type PermissionCheck } from "../core/gateway.js";
import type { AwsClients } from "./clients.js";
import { aws, classifyAwsError } from "./errors.js";
import { required } from "./resources/types.js";

/**
 * Preflight quyền AWS (§4.3 bảng "ba cloud, ba cách"):
 *
 * 1. `iam:SimulatePrincipalPolicy` với `aws:RequestTag/udp.project` trong ngữ cảnh ⇒
 *    `exact`. API này đòi CHÍNH credential đó có quyền gọi nó — policy mẫu của UDP có sẵn.
 * 2. Không gọi được (AccessDenied) ⇒ `heuristic`: `DryRun` những hành động EC2 kiểm được
 *    theo cách đó; quyền ngoài EC2 không kiểm được và được NÓI RA trong cảnh báo, không bị
 *    coi là "có".
 */

/** ARN của phiên AssumeRole ⇒ ARN của role (thứ `SimulatePrincipalPolicy` nhận) */
export function policySourceArnOf(callerArn: string): string {
  const m = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(
    callerArn,
  );
  return m === null
    ? callerArn
    : `arn:${m[1] ?? "aws"}:iam::${m[2] ?? ""}:role/${m[3] ?? ""}`;
}

const SIMULATE_BATCH = 50;

async function simulate(
  c: AwsClients,
  sourceArn: string,
  actions: readonly string[],
): Promise<string[]> {
  const denied: string[] = [];
  for (let i = 0; i < actions.length; i += SIMULATE_BATCH) {
    const batch = actions.slice(i, i + SIMULATE_BATCH);
    let marker: string | undefined;
    do {
      const res = await aws(() =>
        c.iam.send(
          new SimulatePrincipalPolicyCommand({
            PolicySourceArn: sourceArn,
            ActionNames: [...batch],
            ContextEntries: [
              {
                ContextKeyName: "aws:RequestTag/udp.project",
                ContextKeyType: "string",
                ContextKeyValues: ["preflight"],
              },
            ],
            ...(marker === undefined ? {} : { Marker: marker }),
          }),
        ),
      );
      for (const r of res.EvaluationResults ?? []) {
        if (r.EvalDecision !== "allowed" && r.EvalActionName !== undefined) {
          denied.push(r.EvalActionName);
        }
      }
      marker = res.IsTruncated === true ? res.Marker : undefined;
    } while (marker !== undefined);
  }
  return denied;
}

/** DryRun: `DryRunOperation` = được phép, `UnauthorizedOperation` = không */
async function dryRunAllowed(c: AwsClients): Promise<boolean> {
  try {
    await c.ec2.send(
      new CreateVpcCommand({ CidrBlock: "10.255.0.0/16", DryRun: true }),
    );
    return true;
  } catch (e) {
    const name = (e as { name?: unknown }).name;
    if (name === "DryRunOperation") return true;
    if (name === "UnauthorizedOperation") return false;
    throw classifyAwsError(e);
  }
}

async function eipWarnings(c: AwsClients): Promise<string[]> {
  // Kiểu SDK chỉ liệt kê hai tên lọc; `vpc-max-elastic-ips` có trong kết quả khi không lọc
  const [attrs, addresses] = await Promise.all([
    aws(() => c.ec2.send(new DescribeAccountAttributesCommand({}))),
    aws(() => c.ec2.send(new DescribeAddressesCommand({}))),
  ]);
  const max = Number(
    attrs.AccountAttributes?.find(
      (a) => a.AttributeName === "vpc-max-elastic-ips",
    )?.AttributeValues?.[0]?.AttributeValue ?? "5",
  );
  const used = addresses.Addresses?.length ?? 0;
  // Kế hoạch EKS cần MỘT Elastic IP cho NAT
  return max - used < 1
    ? [
        `Số Elastic IP còn lại: ${String(max - used)}/${String(max)} — cần 1 cho NAT`,
      ]
    : [];
}

export async function checkAwsPermissions(
  c: AwsClients,
  actions: readonly string[],
): Promise<PermissionCheck> {
  const identity = await aws(() =>
    c.sts.send(new GetCallerIdentityCommand({})),
  );
  const sourceArn = policySourceArnOf(
    required(identity.Arn, "Arn của credential"),
  );
  const quotaWarnings = await eipWarnings(c);
  try {
    const missing = await simulate(c, sourceArn, actions);
    return { missing, confidence: "exact", quotaWarnings };
  } catch (e) {
    if (!(e instanceof GatewayError) || e.errorClass !== "permission") throw e;
  }
  const ec2Actions = actions.filter((a) => a.startsWith("ec2:Create"));
  const unverifiable = actions.filter((a) => !a.startsWith("ec2:Create"));
  const allowed = await dryRunAllowed(c);
  return {
    missing: allowed ? [] : ec2Actions,
    confidence: "heuristic",
    quotaWarnings: [
      ...quotaWarnings,
      `Không kiểm được ${String(unverifiable.length)} quyền ngoài EC2 vì credential thiếu iam:SimulatePrincipalPolicy`,
    ],
  };
}
