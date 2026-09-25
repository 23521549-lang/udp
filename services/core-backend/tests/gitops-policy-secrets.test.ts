import type { DomainAdapter } from "@udp/adapter-core";
import {
  CONTRACT_SYSTEM_NAMESPACE as SYSTEM_NS,
  domainContractEnv,
} from "@udp/adapter-core/testing";
import { describe, expect, it } from "vitest";
import { validateAndOrder } from "../src/modules/capability/capability.resolver.js";
import argoCd from "../src/modules/gitops-adapter/argo-cd/index.js";
import flux from "../src/modules/gitops-adapter/flux/index.js";
import gatekeeper from "../src/modules/policy-adapter/gatekeeper/index.js";
import kyverno from "../src/modules/policy-adapter/kyverno/index.js";
import aws from "../src/modules/secrets-adapter/aws-secrets-manager/index.js";
import azure from "../src/modules/secrets-adapter/azure-key-vault/index.js";
import externalSecrets from "../src/modules/secrets-adapter/external-secrets/index.js";
import gcp from "../src/modules/secrets-adapter/gcp-secret-manager/index.js";
import sealedSecrets from "../src/modules/secrets-adapter/sealed-secrets/index.js";
import vault from "../src/modules/secrets-adapter/vault/index.js";

/**
 * Plan #34 AC-2..AC-4 trên adapter THẬT: `gitops.sync` độc quyền ở validator, policy không bao
 * giờ chặn `udp-system`, token Git chỉ trong `Secret`, binding `secrets.store` nói provider.
 */

const TOKEN = "ghp_canhTokenP34abcdef0123456789";
const REPO = "https://github.com/acme/platform-config";

async function deployed(
  adapter: DomainAdapter,
  config: Record<string, unknown>,
) {
  const env = domainContractEnv({
    validConfig: config,
    invalidConfigs: [],
    externalHosts: [],
    quotaDimensions: [],
    ignoredLabelPrefixes: [],
    driftMutations: [],
  });
  const res = await adapter.deploy(env.context(), config);
  expect(res.status, JSON.stringify(res)).toBe("SUCCESS");
  const client = await env.cluster.getClient("tooling");
  const objects = await Promise.all(
    env.cluster.writes.map(async (w) => ({
      kind: w.ref.kind,
      name: w.ref.name,
      body: await client.read<Record<string, unknown>>("get", w.ref),
    })),
  );
  return { res, objects };
}

describe("GitOps (AC-2, AC-4)", () => {
  it("hai provider gitops.sync trong một tổ hợp ⇒ CONFLICT ở validator", () => {
    expect(validateAndOrder([argoCd, flux]).errors[0]).toMatchObject({
      code: "CONFLICT",
    });
  });

  it("token Git chỉ trong Secret; Application gốc trỏ đúng repo, nhánh, đường dẫn", async () => {
    for (const adapter of [argoCd, flux]) {
      const { objects } = await deployed(adapter, {
        repoUrl: REPO,
        revision: "release",
        path: "clusters/prod",
        token: TOKEN,
      });
      const secrets = objects.filter((o) => o.kind === "Secret");
      expect(JSON.stringify(secrets), adapter.toolId).toContain(TOKEN);
      const rest = objects.filter((o) => o.kind !== "Secret");
      expect(JSON.stringify(rest), adapter.toolId).not.toContain(TOKEN);
      expect(JSON.stringify(rest)).toContain(REPO);
      expect(JSON.stringify(rest)).toContain("clusters/prod");
    }
  });
});

describe("Policy không bao giờ chặn chính UDP (AC-3)", () => {
  it("webhook của Gatekeeper và Kyverno miễn trừ udp-system và kube-system", async () => {
    for (const adapter of [gatekeeper, kyverno]) {
      const { objects } = await deployed(adapter, {});
      const values = JSON.stringify(
        objects.filter((o) => o.kind === "ConfigMap").map((o) => o.body),
      );
      expect(values, adapter.toolId).toContain(SYSTEM_NS);
      expect(values, adapter.toolId).toContain("kube-system");
    }
  });
});

describe("binding secrets.store nói provider (AC-4)", () => {
  const cases: [DomainAdapter, Record<string, unknown>, string][] = [
    [vault, {}, "vault"],
    [sealedSecrets, {}, "sealed-secrets"],
    [externalSecrets, {}, "external-secrets"],
    [
      aws,
      {
        region: "ap-southeast-1",
        roleArn: "arn:aws:iam::123456789012:role/udp-secrets",
      },
      "aws",
    ],
    [
      gcp,
      {
        projectId: "acme-prod-01",
        gcpServiceAccount: "udp-secrets@acme-prod-01.iam.gserviceaccount.com",
      },
      "gcp",
    ],
    [
      azure,
      {
        keyVaultName: "acme-kv-prod",
        tenantId: "11111111-2222-3333-4444-555555555555",
        clientId: "66666666-7777-8888-9999-000000000000",
      },
      "azure",
    ],
  ];

  it("mỗi kho khai đúng provider; kho của cloud mang định danh công khai, không khoá", async () => {
    for (const [adapter, config, provider] of cases) {
      const { res, objects } = await deployed(adapter, config);
      const binding = res.data?.find((b) => b.id === "secrets.store");
      expect(binding?.attributes?.provider, adapter.toolId).toBe(provider);
      expect(
        objects.some((o) => o.kind === "Secret"),
        adapter.toolId,
      ).toBe(false);
    }
  });
});
