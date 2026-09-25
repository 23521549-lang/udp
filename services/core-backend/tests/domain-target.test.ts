import type { DomainAdapter } from "@udp/adapter-core";
import type { DomainTargetState } from "@udp/shared-types/domain-api";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import type { DomainAdapterRegistry } from "../src/modules/domain/domain-adapter.registry.js";
import {
  resolveTarget,
  validateTarget,
  validationView,
} from "../src/modules/domain/domain-target.js";
import datadog from "../src/modules/monitoring-adapter/datadog/index.js";
import prometheus from "../src/modules/monitoring-adapter/prometheus-grafana/index.js";

/**
 * Trạng thái đích và gợi ý hành động (Plan #27 QĐ-4, QĐ-5, AC-3) — thuần trên registry.
 * Hai adapter thật cộng hai adapter dựng từ chúng cho những domain chưa có tool thật.
 */

const like = (
  base: DomainAdapter,
  over: Pick<DomainAdapter, "domainType" | "toolId" | "capabilities">,
): DomainAdapter => ({ ...base, ...over });

const harbor = like(datadog, {
  domainType: "CONTAINER_REGISTRY",
  toolId: "harbor",
  capabilities: {
    provides: [{ id: "registry.oci", version: "1.0.0" }],
    requires: [],
  },
});
const flagger = like(datadog, {
  domainType: "PROGRESSIVE_DELIVERY",
  toolId: "flagger",
  capabilities: {
    provides: [{ id: "traffic.control", version: "1.0.0", exclusive: true }],
    requires: [{ id: "metrics.query", constraint: ">=1" }],
  },
});

function registryOf(adapters: DomainAdapter[]): DomainAdapterRegistry {
  const loaded = adapters.map((adapter) => ({
    key: `${adapter.domainType}:${adapter.toolId}`.toLowerCase(),
    adapter,
    at: "test",
  }));
  return {
    get: (d, t) =>
      loaded.find((l) => l.key === `${d}:${t}`.toLowerCase())?.adapter,
    all: () => loaded,
  };
}

const REGISTRY = registryOf([datadog, prometheus, harbor, flagger]);
const ALL_AVAILABLE = new Map(
  ["MONITORING", "CONTAINER_REGISTRY", "PROGRESSIVE_DELIVERY", "LOGGING"].map(
    (d) => [d, true],
  ),
);

const DATADOG_CONFIG = { site: "datadoghq.com", credentialRef: "dd" };
const PROM_CONFIG = { retentionDays: 7 };

const run = (state: DomainTargetState, registry = REGISTRY) => {
  const targets = resolveTarget(state, registry, ALL_AVAILABLE);
  return validationView(validateTarget(targets, state), targets, registry);
};

describe("gợi ý hành động", () => {
  it("thiếu metrics.query ⇒ bật đúng tool thoả ràng buộc của consumer", () => {
    const strict = like(flagger, {
      ...flagger,
      capabilities: {
        ...flagger.capabilities,
        requires: [{ id: "metrics.query", constraint: "^2" }],
      },
    });
    const view = run(
      {
        domains: [
          {
            domainType: "PROGRESSIVE_DELIVERY",
            toolId: "flagger",
            config: DATADOG_CONFIG,
          },
        ],
        preferences: [],
      },
      registryOf([datadog, prometheus, harbor, strict]),
    );
    // datadog cung cấp metrics.query 1.0.0 — không thoả ^2, nên KHÔNG được gợi ý
    expect(view.errors).toEqual([
      {
        code: "MISSING_CAPABILITY",
        subject: "progressive_delivery:flagger",
        detail: ["metrics.query"],
        suggestedAction: {
          type: "ENABLE_DOMAIN",
          domainType: "MONITORING",
          toolId: "prometheus-grafana",
          capabilityId: "metrics.query",
        },
      },
    ]);
  });

  it("không tool nào cung cấp ⇒ không gợi ý (không gửi người dùng vào lỗi kế tiếp)", () => {
    const view = run(
      {
        domains: [
          {
            domainType: "MONITORING",
            toolId: "prometheus-grafana",
            config: PROM_CONFIG,
          },
        ],
        preferences: [],
      },
      registryOf([prometheus]),
    );
    expect(view.errors).toEqual([
      {
        code: "MISSING_CAPABILITY",
        subject: "monitoring:prometheus-grafana",
        detail: ["registry.oci"],
      },
    ]);
  });

  it("hai provider cùng thoả ⇒ CHOOSE_PROVIDER; chọn rồi thì hợp lệ và có thứ tự triển khai", () => {
    const both: DomainTargetState = {
      domains: [
        {
          domainType: "CONTAINER_REGISTRY",
          toolId: "harbor",
          config: DATADOG_CONFIG,
        },
        {
          domainType: "MONITORING",
          toolId: "prometheus-grafana",
          config: PROM_CONFIG,
        },
        {
          domainType: "PROGRESSIVE_DELIVERY",
          toolId: "flagger",
          config: DATADOG_CONFIG,
        },
      ],
      preferences: [],
    };
    const withDatadog = registryOf([
      datadog,
      prometheus,
      harbor,
      flagger,
      like(datadog, {
        ...datadog,
        domainType: "LOGGING",
        toolId: "datadog-logs",
      }),
    ]);
    const ambiguous = run(
      {
        ...both,
        domains: [
          ...both.domains,
          {
            domainType: "LOGGING",
            toolId: "datadog-logs",
            config: DATADOG_CONFIG,
          },
        ],
      },
      withDatadog,
    );
    expect(ambiguous.errors[0]).toMatchObject({
      code: "AMBIGUOUS_PROVIDER",
      subject: "metrics.query",
      suggestedAction: {
        type: "CHOOSE_PROVIDER",
        domainType: "LOGGING",
        capabilityId: "metrics.query",
      },
    });

    const chosen = run(both);
    expect(chosen.valid).toBe(true);
    expect(chosen.deployOrder).toEqual([
      ["container_registry:harbor"],
      ["monitoring:prometheus-grafana"],
      ["progressive_delivery:flagger"],
    ]);
  });
});

describe("trạng thái đích sai", () => {
  it("config sai ⇒ lỗi trường mang đúng đường dẫn trong body", () => {
    try {
      run({
        domains: [
          {
            domainType: "MONITORING",
            toolId: "datadog",
            config: { site: "x" },
          },
        ],
        preferences: [],
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError);
      expect((e as ZodError).issues.map((i) => i.path.join("."))).toEqual([
        "domains.0.config.site",
        "domains.0.config.credentialRef",
      ]);
    }
  });

  it("preference trỏ tool không bật ⇒ lỗi trường, không phải lỗi khởi động của resolver", () => {
    expect(() =>
      run({
        domains: [
          {
            domainType: "MONITORING",
            toolId: "datadog",
            config: DATADOG_CONFIG,
          },
        ],
        preferences: [
          {
            capabilityId: "metrics.query",
            providerToolId: "monitoring:prometheus-grafana",
          },
        ],
      }),
    ).toThrow(ZodError);
  });

  it("tool lạ, hay domain đã gỡ khỏi catalog ⇒ 422 slug riêng", () => {
    expect(() =>
      run({
        domains: [{ domainType: "MONITORING", toolId: "khong-co", config: {} }],
        preferences: [],
      }),
    ).toThrow(/Không có tool/);
    expect(() =>
      resolveTarget(
        {
          domains: [
            {
              domainType: "MONITORING",
              toolId: "datadog",
              config: DATADOG_CONFIG,
            },
          ],
          preferences: [],
        },
        REGISTRY,
        new Map([["MONITORING", false]]),
      ),
    ).toThrow(/không còn dùng được/);
  });
});
