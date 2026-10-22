import type { DomainAdapter } from "@udp/adapter-core";
import type { CapabilityDeclaration } from "@udp/shared-types";
import { describe, expect, it } from "vitest";
import {
  planDomainApply,
  type DomainState,
} from "../src/modules/domain/domain-apply-plan.js";

/** Kế hoạch áp §8.2 (Plan #30 P1) — năm CASE, thuần trên khai báo capability */

/** Chỉ ba trường mà kế hoạch đọc; phần còn lại của hợp đồng không liên quan ở đây */
const adapter = (
  domainType: string,
  toolId: string,
  capabilities: CapabilityDeclaration,
): DomainAdapter =>
  ({ domainType, toolId, capabilities }) as unknown as DomainAdapter;

const PROM = adapter("MONITORING", "prometheus", {
  provides: [{ id: "metrics.query", version: "2.0.0" }],
  requires: [],
});
const VICTORIA = adapter("LOGGING", "victoria", {
  provides: [{ id: "metrics.query", version: "2.1.0" }],
  requires: [],
});
const VICTORIA_AS_MONITORING = adapter("MONITORING", "victoria", {
  provides: [{ id: "metrics.query", version: "2.1.0" }],
  requires: [],
});
const FLAGGER = adapter("PROGRESSIVE_DELIVERY", "flagger", {
  provides: [],
  requires: [{ id: "metrics.query", constraint: "^2" }],
});

const state = (
  a: DomainAdapter,
  config: Record<string, unknown> = {},
): DomainState => ({ domainType: a.domainType, adapter: a, config });

const kinds = (ops: { kind: string }[]) => ops.map((o) => o.kind);

describe("planDomainApply", () => {
  it("CASE 1: bật consumer mới ⇒ chỉ nó được deploy; provider đang chạy không bị chạm", () => {
    const plan = planDomainApply({
      current: [state(PROM)],
      currentPreferences: [],
      target: [state(PROM), state(FLAGGER)],
      targetPreferences: [],
    });
    expect(plan.deployTiers.map(kinds)).toEqual([["enable"]]);
    expect(plan.disables).toEqual([]);
  });

  it("CASE 3: đổi tool ⇒ một thao tác switch, không rebind riêng (switch tự rebind)", () => {
    const plan = planDomainApply({
      current: [state(PROM), state(FLAGGER)],
      currentPreferences: [],
      target: [state(VICTORIA_AS_MONITORING), state(FLAGGER)],
      targetPreferences: [],
    });
    expect(plan.deployTiers.map(kinds)).toEqual([["switch"]]);
    expect(plan.rebinds).toEqual([]);
    expect(plan.disables).toEqual([]);
  });

  it("CASE 2: tắt ⇒ disable NGƯỢC bậc hiện tại (consumer trước provider)", () => {
    const plan = planDomainApply({
      current: [state(PROM), state(FLAGGER)],
      currentPreferences: [],
      target: [],
      targetPreferences: [],
    });
    expect(
      plan.disables.map(
        (op) => op.kind === "disable" && op.from.adapter.toolId,
      ),
    ).toEqual(["flagger", "prometheus"]);
    expect(plan.deployTiers).toEqual([]);
  });

  it("CASE 4: cấu hình đổi theo NỘI DUNG ⇒ reconfigure; chỉ đổi thứ tự khoá ⇒ không gì", () => {
    const changed = planDomainApply({
      current: [state(PROM, { retention: "7d", replicas: 1 })],
      currentPreferences: [],
      target: [state(PROM, { retention: "15d", replicas: 1 })],
      targetPreferences: [],
    });
    expect(changed.deployTiers.map(kinds)).toEqual([["reconfigure"]]);
    const reordered = planDomainApply({
      current: [state(PROM, { retention: "7d", replicas: 1 })],
      currentPreferences: [],
      target: [state(PROM, { replicas: 1, retention: "7d" })],
      targetPreferences: [],
    });
    expect(reordered.deployTiers).toEqual([]);
  });

  it("CASE 5: đổi preference giữa hai provider đang chạy ⇒ chỉ rebind, không deploy/teardown", () => {
    const both = [state(PROM), state(VICTORIA), state(FLAGGER)];
    const plan = planDomainApply({
      current: both,
      currentPreferences: [
        {
          capabilityId: "metrics.query",
          providerToolId: "monitoring:prometheus",
        },
      ],
      target: both,
      targetPreferences: [
        { capabilityId: "metrics.query", providerToolId: "logging:victoria" },
      ],
    });
    expect(plan.rebinds).toEqual(["metrics.query"]);
    expect(plan.deployTiers).toEqual([]);
    expect(plan.disables).toEqual([]);
    expect(plan.chosen["metrics.query"]).toBe("logging:victoria");
  });
});
