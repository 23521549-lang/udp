import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeConfigSchema } from "../src/modules/domain/config-fields.js";
import { datadogConfigSchema } from "../src/modules/monitoring-adapter/datadog/index.js";
import { prometheusGrafanaConfigSchema } from "../src/modules/monitoring-adapter/prometheus-grafana/index.js";

/** Form cấu hình dựng từ `configSchema` của adapter (Plan #27 QĐ-3, AC-2) */

describe("describeConfigSchema", () => {
  it("prometheus-grafana: số nguyên có biên, boolean và số có mặc định", () => {
    expect(describeConfigSchema(prometheusGrafanaConfigSchema)).toEqual({
      kind: "object",
      fields: [
        {
          key: "retentionDays",
          kind: "number",
          required: true,
          min: 1,
          max: 365,
          integer: true,
        },
        { key: "dashboards", kind: "boolean", required: false, default: true },
        {
          key: "storageGb",
          kind: "number",
          required: false,
          default: 20,
          min: 1,
          max: 1000,
          integer: true,
        },
      ],
    });
  });

  it("datadog: enum mang đủ lựa chọn, chuỗi bắt buộc", () => {
    const d = describeConfigSchema(datadogConfigSchema);
    expect(d.kind === "object" && d.fields.slice(0, 2)).toEqual([
      {
        key: "site",
        kind: "enum",
        required: true,
        options: ["datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com"],
      },
      { key: "credentialRef", kind: "string", required: true },
    ]);
  });

  it("kiểu không vẽ được thành ô JSON, không bị bỏ im; optional/nullable là không bắt buộc", () => {
    const d = describeConfigSchema(
      z.object({
        nested: z.object({ a: z.string() }),
        list: z.array(z.string()).optional(),
        note: z.string().nullable(),
      }),
    );
    expect(d).toEqual({
      kind: "object",
      fields: [
        { key: "nested", kind: "json", required: true },
        { key: "list", kind: "json", required: false },
        { key: "note", kind: "string", required: false },
      ],
    });
  });

  it("schema không phải object ⇒ cả cấu hình là một ô JSON", () => {
    expect(describeConfigSchema(z.record(z.string()))).toEqual({
      kind: "json",
    });
  });
});
