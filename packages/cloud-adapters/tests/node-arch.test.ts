import { describe, expect, it } from "vitest";
import { AWS_NODE_TYPES } from "../src/aws/plan.js";
import { AZURE_VM_SIZES } from "../src/azure/plan.js";
import { GCP_MACHINE_TYPES } from "../src/gcp/plan.js";

/**
 * [Plan #61 QĐ-11] Pipeline UDP sinh ra build image `linux/amd64` (`NODE_ARCH` của `@udp/config`) vì MỌI node UDP
 * dựng là x86. Thêm một cỡ node Arm (Graviton `t4g`/`m7g`, Ampere `t2a`/`c4a`, Azure `…ps_v5`) mà quên kế hoạch
 * build thì pod kéo image sai kiến trúc — test này đỏ trước.
 */
const ARM = {
  aws: /^[a-z]+\d+[a-z]*g[a-z]*\./,
  gcp: /^(t2a|c4a|n4a)-/,
  azure: /^Standard_[A-Z]+\d+[a-z]*p[a-z]*_v\d+$/,
};

describe("kiến trúc node của ba cloud", () => {
  it("mọi cỡ node là x86 — đổi thì sửa NODE_ARCH và kế hoạch build (Plan #61)", () => {
    for (const t of Object.values(AWS_NODE_TYPES))
      expect(t).not.toMatch(ARM.aws);
    for (const t of Object.values(GCP_MACHINE_TYPES)) {
      expect(t).not.toMatch(ARM.gcp);
    }
    for (const t of Object.values(AZURE_VM_SIZES)) {
      expect(t).not.toMatch(ARM.azure);
    }
  });

  it("bộ nhận dạng Arm bắt đúng các họ Arm phổ biến", () => {
    for (const t of ["t4g.large", "m7g.xlarge", "c7gn.large"]) {
      expect(t).toMatch(ARM.aws);
    }
    for (const t of ["t2a-standard-4", "c4a-standard-8"]) {
      expect(t).toMatch(ARM.gcp);
    }
    for (const t of ["Standard_D2ps_v5", "Standard_D4pds_v6"]) {
      expect(t).toMatch(ARM.azure);
    }
  });
});
