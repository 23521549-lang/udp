import { runDomainAdapterContract } from "@udp/adapter-core/contract";
import type { AdapterFixture } from "@udp/adapter-core";
import { domainContractEnv } from "@udp/adapter-core/testing";
import { describe, it } from "vitest";
import {
  HELM_IGNORED_PREFIXES,
  helmDriftMutations,
} from "../../adapter-base/contract-fixtures.js";
import adapter from "./index.js";

/** Linkerd qua đủ bộ hợp đồng (Plan #33 AC-1, AC-5): issuer key chỉ trong Secret */

const pem = (label: string, body: string): string =>
  [`-----BEGIN ${label}-----`, body, `-----END ${label}-----`, ""].join("\n");
const CERT = pem("CERTIFICATE", "MIIBjzCCATWgAwIBAgIQ");
const KEY = pem("EC PRIVATE KEY", "MHcCAQEEIBc2V0X2tleQ");

function fixture(): AdapterFixture {
  return {
    validConfig: {
      trustAnchorPem: CERT,
      issuerCertPem: CERT,
      issuerKeyPem: KEY,
      highAvailability: false,
    },
    invalidConfigs: [
      { trustAnchorPem: CERT, issuerCertPem: CERT },
      {
        trustAnchorPem: "khong-phai-pem",
        issuerCertPem: CERT,
        issuerKeyPem: KEY,
      },
      { trustAnchorPem: CERT, issuerCertPem: KEY, issuerKeyPem: KEY },
    ],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: HELM_IGNORED_PREFIXES,
    driftMutations: helmDriftMutations("udp-linkerd-crds", {
      secrets: true,
      companions: ["udp-linkerd-control-plane"],
    }),
  };
}

describe("linkerd", () => {
  runDomainAdapterContract(adapter, () => domainContractEnv(fixture()), {
    describe,
    it,
  });
});
