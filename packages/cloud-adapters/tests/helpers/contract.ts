import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudAdapter, CloudProvider } from "@udp/adapter-core";
import {
  runCloudAdapterContract,
  type CloudContractEnv,
} from "@udp/adapter-core/contract";
import {
  InMemoryLedger,
  SimCloud,
  type CloudFixture,
} from "@udp/adapter-core/testing";
import { afterAll, describe, it } from "vitest";
import {
  createPlannedAdapter,
  type ProviderPlan,
  type TagCodec,
} from "../../src/index.js";
import { createSimGateway } from "../../src/testing/index.js";

/**
 * Chạy đủ bộ hợp đồng Cloud cho MỘT kế hoạch thật trên cổng mô phỏng — cùng một vỏ cho
 * cả ba cloud, để ba lần chạy chỉ khác nhau ở đúng ba thứ: kế hoạch, codec, fixture.
 */
export function runPlanContract(args: {
  label: string;
  provider: CloudProvider;
  plan: ProviderPlan;
  codec: TagCodec;
  /** Viết tay — bộ hợp đồng cấm suy kỳ vọng từ chính danh sách step của adapter */
  fixture: CloudFixture;
}): void {
  const cleanups: (() => void)[] = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  const adapterOn = (cloud: SimCloud, label = "du-quyen"): CloudAdapter =>
    createPlannedAdapter({
      plan: args.plan,
      gatewayFor: () =>
        createSimGateway({
          cloud,
          provider: args.provider,
          codec: args.codec,
          credentialLabel: label,
        }),
      waitReady: { intervalMs: 0, timeoutMs: 1_000 },
      teardown: { waitTimeoutMs: 2_000, pollIntervalMs: 1 },
      sleep: () => Promise.resolve(),
    });

  const makeEnv = (): CloudContractEnv => {
    const dir = mkdtempSync(join(tmpdir(), `cloud-${args.provider}-`));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // Mô phỏng ĐÚNG tính chất gắn tag của cloud này, không phải của cloud chung mặc định
    const cloud = new SimCloud({
      statePath: join(dir, "cloud.json"),
      kindsWithoutCreateTags: args.plan.kindsWithoutCreateTags,
    });
    return {
      driver: "in-process",
      ledger: () => new InMemoryLedger(),
      control: cloud,
      fixture: args.fixture,
      adapterWithCredentialLabel: (label) => adapterOn(cloud, label),
    };
  };

  runCloudAdapterContract(
    {
      describe: (name, fn) => {
        describe(name, () => {
          fn();
        });
      },
      it: (name, fn) => {
        it(name, fn);
      },
    },
    args.label,
    makeEnv,
    (env) => adapterOn(env.control as SimCloud),
  );
}
