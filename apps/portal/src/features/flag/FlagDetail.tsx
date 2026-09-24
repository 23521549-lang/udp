import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
  RulesResponseWire,
} from "@udp/shared-types/wire";
import { Archive, Copy, Lock, Play, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { Switch } from "../../components/Switch";
import { toast } from "../../components/Toast";
import { messageOf } from "../../lib/errors";
import { browserTimeZone, compactNumber, relativeTime } from "../../lib/format";
import { isApiError } from "../../lib/http";
import { qk, qkPrefix } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { flagApi } from "./flag-api";
import { LIFECYCLE_LABEL } from "./flag-labels";
import { RuleCard, variantColor } from "./RuleEditor";
import {
  changeCount,
  draftsFromWire,
  move,
  newRule,
  ruleProblems,
  toReplaceBody,
  type RuleDraft,
} from "./rules-model";

/**
 * Panel xem nhanh của một flag (DESIGN.md §6 "Xem nhanh", §10.8 FlagDetail).
 *
 * Quyền: DEVELOPER sửa ở dev/staging; production cần MAINTAINER (§2.2). Portal ẩn/khoá
 * theo `myRole` — backend vẫn chặn thật.
 */
export function FlagDetail({
  flagId,
  onClose,
}: {
  flagId: string;
  onClose: () => void;
}) {
  const { project, env, setEnv } = useProjectContext();
  const flag = useQuery({
    queryKey: qk.flag(project.id, flagId, env.id),
    queryFn: () => flagApi.get(project.id, flagId),
    staleTime: 10_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="peek" aria-label="Chi tiết flag">
      <div className="ph">
        <span className="mono">{flag.data?.flag.key ?? "…"}</span>
        <button
          type="button"
          className="ib"
          aria-label="Đóng"
          style={{ marginLeft: "auto" }}
          onClick={onClose}
        >
          <Icon of={X} />
        </button>
      </div>
      <div className="inner">
        {flag.isPending ? (
          <Loading />
        ) : flag.isError ? (
          <ErrorState error={flag.error} onRetry={() => void flag.refetch()} />
        ) : (
          <FlagBody flag={flag.data.flag} env={env} onEnv={setEnv} />
        )}
      </div>
    </aside>
  );
}

function FlagBody({
  flag,
  env,
  onEnv,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  onEnv: (envId: string) => void;
}) {
  const { project } = useProjectContext();
  const envState = flag.envs.find((e) => e.environment.id === env.id);
  const canEditEnv = can(
    project.myRole,
    env.isProduction ? "MAINTAINER" : "DEVELOPER",
  );

  return (
    <>
      <h2 className="title mono">{flag.key}</h2>
      <p className="lead">{flag.description ?? "Chưa có mô tả."}</p>
      <dl className="props">
        <dt>Trạng thái</dt>
        <dd>{LIFECYCLE_LABEL[flag.lifecycleStatus]}</dd>
        <dt>Kiểu</dt>
        <dd className="mono">{flag.flagType}</dd>
        <dt>Variant</dt>
        <dd>
          {flag.variants.map((v, i) => (
            <span key={v.id} className="chip">
              <span className="vd" style={{ background: variantColor(i) }} />
              <span className="mono">{v.key}</span>
            </span>
          ))}
        </dd>
        <dt>Cập nhật</dt>
        <dd className="c2">{relativeTime(flag.updatedAt)}</dd>
      </dl>

      <LifecycleActions flag={flag} />

      <div className="envtabs" role="tablist" aria-label="Environment">
        {[...flag.envs]
          .sort((a, b) =>
            a.environment.isProduction === b.environment.isProduction
              ? a.environment.name.localeCompare(b.environment.name)
              : a.environment.isProduction
                ? 1
                : -1,
          )
          .map((e) => (
            <button
              key={e.environment.id}
              type="button"
              role="tab"
              aria-selected={e.environment.id === env.id}
              onClick={() => onEnv(e.environment.id)}
            >
              {e.environment.name}
              {e.environment.isProduction && <Icon of={Lock} size={12} />}
              <span className={e.isEnabled ? "pip on" : "pip"} aria-hidden />
              <span className="visually-hidden">
                {e.isEnabled ? "đang bật" : "đang tắt"}
              </span>
            </button>
          ))}
      </div>

      {envState === undefined ? (
        <p className="c3">Flag chưa có cấu hình ở environment này.</p>
      ) : (
        <>
          <EnvControls
            flag={flag}
            env={env}
            isEnabled={envState.isEnabled}
            defaultVariantId={envState.defaultVariantId}
            canEdit={canEditEnv && flag.lifecycleStatus !== "ARCHIVED"}
          />
          <RulesSection
            flag={flag}
            env={env}
            canEdit={canEditEnv && flag.lifecycleStatus !== "ARCHIVED"}
          />
          <Tester flag={flag} env={env} />
          <StatsSection flag={flag} env={env} />
        </>
      )}
      <SdkSnippet flag={flag} />
    </>
  );
}

// ------------------------------------------------------------- vòng đời

function LifecycleActions({ flag }: { flag: FlagDetailWire }) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"ACTIVE" | "ARCHIVED" | null>(null);

  const update = useMutation({
    mutationFn: (lifecycleStatus: "ACTIVE" | "ARCHIVED") =>
      flagApi.update(project.id, flag.id, {
        lastKnownUpdatedAt: flag.updatedAt,
        lifecycleStatus,
      }),
    onSuccess: async (_d, status) => {
      setConfirm(null);
      toast.info(status === "ACTIVE" ? "Đã kích hoạt flag" : "Đã lưu trữ flag");
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
    },
  });

  if (
    !can(project.myRole, "MAINTAINER") ||
    flag.lifecycleStatus === "ARCHIVED"
  ) {
    return null;
  }

  return (
    <div className="sect">
      {flag.lifecycleStatus === "DRAFT" && (
        <button
          type="button"
          className="btn"
          onClick={() => setConfirm("ACTIVE")}
        >
          <Icon of={Play} />
          Kích hoạt
        </button>
      )}
      <button
        type="button"
        className="btn danger"
        onClick={() => setConfirm("ARCHIVED")}
      >
        <Icon of={Archive} />
        Lưu trữ
      </button>
      {confirm !== null && (
        <ConfirmDialog
          title={confirm === "ACTIVE" ? "Kích hoạt flag?" : "Lưu trữ flag?"}
          description={
            confirm === "ACTIVE"
              ? "SDK sẽ bắt đầu nhận flag này ở mọi environment."
              : "SDK sẽ không còn nhận flag này. Flag đang có rollout chạy thì không lưu trữ được."
          }
          confirmLabel={confirm === "ACTIVE" ? "Kích hoạt" : "Lưu trữ"}
          danger={confirm === "ARCHIVED"}
          busy={update.isPending}
          error={update.isError ? messageOf(update.error) : undefined}
          onConfirm={() => update.mutate(confirm)}
          onClose={() => {
            setConfirm(null);
            update.reset();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- bật/tắt, mặc định

type EnvChange = { isEnabled?: boolean; defaultVariantId?: string | null };

function EnvControls({
  flag,
  env,
  isEnabled,
  defaultVariantId,
  canEdit,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  isEnabled: boolean;
  defaultVariantId: string | null;
  canEdit: boolean;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<EnvChange | null>(null);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: qkPrefix.flagOf(project.id, flag.id),
    });
    await queryClient.invalidateQueries({
      queryKey: qkPrefix.flagsOf(project.id),
    });
    await queryClient.invalidateQueries({
      queryKey: qk.flagEnvs(project.id, flag.id),
    });
  }, [queryClient, project.id, flag.id]);

  const update = useMutation({
    mutationFn: (v: { change: EnvChange; confirmFlagKey?: string }) =>
      flagApi.updateEnv(project.id, flag.id, env.id, {
        ...v.change,
        ...(v.confirmFlagKey === undefined
          ? {}
          : { confirmFlagKey: v.confirmFlagKey }),
      }),
    onSuccess: invalidate,
  });

  /**
   * Production: bật hay đổi mặc định cần gõ lại key (428 `CONFIRMATION_REQUIRED`, §8.4);
   * TẮT (kill-switch) chỉ cần một xác nhận — lúc có sự cố không ai nên phải gõ.
   * Env khác: áp ngay, kèm "Hoàn tác" 5 giây (DESIGN.md §7).
   */
  const request = (change: EnvChange) => {
    if (env.isProduction) {
      setPending(change);
      return;
    }
    const before: EnvChange =
      change.isEnabled !== undefined ? { isEnabled } : { defaultVariantId };
    update.mutate(
      { change },
      {
        onSuccess: () =>
          toast.info(`Đã lưu ở ${env.name}`, () =>
            update.mutate({ change: before }),
          ),
        onError: (e) => toast.error(messageOf(e)),
      },
    );
  };

  const killSwitch =
    pending?.isEnabled === false && pending.defaultVariantId === undefined;

  return (
    <div className="env-controls">
      <div className="sect">
        <h3>Bật ở {env.name}</h3>
        <div className="r">
          <Switch
            checked={isEnabled}
            label={`Bật flag ở ${env.name}`}
            disabled={!canEdit || update.isPending}
            onChange={(next) => request({ isEnabled: next })}
          />
        </div>
      </div>
      <div className="line">
        <label htmlFor="default-variant" className="c3">
          Mặc định khi không rule nào khớp
        </label>
        <select
          id="default-variant"
          className="sel"
          value={defaultVariantId ?? ""}
          disabled={!canEdit || update.isPending}
          onChange={(e) =>
            request({
              defaultVariantId: e.target.value === "" ? null : e.target.value,
            })
          }
        >
          <option value="">(mặc định của flag)</option>
          {flag.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.key}
            </option>
          ))}
        </select>
      </div>
      {pending !== null && (
        <ConfirmDialog
          title={
            killSwitch
              ? `Tắt ${flag.key} ở production?`
              : `Đổi ${flag.key} ở production?`
          }
          description={
            killSwitch
              ? "Mọi người dùng thật sẽ nhận giá trị khi tắt ngay lập tức."
              : "Thay đổi áp cho người dùng thật ngay khi lưu."
          }
          confirmLabel={killSwitch ? "Tắt ngay" : "Áp dụng"}
          danger={killSwitch}
          {...(killSwitch ? {} : { typeToConfirm: flag.key })}
          busy={update.isPending}
          error={update.isError ? messageOf(update.error) : undefined}
          onConfirm={(typed) =>
            update.mutate(
              {
                change: pending,
                ...(typed === undefined ? {} : { confirmFlagKey: typed }),
              },
              {
                onSuccess: () => {
                  setPending(null);
                  toast.info("Đã lưu ở production");
                },
              },
            )
          }
          onClose={() => {
            setPending(null);
            update.reset();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- rule

function RulesSection({
  flag,
  env,
  canEdit,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  canEdit: boolean;
}) {
  const { project } = useProjectContext();
  const rules = useQuery({
    queryKey: qk.flagRules(project.id, flag.id, env.id),
    queryFn: () => flagApi.rules(project.id, flag.id, env.id),
    staleTime: 10_000,
  });

  if (rules.isPending) return <Loading label="Đang tải rule..." />;
  if (rules.isError) {
    return (
      <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
    );
  }
  // `key` theo mốc updatedAt: server đổi ⇒ trình sửa dựng lại từ bản mới
  return (
    <RulesEditor
      key={`${env.id}:${rules.data.updatedAt}`}
      flag={flag}
      env={env}
      server={rules.data}
      canEdit={canEdit}
    />
  );
}

function RulesEditor({
  flag,
  env,
  server,
  canEdit,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
  server: RulesResponseWire;
  canEdit: boolean;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<RuleDraft[]>(() =>
    draftsFromWire(server.rules),
  );
  const [confirmProd, setConfirmProd] = useState(false);

  const changes = changeCount(drafts, server.rules);
  const problems = useMemo(
    () => ruleProblems(drafts, flag.variants),
    [drafts, flag.variants],
  );

  const save = useMutation({
    mutationFn: () =>
      flagApi.replaceRules(
        project.id,
        flag.id,
        env.id,
        toReplaceBody(drafts, server.updatedAt),
      ),
    onSuccess: async (data) => {
      setConfirmProd(false);
      queryClient.setQueryData(qk.flagRules(project.id, flag.id, env.id), data);
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagOf(project.id, flag.id),
      });
      await queryClient.invalidateQueries({
        queryKey: qkPrefix.flagsOf(project.id),
      });
      toast.info(`Đã lưu rule ở ${env.name}`);
    },
    onError: async (e) => {
      setConfirmProd(false);
      toast.error(messageOf(e));
      // 409 OPTIMISTIC_LOCK: tải bản mới; trình sửa dựng lại từ nó (§10.8)
      if (isApiError(e) && e.status === 409) {
        await queryClient.invalidateQueries({
          queryKey: qk.flagRules(project.id, flag.id, env.id),
        });
      }
    },
  });

  const submit = useCallback(() => {
    if (changes === 0 || problems.size > 0 || save.isPending) return;
    if (env.isProduction) setConfirmProd(true);
    else save.mutate();
  }, [changes, problems.size, save, env.isProduction]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [submit]);

  return (
    <section aria-label="Rule">
      <div className="sect">
        <h3>Rule ở {env.name}</h3>
        <span className="c3">xét từ trên xuống</span>
        {canEdit && (
          <div className="r">
            <button
              type="button"
              className="btn"
              onClick={() => setDrafts([...drafts, newRule(flag.variants)])}
            >
              <Icon of={Plus} />
              Thêm rule
            </button>
          </div>
        )}
      </div>
      {drafts.length === 0 && (
        <p className="c3">
          Chưa có rule. Mọi người dùng nhận variant mặc định.
        </p>
      )}
      {drafts.map((rule, i) => (
        <RuleCard
          key={rule.localKey}
          index={i}
          total={drafts.length}
          rule={rule}
          variants={flag.variants}
          projectId={project.id}
          problem={problems.get(i)}
          readOnly={!canEdit}
          onChange={(next) =>
            setDrafts(drafts.map((r, j) => (j === i ? next : r)))
          }
          onMove={(delta) => setDrafts(move(drafts, i, delta))}
          onRemove={() => setDrafts(drafts.filter((_, j) => j !== i))}
        />
      ))}
      <div
        className={changes > 0 ? "savebar on" : "savebar"}
        aria-hidden={changes === 0}
      >
        <span>
          {changes} thay đổi ở {env.name}
        </span>
        <button
          type="button"
          className="btn"
          tabIndex={changes === 0 ? -1 : 0}
          onClick={() => setDrafts(draftsFromWire(server.rules))}
        >
          Bỏ
        </button>
        <button
          type="button"
          className="btn pri"
          tabIndex={changes === 0 ? -1 : 0}
          disabled={problems.size > 0 || save.isPending}
          onClick={submit}
        >
          {save.isPending ? "Đang lưu..." : "Lưu"} <kbd>Ctrl S</kbd>
        </button>
      </div>
      {confirmProd && (
        <ConfirmDialog
          title="Lưu rule ở production?"
          description={`${String(changes)} thay đổi sẽ áp cho người dùng thật.`}
          confirmLabel="Lưu"
          busy={save.isPending}
          onConfirm={() => save.mutate()}
          onClose={() => setConfirmProd(false)}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------- tester

/**
 * Flag Evaluation Tester (§10.12): context giả → value, variant, reason, rule đã khớp.
 * Dùng CÙNG hàm đánh giá với SDK (I26), và thử được cả flag DRAFT.
 */
function Tester({
  flag,
  env,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
}) {
  const { project } = useProjectContext();
  const [targetingKey, setTargetingKey] = useState("user-1");
  const [attrs, setAttrs] = useState("country=VN");

  const run = useMutation({
    mutationFn: () => {
      const context: Record<string, unknown> = { targetingKey };
      for (const line of attrs.split(/\n|;/)) {
        const [k, ...v] = line.split("=");
        const key = k?.trim() ?? "";
        if (key !== "") context[key] = v.join("=").trim();
      }
      return flagApi.evaluate(project.id, flag.id, env.id, context);
    },
  });
  const result = run.data;
  const variantKey = result?.evaluation.variant;

  return (
    <section aria-label="Thử đánh giá">
      <div className="sect">
        <h3>Thử đánh giá</h3>
      </div>
      <div className="tester">
        <div className="f">
          <label htmlFor="t-key">targetingKey</label>
          <input
            id="t-key"
            className="inp mono"
            value={targetingKey}
            onChange={(e) => setTargetingKey(e.target.value)}
          />
        </div>
        <div className="f">
          <label htmlFor="t-attrs">Thuộc tính (mỗi dòng key=value)</label>
          <textarea
            id="t-attrs"
            className="inp mono"
            rows={2}
            value={attrs}
            onChange={(e) => setAttrs(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? "Đang đánh giá..." : "Đánh giá"}
        </button>
      </div>
      {run.isError && <p className="field-error">{messageOf(run.error)}</p>}
      {result !== undefined && (
        <dl className="props" aria-label="Kết quả đánh giá">
          <dt>Giá trị</dt>
          <dd className="mono">{JSON.stringify(result.evaluation.value)}</dd>
          <dt>Variant</dt>
          <dd className="mono">{variantKey ?? "(không có)"}</dd>
          <dt>Lý do</dt>
          <dd className="mono">{result.evaluation.reason}</dd>
          <dt>Rule khớp</dt>
          <dd>
            {result.rule === undefined
              ? "Không rule nào"
              : `Rule ưu tiên ${String(result.rule.priority)} (${result.rule.ruleType})`}
          </dd>
          {result.draft && (
            <>
              <dt>Lưu ý</dt>
              <dd className="c3">Flag còn nháp: SDK chưa thấy nó.</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

// ------------------------------------------------------------- stats

function StatsSection({
  flag,
  env,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
}) {
  const { project } = useProjectContext();
  const tz = browserTimeZone();
  const days = 7;
  const stats = useQuery({
    queryKey: qk.flagStats(project.id, flag.id, env.id, days, "day", tz),
    queryFn: () => flagApi.stats(project.id, flag.id, env.id, days, tz),
  });
  const byEnv = stats.data?.byEnv.find((b) => b.environment.id === env.id);

  return (
    <section aria-label="Thống kê">
      <div className="sect">
        <h3>7 ngày qua ở {env.name}</h3>
      </div>
      {stats.isPending ? (
        <Loading />
      ) : stats.isError ? (
        <ErrorState error={stats.error} />
      ) : byEnv === undefined || byEnv.evalCount === 0 ? (
        <p className="c3">Chưa có lượt đánh giá nào được báo về.</p>
      ) : (
        <div className="dist">
          <div className="bar2" aria-hidden="true">
            {byEnv.variants.map((v, i) => (
              <i
                key={v.variantKey}
                style={{
                  width: `${String(v.share * 100)}%`,
                  background: variantColor(i),
                }}
              />
            ))}
          </div>
          {byEnv.variants.map((v, i) => (
            <div key={v.variantKey} className="dr">
              <span className="vd" style={{ background: variantColor(i) }} />
              <span className="mono">{v.variantKey}</span>
              <span className="num c3">{compactNumber(v.count)} lượt</span>
              <span className="pct">{Math.round(v.share * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------- SDK

function SdkSnippet({ flag }: { flag: FlagDetailWire }) {
  const [lang, setLang] = useState<"node" | "python">("node");
  const method: Record<FlagDetailWire["flagType"], [string, string, string]> = {
    BOOLEAN: ["getBooleanValue", "get_boolean_value", "false"],
    STRING: ["getStringValue", "get_string_value", '""'],
    NUMBER: ["getNumberValue", "get_float_value", "0"],
    JSON: ["getObjectValue", "get_object_value", "{}"],
  };
  const [js, py, fallback] = method[flag.flagType];
  const code =
    lang === "node"
      ? `const value = await client.${js}("${flag.key}", ${fallback}, {\n  targetingKey: user.id,\n});`
      : `value = client.${py}("${flag.key}", ${fallback === "false" ? "False" : fallback}, EvaluationContext(user.id))`;

  return (
    <section aria-label="Dùng trong mã">
      <div className="sect">
        <h3>Dùng trong mã</h3>
        <div className="r seg" role="group" aria-label="Ngôn ngữ">
          <button
            type="button"
            aria-pressed={lang === "node"}
            onClick={() => setLang("node")}
          >
            Node.js
          </button>
          <button
            type="button"
            aria-pressed={lang === "python"}
            onClick={() => setLang("python")}
          >
            Python
          </button>
        </div>
      </div>
      <div className="code">
        <pre>{code}</pre>
        <button
          type="button"
          className="ib cp"
          aria-label="Sao chép"
          onClick={() => {
            // clipboard vắng mặt ngoài HTTPS dù kiểu DOM nói có: đi qua Promise để thành lỗi bắt được
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(code))
              .then(
                () => toast.info("Đã sao chép"),
                () => toast.error("Không sao chép được"),
              );
          }}
        >
          <Icon of={Copy} />
        </button>
      </div>
    </section>
  );
}
