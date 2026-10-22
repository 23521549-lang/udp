import {
  SecretBuffer,
  type CreatedResource,
  type CreatedResourceKind,
  type ResolvedCredential,
} from "@udp/adapter-core";
import { describe, expect, it } from "vitest";
import { awsPlan } from "../src/aws/index.js";
import {
  createPlannedAdapter,
  GatewayError,
  type CloudGateway,
} from "../src/index.js";

/**
 * Trong MỘT bậc teardown, lõi xoá theo thứ tự ngược kế hoạch (§4.2 `teardown`: "theo thứ
 * tự ngược"). Cloud mô phỏng không từ chối xoá tài nguyên "đang dùng", nên bộ hợp đồng
 * không thấy lỗi này; cloud thật thì có: AWS không nhả Elastic IP khi NAT còn giữ nó.
 */

const PROJECT = "0f0f0f0f-1111-4222-8333-444455556666";

const resource = (
  kind: CreatedResourceKind,
  id: string,
  step?: string,
): CreatedResource => ({
  kind,
  id,
  provider: "aws",
  region: "ap-southeast-1",
  createdAt: "2026-09-25T00:00:00.000Z",
  tags:
    step === undefined
      ? {}
      : { "udp.key": `${PROJECT}:NETWORK:${kind}:${step}` },
});

function recordingAdapter(inUse: ReadonlyMap<string, string>) {
  const removed: string[] = [];
  const notUsed = () => Promise.reject(new Error("không dùng trong test này"));
  const gateway: CloudGateway = {
    provider: "aws",
    region: "ap-southeast-1",
    whoAmI: notUsed,
    checkPermissions: notUsed,
    create: notUsed,
    findByTag: notUsed,
    findByName: notUsed,
    describe: () => Promise.resolve(null),
    isReady: notUsed,
    listByProject: notUsed,
    clusterInfo: notUsed,
    kubeToken: notUsed,
    remove: (r) => {
      // Như cloud thật: không xoá được thứ còn bị một tài nguyên CHƯA xoá giữ
      const holder = inUse.get(r.id);
      if (holder !== undefined && !removed.includes(holder)) {
        return Promise.reject(
          new GatewayError("dependency", `${r.id} đang dùng bởi ${holder}`),
        );
      }
      removed.push(r.id);
      return Promise.resolve("deleted");
    },
  };
  const adapter = createPlannedAdapter({
    plan: awsPlan,
    gatewayFor: () => gateway,
    waitReady: { intervalMs: 0, timeoutMs: 0 },
    teardown: { waitTimeoutMs: 0, pollIntervalMs: 0 },
    sleep: () => Promise.resolve(),
  });
  return { adapter, removed };
}

const credential = (): ResolvedCredential => {
  const payload = new SecretBuffer("{}");
  return {
    provider: "aws",
    mode: "BYOC",
    authKind: "AWS_ROLE",
    payload,
    expiresAt: new Date(Date.now() + 60_000),
    dispose: () => payload.dispose(),
  };
};

describe("thứ tự xoá trong một bậc", () => {
  it("NAT trước Elastic IP nó giữ, dù sổ liệt kê theo thứ tự tạo", async () => {
    const { adapter, removed } = recordingAdapter(
      new Map([["eip-1", "nat-1"]]),
    );
    const result = await adapter.teardown(credential(), [
      resource("elastic-ip", "eip-1", "eip"),
      resource("nat-gateway", "nat-1", "nat"),
    ]);
    expect(result).toEqual({
      status: "SUCCESS",
      data: { deleted: ["nat-1", "eip-1"], failed: [] },
    });
    expect(removed).toEqual(["nat-1", "eip-1"]);
  });

  it("tài nguyên không mang tag xếp theo kind; bậc vẫn theo chín bậc", async () => {
    const { adapter, removed } = recordingAdapter(new Map());
    await adapter.teardown(credential(), [
      resource("vpc", "vpc-1", "vpc"),
      resource("subnet", "subnet-1"),
      resource("security-group", "sg-1", "sg"),
      resource("route-table", "rtb-1", "rtb-private"),
    ]);
    expect(removed).toEqual(["sg-1", "rtb-1", "subnet-1", "vpc-1"]);
  });
});
