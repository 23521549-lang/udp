import type { DomainAdapter } from "@udp/adapter-core";
import { ACTIVE_ROLLOUT_STATUSES } from "@udp/config";
import { Prisma } from "@udp/db";
import { redact } from "@udp/http";
import type { CapabilityBinding, CapabilityId } from "@udp/shared-types";
import type { DomainTargetState } from "@udp/shared-types/domain-api";
import { ZodError } from "zod";
import {
  adapterKey,
  consumes,
} from "../modules/capability/capability.resolver.js";
import {
  bindingsOfProject,
  deleteBindingsOfDomainConfig,
  type StoredBinding,
} from "../modules/capability/capability-binding.repository.js";
import { applyDomainChange } from "../modules/capability/domain-config.diff.js";
import {
  notifyDependents,
  type Dependent,
} from "../modules/day2/dependent-notify.js";
import {
  changedBindings,
  restorePort,
  upgradeDomain,
} from "../modules/day2/domain-upgrade.js";
import {
  planDomainApply,
  type ApplyPlan,
  type DomainOp,
  type DomainState,
} from "../modules/domain/domain-apply-plan.js";
import { domainApplyPayloadSchema } from "../modules/domain/domain-apply.payload.js";
import type { DomainAdapterRegistry } from "../modules/domain/domain-adapter.registry.js";
import { catalogAvailability } from "../modules/domain/domain-config.store.js";
import { resolveTarget } from "../modules/domain/domain-target.js";
import { openSecrets, sealSecrets } from "../modules/domain/tool-secrets.js";
import {
  adapterContext,
  callOnTargets,
  distributeRegistryPull,
  lastErrorOf,
  perEnvironment,
  persistDeployed,
  providesRegistry,
  resolvedFor,
  teardownTarget,
  type DeployTarget,
  type DomainErrorStep,
  type DomainPhaseInput,
} from "../modules/provisioning/domain-phase.js";
import { currentState } from "../modules/provisioning/provisioning-job.repository.js";
import {
  messageOf,
  PhaseFailedError,
  type JobInput,
  type JobKit,
  type Run,
} from "./job-kit.js";

/**
 * Job `DOMAIN_APPLY` (§8.2, §8.6, Plan #30 P2): đưa domain của một project ĐANG chạy về
 * trạng thái đích, nâng một domain lên bản adapter mới, hoặc [Plan #45] áp lại một domain về
 * cấu hình đang lưu.
 *
 * Kế hoạch là hàm thuần `planDomainApply`; tệp này THI HÀNH nó, và thứ tự thi hành là nội
 * dung của §8.2:
 *
 * 1. Bật / đổi cấu hình / đổi tool theo bậc của đồ thị ĐÍCH. Đổi tool là blue/green: dựng
 *    tool mới → `healthcheck` → binding mới xuống bảng → `onDependencyChanged` cho mọi
 *    consumer theo bậc → CHỈ SAU ĐÓ gỡ tool cũ. Mới không khoẻ ⇒ gỡ cái mới, GIỮ cái cũ.
 * 2. Đổi preference (CASE 5): báo consumer; binding của cả hai provider đã có trong bảng.
 * 3. Tắt, ngược bậc của đồ thị HIỆN TẠI — sau cùng, khi không consumer nào còn trỏ vào.
 *
 * Một domain lỗi ⇒ domain đó ERROR, domain ĐÍCH cần capability nó cung cấp ⇒ BLOCKED, các
 * domain còn lại vẫn áp; job FAILED kèm danh sách. Không tạo tài nguyên cloud nên không bù
 * trừ cloud (QĐ-2). Trạng thái: `QUEUED → DOMAINS → DONE | FAILED`.
 */

export interface DomainApplyJob {
  run(jobId: string): Promise<void>;
}

interface Failure {
  domainType: string;
  message: string;
}

interface ApplyContext {
  input: DomainPhaseInput;
  plan: ApplyPlan;
  registry: DomainAdapterRegistry;
  /** `domain_type` → id hàng `domain_configs` (đã có hay vừa tạo) */
  rowOf: Map<string, string>;
  /** Trạng thái ĐÍCH theo `domain_type`, để tìm consumer */
  target: Map<string, DomainState>;
  /** Capability mà một domain lỗi trong lượt này lẽ ra phải cung cấp */
  brokenCapabilities: Set<string>;
  failures: Failure[];
}

const provided = (adapter: DomainAdapter): CapabilityId[] =>
  adapter.capabilities.provides.map((p) => p.id);

const bindingOf = (b: StoredBinding): CapabilityBinding => ({
  id: b.capabilityId as CapabilityId,
  version: b.schemaVersion,
  providedBy: b.providedBy,
  ...(b.environmentId === null ? {} : { environmentId: b.environmentId }),
  ...(b.endpoint == null ? {} : { endpoint: b.endpoint }),
  ...(b.attributes == null ? {} : { attributes: b.attributes }),
});

export function createDomainApplyJob(kit: JobKit): DomainApplyJob {
  const { prisma } = kit.deps;

  const markError = (
    domainConfigId: string,
    step: DomainErrorStep,
    message: string,
  ) =>
    prisma.domainConfig.update({
      where: { id: domainConfigId },
      data: { domainStatus: "ERROR", lastError: lastErrorOf(step, message) },
    });

  /** Hàng `domain_configs` của project đang bật — trạng thái ĐANG chạy */
  async function currentStates(
    projectId: string,
    registry: DomainAdapterRegistry,
  ): Promise<{ states: DomainState[]; rowOf: Map<string, string> }> {
    const rows = await prisma.domainConfig.findMany({
      where: { projectId, isEnabled: true, selectedTool: { not: null } },
      select: {
        id: true,
        domainType: true,
        selectedTool: true,
        toolConfig: true,
      },
    });
    const states: DomainState[] = [];
    const rowOf = new Map<string, string>();
    for (const r of rows) {
      rowOf.set(r.domainType, r.id);
      const adapter = registry.get(r.domainType, r.selectedTool ?? "");
      if (adapter === undefined) {
        throw new PhaseFailedError(
          `không còn adapter ${String(r.selectedTool)} cho ${r.domainType} đang chạy`,
        );
      }
      const stored =
        typeof r.toolConfig === "object" &&
        r.toolConfig !== null &&
        !Array.isArray(r.toolConfig)
          ? (r.toolConfig as Record<string, unknown>)
          : {};
      // So cấu hình trên bản RÕ: ciphertext mới mỗi lần lưu không phải "đổi cấu hình" (QĐ-2)
      states.push({
        domainType: r.domainType,
        adapter,
        config: openSecrets({ projectId, domainType: r.domainType }, stored),
      });
    }
    return { states, rowOf };
  }

  /** Consumer ĐÍCH đã chạy, theo bậc, của các capability vừa đổi — trừ chính domain đổi */
  function dependentsOf(
    ctx: ApplyContext,
    capabilities: readonly string[],
    except: string,
  ): Dependent[] {
    const byKey = new Map(
      [...ctx.target.values()].map((t) => [adapterKey(t.adapter), t]),
    );
    return ctx.plan.order.flat().flatMap((key) => {
      const t = byKey.get(key);
      const id = t === undefined ? undefined : ctx.rowOf.get(t.domainType);
      if (t === undefined || id === undefined || t.domainType === except) {
        return [];
      }
      if (!capabilities.some((c) => consumes(t.adapter, c as CapabilityId))) {
        return [];
      }
      return [
        {
          domainConfigId: id,
          adapter: perEnvironment(t.adapter, ctx.input.environments),
          config: t.config,
        },
      ];
    });
  }

  async function notify(
    ctx: ApplyContext,
    changed: readonly CapabilityBinding[],
    except: string,
  ): Promise<void> {
    if (changed.length === 0) return;
    const stored = await bindingsOfProject(prisma, ctx.input.projectId);
    const outcomes = await notifyDependents(
      changed,
      dependentsOf(
        ctx,
        changed.map((b) => b.id),
        except,
      ),
      {
        contextFor: (d) =>
          Promise.resolve(
            adapterContext(
              ctx.input,
              d.adapter,
              undefined,
              resolvedFor(stored, ctx.plan.chosen, null),
            ),
          ),
        recordFailure: async (id, message) => {
          await prisma.domainConfig.update({
            where: { id },
            data: { lastError: lastErrorOf("NOTIFY", message) },
          });
        },
      },
    );
    for (const o of outcomes) {
      if (o.status === "FAILED") {
        ctx.failures.push({
          domainType: o.toolId,
          message: `không nhận được tin ${o.capabilityId}: ${String(o.message)}`,
        });
      }
    }
  }

  const fail = async (
    ctx: ApplyContext,
    t: DeployTarget,
    step: DomainErrorStep,
    message: string,
  ): Promise<void> => {
    await markError(t.id, step, message);
    for (const c of provided(t.adapter)) ctx.brokenCapabilities.add(c);
    ctx.failures.push({ domainType: t.domainType, message });
  };

  /** Đích để deploy: bản rõ cho adapter, bản niêm phong để ghi */
  const targetOf = (
    ctx: ApplyContext,
    id: string,
    t: DomainState,
  ): DeployTarget => ({
    id,
    ...t,
    storedConfig: sealSecrets(
      {
        schema: t.adapter.configSchema,
        projectId: ctx.input.projectId,
        domainType: t.domainType,
      },
      t.config,
    ),
  });

  /** Hàng cho một domain được bật: có sẵn (đã tắt) hay tạo mới, ở DEPLOYING */
  async function rowFor(ctx: ApplyContext, t: DomainState): Promise<string> {
    const toolConfig = targetOf(ctx, "", t)
      .storedConfig as Prisma.InputJsonValue;
    const row = await prisma.domainConfig.upsert({
      where: {
        projectId_domainType: {
          projectId: ctx.input.projectId,
          domainType: t.domainType,
        },
      },
      create: {
        projectId: ctx.input.projectId,
        domainType: t.domainType,
        isEnabled: true,
        selectedTool: t.adapter.toolId,
        toolConfig,
        domainStatus: "DEPLOYING",
      },
      update: {
        isEnabled: true,
        selectedTool: t.adapter.toolId,
        toolConfig,
        domainStatus: "DEPLOYING",
      },
      select: { id: true },
    });
    ctx.rowOf.set(t.domainType, row.id);
    return row.id;
  }

  async function healthy(
    ctx: ApplyContext,
    t: DeployTarget,
  ): Promise<string | null> {
    const res = await perEnvironment(
      t.adapter,
      ctx.input.environments,
    ).healthcheck(adapterContext(ctx.input, t.adapter, undefined, {}));
    if (res.status === "SUCCESS" && res.data?.healthy === true) return null;
    return res.status === "SUCCESS"
      ? (res.data?.details ?? "healthcheck trả healthy = false")
      : (res.message ?? "healthcheck thất bại");
  }

  async function execute(ctx: ApplyContext, op: DomainOp): Promise<void> {
    if (op.kind === "disable") return;
    const blocker = [...ctx.brokenCapabilities].find((c) =>
      consumes(op.target.adapter, c as CapabilityId),
    );
    if (blocker !== undefined) {
      const id = ctx.rowOf.get(op.target.domainType);
      if (id !== undefined) {
        await prisma.domainConfig.update({
          where: { id },
          data: { domainStatus: "BLOCKED" },
        });
      }
      ctx.failures.push({
        domainType: op.target.domainType,
        message: `bị chặn: ${blocker} của một domain lỗi`,
      });
      return;
    }

    if (op.kind === "enable" || op.kind === "reconfigure") {
      const id =
        op.kind === "enable"
          ? await rowFor(ctx, op.target)
          : (ctx.rowOf.get(op.target.domainType) ?? "");
      const t = targetOf(ctx, id, op.target);
      const outcome = await callOnTargets(
        ctx.input,
        t,
        ctx.plan.chosen,
        (c, config) =>
          op.kind === "enable"
            ? t.adapter.deploy(c, config)
            : t.adapter.configure(c, config),
      );
      if ("error" in outcome) {
        await fail(ctx, t, "DEPLOY", outcome.error);
        return;
      }
      await persistDeployed(prisma, t, outcome.bindings, { replace: false });
      return;
    }

    // CASE 3: blue/green — mới dựng và khoẻ TRƯỚC khi cũ bị chạm
    const id = ctx.rowOf.get(op.target.domainType) ?? "";
    const fresh = targetOf(ctx, id, op.target);
    const before = (await bindingsOfProject(prisma, ctx.input.projectId))
      .filter((b) => b.domainConfigId === id)
      .map(bindingOf);
    const deployed = await callOnTargets(
      ctx.input,
      fresh,
      ctx.plan.chosen,
      (c, config) => fresh.adapter.deploy(c, config),
    );
    const problem =
      "error" in deployed
        ? { step: "DEPLOY" as const, message: deployed.error }
        : await healthy(ctx, fresh).then((m) =>
            m === null ? null : { step: "HEALTHCHECK" as const, message: m },
          );
    if (problem !== null || "error" in deployed) {
      // Hoàn tác cái mới; cái cũ chưa hề bị chạm, consumer vẫn trỏ endpoint đang sống
      await teardownTarget(ctx.input, fresh.adapter, "switch").catch(messageOf);
      await fail(
        ctx,
        fresh,
        problem?.step ?? "DEPLOY",
        problem?.message ?? "deploy thất bại",
      );
      return;
    }
    await persistDeployed(prisma, fresh, deployed.bindings, { replace: true });
    await notify(
      ctx,
      changedBindings(before, deployed.bindings),
      op.target.domainType,
    );
    const leftover = await teardownTarget(
      ctx.input,
      op.from.adapter,
      "switch",
    ).catch(messageOf);
    if (leftover !== null) {
      // Tool mới đã chạy; tool cũ còn sót là tốn tiền chứ không sai — nói ra, không hạ cấp
      await prisma.domainConfig.update({
        where: { id },
        data: { lastError: lastErrorOf("TEARDOWN", leftover) },
      });
      ctx.failures.push({
        domainType: op.target.domainType,
        message: `gỡ ${op.from.adapter.toolId} cũ thất bại: ${leftover}`,
      });
    }
  }

  /** CASE 2 — tắt, sau mọi deploy và rebind */
  async function disable(ctx: ApplyContext, from: DomainState): Promise<void> {
    const id = ctx.rowOf.get(from.domainType);
    if (id === undefined) return;
    const message = await teardownTarget(ctx.input, from.adapter, "disable")
      .then((m) => m)
      .catch(messageOf);
    if (message !== null) {
      await markError(id, "TEARDOWN", message);
      ctx.failures.push({ domainType: from.domainType, message });
      return;
    }
    await prisma.$transaction(async (tx) => {
      await deleteBindingsOfDomainConfig(tx, id);
      await tx.domainConfig.update({
        where: { id },
        data: {
          isEnabled: false,
          domainStatus: "PENDING",
          lastError: Prisma.DbNull,
        },
      });
    });
  }

  async function apply(
    run: Run,
    input: JobInput,
    phase: DomainPhaseInput,
    target: DomainTargetState,
  ): Promise<Failure[]> {
    const { registry } = phase;
    let targets;
    try {
      // Payload mang bản niêm phong; mở trong bộ nhớ rồi kiểm bằng CHÍNH configSchema
      const opened = {
        ...target,
        domains: target.domains.map((d) => ({
          ...d,
          config: openSecrets(
            { projectId: input.projectId, domainType: d.domainType },
            d.config,
          ),
        })),
      };
      targets = resolveTarget(opened, registry, await catalogAvailability());
    } catch (e) {
      if (e instanceof ZodError) {
        throw new PhaseFailedError("cấu hình đích không còn khớp schema");
      }
      throw new PhaseFailedError(messageOf(e));
    }
    const current = await currentStates(input.projectId, registry);
    const currentPreferences = await prisma.capabilityPreference.findMany({
      where: { projectId: input.projectId },
      select: { capabilityId: true, providerToolId: true },
    });
    const targetStates: DomainState[] = targets.map((t) => ({
      domainType: t.domainType,
      adapter: t.adapter,
      config: t.config,
    }));
    const plan = planDomainApply({
      current: current.states,
      currentPreferences: currentPreferences.map((p) => ({
        capabilityId: p.capabilityId as CapabilityId,
        providerToolId: p.providerToolId,
      })),
      target: targetStates,
      targetPreferences: target.preferences,
    });
    const ctx: ApplyContext = {
      input: phase,
      plan,
      registry,
      rowOf: current.rowOf,
      target: new Map(targetStates.map((t) => [t.domainType, t])),
      brokenCapabilities: new Set(),
      failures: [],
    };

    for (const tier of plan.deployTiers) {
      await kit.fenceOf(run).assert();
      await Promise.all(tier.map((op) => execute(ctx, op)));
    }

    // CASE 5: provider đổi giữa hai tool đang chạy — binding của cả hai đã có trong bảng
    if (plan.rebinds.length > 0) {
      const stored = await bindingsOfProject(prisma, input.projectId);
      const now = stored
        .filter(
          (b) =>
            plan.rebinds.includes(b.capabilityId as CapabilityId) &&
            b.providedBy === plan.chosen[b.capabilityId],
        )
        .map(bindingOf);
      await notify(ctx, now, "");
    }

    for (const op of plan.disables) {
      await kit.fenceOf(run).assert();
      if (op.kind === "disable") await disable(ctx, op.from);
    }

    // Khoá kéo image theo tập registry SAU lượt áp; registry vừa tắt ⇒ về rỗng (Plan #35)
    const pull = await distributeRegistryPull(phase, targetStates, {
      reset: current.states.some((s) => providesRegistry(s.adapter)),
    });
    if (pull?.status === "FAILED") {
      ctx.failures.push({ domainType: pull.domainType, message: pull.message });
    }

    // Preference ĐÍCH thay cả tập: hàng trỏ tới tool vừa tắt không được sống sót (§5.3)
    await prisma.$transaction(async (tx) => {
      await tx.capabilityPreference.deleteMany({
        where: { projectId: input.projectId },
      });
      if (target.preferences.length > 0) {
        await tx.capabilityPreference.createMany({
          data: target.preferences.map((p) => ({
            projectId: input.projectId,
            ...p,
          })),
        });
      }
    });
    return ctx.failures;
  }

  /** §8.6 nhánh B — một domain lên bản adapter registry đang nạp */
  async function upgrade(
    input: JobInput,
    phase: DomainPhaseInput,
    domainType: string,
  ): Promise<Failure[]> {
    const row = await prisma.domainConfig.findUnique({
      where: {
        projectId_domainType: { projectId: input.projectId, domainType },
      },
      select: {
        id: true,
        selectedTool: true,
        toolConfig: true,
        adapterVersion: true,
        isEnabled: true,
      },
    });
    const adapter =
      row?.selectedTool == null
        ? undefined
        : phase.registry.get(domainType, row.selectedTool);
    if (row === null || !row.isEnabled || adapter === undefined) {
      throw new PhaseFailedError(
        `domain ${domainType} không chạy trên project`,
      );
    }
    if (row.adapterVersion === adapter.version) return [];

    const current = await currentStates(input.projectId, phase.registry);
    const preferences = await prisma.capabilityPreference.findMany({
      where: { projectId: input.projectId },
      select: { capabilityId: true, providerToolId: true },
    });
    const prefs = preferences.map((p) => ({
      capabilityId: p.capabilityId as CapabilityId,
      providerToolId: p.providerToolId,
    }));
    const stored = await bindingsOfProject(prisma, input.projectId);
    const config = openSecrets(
      { projectId: input.projectId, domainType },
      typeof row.toolConfig === "object" && row.toolConfig !== null
        ? (row.toolConfig as Record<string, unknown>)
        : {},
    );
    const wrapped = perEnvironment(adapter, phase.environments);
    const outcome = await upgradeDomain(
      {
        target: wrapped,
        fromVersion: row.adapterVersion ?? "",
        config,
        capabilitiesOfOldVersion: provided(adapter),
        currentBindings: stored
          .filter((b) => b.domainConfigId === row.id)
          .map(bindingOf),
      },
      {
        rolloutInProgress: async () =>
          (await prisma.rolloutSession.count({
            where: {
              projectId: input.projectId,
              status: { in: [...ACTIVE_ROLLOUT_STATUSES] },
            },
          })) > 0,
        declarationsAfterUpgrade: () =>
          current.states.map((s) => ({
            domainType: s.adapter.domainType,
            toolId: s.adapter.toolId,
            capabilities: s.adapter.capabilities,
          })),
        preferences: () => prefs,
        contextFor: () =>
          Promise.resolve(
            adapterContext(
              phase,
              adapter,
              undefined,
              resolvedFor(stored, {}, null),
            ),
          ),
        /** [Plan #61 61d-3a] Hạ về THẬT khi adapter mang được định nghĩa bản cũ — xem `restorePort` */
        rollback: restorePort({
          adapter,
          contextFor: () =>
            Promise.resolve(
              adapterContext(
                phase,
                adapter,
                undefined,
                resolvedFor(stored, {}, null),
              ),
            ),
          config,
          fromVersion: row.adapterVersion ?? "",
        }),
        persist: async ({
          adapterVersion,
          bindings,
          capabilitiesOfOldVersion,
        }) => {
          await applyDomainChange(prisma, input.projectId, {
            domainConfigId: row.id,
            domainType,
            selectedTool: adapter.toolId,
            capabilitiesOfOldTool: capabilitiesOfOldVersion,
            rebind: bindings.map((b) => ({
              capabilityId: b.id,
              providedBy: b.providedBy,
              schemaVersion: b.version,
              endpoint: b.endpoint ?? null,
            })),
            adapterVersion,
          });
        },
        recordError: async (message) => {
          await prisma.domainConfig.update({
            where: { id: row.id },
            data: { lastError: lastErrorOf("DEPLOY", message) },
          });
        },
      },
    );
    if (outcome.status !== "UPGRADED") {
      return [
        {
          domainType,
          message: `${outcome.status}: ${outcome.message ?? ""}`.trim(),
        },
      ];
    }
    const failures: Failure[] = [];
    const targetStates = new Map(current.states.map((s) => [s.domainType, s]));
    const plan = planDomainApply({
      current: current.states,
      currentPreferences: prefs,
      target: current.states,
      targetPreferences: prefs,
    });
    await notify(
      {
        input: phase,
        plan,
        registry: phase.registry,
        rowOf: current.rowOf,
        target: targetStates,
        brokenCapabilities: new Set(),
        failures,
      },
      outcome.changed ?? [],
      domainType,
    );
    return failures;
  }

  /**
   * [v4.11, Plan #45] Áp lại MỘT domain về chính cấu hình đang lưu (§9 `POST …/retry`): domain
   * ERROR/BLOCKED sau một lượt hỏng, hay domain đã trôi mà người vận hành CHỌN ghi đè (§10.13). Cùng
   * đường với CASE 1 — `deploy` trên mọi đích (adapter idempotent theo bộ hợp đồng) — cộng
   * `healthcheck` và báo consumer khi binding đổi, như nâng cấp. Route đã chặn bản adapter lệch:
   * áp lại bằng bản mới hơn là nâng cấp lách validator (§8.6).
   */
  async function reapply(
    run: Run,
    input: JobInput,
    phase: DomainPhaseInput,
    domainType: string,
  ): Promise<Failure[]> {
    const current = await currentStates(input.projectId, phase.registry);
    const state = current.states.find((s) => s.domainType === domainType);
    const id = current.rowOf.get(domainType);
    if (state === undefined || id === undefined) {
      throw new PhaseFailedError(`domain ${domainType} không bật trên project`);
    }
    const prefs = (
      await prisma.capabilityPreference.findMany({
        where: { projectId: input.projectId },
        select: { capabilityId: true, providerToolId: true },
      })
    ).map((p) => ({
      capabilityId: p.capabilityId as CapabilityId,
      providerToolId: p.providerToolId,
    }));
    const plan = planDomainApply({
      current: current.states,
      currentPreferences: prefs,
      target: current.states,
      targetPreferences: prefs,
    });
    const ctx: ApplyContext = {
      input: phase,
      plan,
      registry: phase.registry,
      rowOf: current.rowOf,
      target: new Map(current.states.map((s) => [s.domainType, s])),
      brokenCapabilities: new Set(),
      failures: [],
    };

    await prisma.domainConfig.update({
      where: { id },
      data: { domainStatus: "DEPLOYING" },
    });
    const t = targetOf(ctx, id, state);
    const before = (await bindingsOfProject(prisma, input.projectId))
      .filter((b) => b.domainConfigId === id)
      .map(bindingOf);
    await kit.fenceOf(run).assert();
    const deployed = await callOnTargets(phase, t, plan.chosen, (c, config) =>
      t.adapter.deploy(c, config),
    );
    const problem =
      "error" in deployed
        ? { step: "DEPLOY" as const, message: deployed.error }
        : await healthy(ctx, t).then((m) =>
            m === null ? null : { step: "HEALTHCHECK" as const, message: m },
          );
    if (problem !== null || "error" in deployed) {
      await fail(
        ctx,
        t,
        problem?.step ?? "DEPLOY",
        problem?.message ?? "deploy thất bại",
      );
      return ctx.failures;
    }
    await persistDeployed(prisma, t, deployed.bindings, { replace: true });
    await notify(ctx, changedBindings(before, deployed.bindings), domainType);
    return ctx.failures;
  }

  return {
    run: (jobId) =>
      kit.withLease(jobId, async (run) => {
        const input = await kit.load(jobId);
        const raw = await prisma.provisioningJob.findUniqueOrThrow({
          where: { id: jobId },
          select: { payload: true },
        });
        const { change } = domainApplyPayloadSchema.parse(raw.payload);
        if ((await currentState(prisma, jobId)) === "QUEUED") {
          await kit.advance(run, { state: "DOMAINS", forward: true });
        }

        let failures: Failure[];
        try {
          failures = await kit.withCredential(
            input.projectId,
            async (credential) => {
              const access = await kit.clusterAccessOf(input, credential);
              if (access === null) {
                throw new PhaseFailedError(
                  "không chạm được cluster của project",
                );
              }
              const phase = await kit.domainInput(run, input, access);
              switch (change.kind) {
                case "apply":
                  return apply(run, input, phase, change.target);
                case "upgrade":
                  return upgrade(input, phase, change.domainType);
                case "reapply":
                  return reapply(run, input, phase, change.domainType);
              }
            },
          );
        } catch (e) {
          if (!(e instanceof PhaseFailedError)) throw e;
          failures = [{ domainType: "", message: e.message }];
        }

        await kit.advance(run, {
          state: failures.length === 0 ? "DONE" : "FAILED",
          release: true,
          ...(failures.length === 0
            ? {}
            : {
                lastError: redact({
                  step: "DOMAIN_APPLY",
                  message: failures
                    .map((f) =>
                      f.domainType === ""
                        ? f.message
                        : `${f.domainType}: ${f.message}`,
                    )
                    .join("; "),
                  orphans: [],
                  at: new Date().toISOString(),
                }),
              }),
        });
      }),
  };
}
