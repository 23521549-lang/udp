import { useQuery } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
} from "@udp/shared-types/wire";
import { Lock, X } from "lucide-react";
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { relativeTime } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { EnvControls } from "./detail/EnvControls";
import { LifecycleActions } from "./detail/LifecycleActions";
import { RulesSection } from "./detail/RulesSection";
import { SdkSnippet } from "./detail/SdkSnippet";
import { StatsSection } from "./detail/StatsSection";
import { Tester } from "./detail/Tester";
import { VariantsSection } from "./detail/VariantsSection";
import { flagApi } from "./flag-api";
import { LIFECYCLE_LABEL } from "./flag-labels";

import { variantColor } from "./RuleEditor";

const tabId = (envId: string): string => `flag-envtab-${envId}`;

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
      if (e.key !== "Escape" || document.querySelector("[role=dialog]")) {
        return;
      }
      // Esc trong một ô đang gõ là "thôi gõ", không phải "đóng panel và bỏ mọi nháp"
      const t = e.target as HTMLElement | null;
      if (
        t !== null &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        t.blur();
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
   * Trên điện thoại panel phủ cả màn hình: focus phải vào trong nó, nếu không bàn phím và trình đọc
   * màn hình vẫn ở danh sách nằm bên dưới. Trên máy tính giữ focus ở danh sách để j/k đi tiếp.
   */
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    try {
      if (window.matchMedia("(max-width: 860px)").matches)
        panel.current?.focus();
    } catch {
      // jsdom không có matchMedia
    }
  }, [flagId]);

  return (
    <aside
      ref={panel}
      className="peek"
      aria-label="Chi tiết flag"
      tabIndex={-1}
    >
      <div className="ph">
        <span className="mono" translate="no">
          {flag.data?.flag.key ?? "…"}
        </span>
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
  const tabs = [...flag.envs].sort((a, b) =>
    a.environment.isProduction === b.environment.isProduction
      ? a.environment.name.localeCompare(b.environment.name)
      : a.environment.isProduction
        ? 1
        : -1,
  );
  /** Tab theo mẫu WAI-ARIA: mũi tên trái/phải, Home/End đổi tab và dời focus theo */
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.environment.id === env.id);
    const next =
      e.key === "ArrowRight"
        ? tabs[(i + 1) % tabs.length]
        : e.key === "ArrowLeft"
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === "Home"
            ? tabs[0]
            : e.key === "End"
              ? tabs[tabs.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onEnv(next.environment.id);
    requestAnimationFrame(() =>
      document.getElementById(tabId(next.environment.id))?.focus(),
    );
  };

  return (
    <>
      <h2 className="title mono" translate="no">
        {flag.key}
      </h2>
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
      <VariantsSection flag={flag} />

      <div
        className="envtabs"
        role="tablist"
        aria-label="Environment"
        onKeyDown={onTabKey}
      >
        {tabs.map((e) => (
          <button
            key={e.environment.id}
            id={tabId(e.environment.id)}
            type="button"
            role="tab"
            aria-selected={e.environment.id === env.id}
            aria-controls="flag-envpanel"
            tabIndex={e.environment.id === env.id ? 0 : -1}
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

      <div id="flag-envpanel" role="tabpanel" aria-labelledby={tabId(env.id)}>
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
      </div>
      <SdkSnippet flag={flag} />
    </>
  );
}
