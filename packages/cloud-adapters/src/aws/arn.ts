import type { CreatedResourceKind } from "@udp/adapter-core";

/**
 * ARN ⇒ (kind, id) cho kết quả của Resource Groups Tagging API. Chỉ những loại tài nguyên
 * mà kế hoạch AWS tạo hoặc Kubernetes sinh ra; ARN khác trả `null` (tài nguyên của khách,
 * không phải của UDP).
 */
const EC2: Record<string, CreatedResourceKind> = {
  vpc: "vpc",
  subnet: "subnet",
  "internet-gateway": "internet-gateway",
  "elastic-ip": "elastic-ip",
  natgateway: "nat-gateway",
  "route-table": "route-table",
  "security-group": "security-group",
  volume: "k8s-volume",
  "network-interface": "k8s-eni",
};

export function parseArn(
  arn: string,
): { kind: CreatedResourceKind; id: string; region: string } | null {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return null;
  const service = parts[2] ?? "";
  const region = parts[3] ?? "";
  const resource = parts.slice(5).join(":");
  const [type, ...rest] = resource.split("/");
  const tail = rest.join("/");
  if (service === "ec2" && type !== undefined) {
    const kind = EC2[type];
    return kind === undefined ? null : { kind, id: tail, region };
  }
  if (service === "eks" && type === "cluster")
    return { kind: "cluster", id: tail, region };
  if (service === "eks" && type === "nodegroup") {
    // nodegroup/<cluster>/<nodegroup>/<uuid> ⇒ id `<cluster>/<nodegroup>`
    const [cluster, nodegroup] = rest;
    return cluster === undefined || nodegroup === undefined
      ? null
      : { kind: "nodegroup", id: `${cluster}/${nodegroup}`, region };
  }
  if (service === "elasticloadbalancing" && type === "loadbalancer") {
    return { kind: "k8s-loadbalancer", id: arn, region };
  }
  if (service === "iam" && type === "role")
    return { kind: "iam-role", id: arn, region: "global" };
  if (service === "iam" && type === "oidc-provider") {
    return { kind: "oidc-provider", id: arn, region: "global" };
  }
  return null;
}
