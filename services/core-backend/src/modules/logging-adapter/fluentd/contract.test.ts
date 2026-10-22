import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";
import { logsSinkBinding } from "../../adapter-base/logs-sink.js";

/** Fluentd qua đủ bộ hợp đồng (Plan #32 AC-1, AC-4): forwarder có buffer đĩa ⇒ tiêu thụ maxStorageGb */

/** Sink ở domain Monitoring — Datadog, khoá trong Secret kết nối của adapter SaaS */
const SINK = logsSinkBinding("monitoring:datadog", {
  protocol: "datadog",
  endpoint: "https://http-intake.logs.datadoghq.com/api/v2/logs",
  credential: {
    secretName: "udp-datadog-connection-key",
    secretKey: "api-key",
  },
});

function fixture(): AdapterFixture {
  return {
    validConfig: { bufferGb: 5 },
    invalidConfigs: [{ bufferGb: 0 }, { bufferGb: 500 }, { bufferGb: "năm" }],
    externalHosts: [],
    quotaDimensions: ["maxStorageGb"],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-fluentd"),
  };
}

describe("fluentd", () => {
  runDomainAdapterContract(
    adapter,
    () => domainContractEnv(fixture(), { resolved: { "logs.sink": SINK } }),
    {
      describe,
      it,
    },
  );
});
