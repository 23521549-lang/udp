import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IN_CLUSTER_CI } from "@udp/shared-types";
import type { CicdStatusWire } from "@udp/shared-types/wire";
import { KeyRound, ShieldCheck, Workflow } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { useMessages } from "../../i18n";
import { messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { domainApi } from "./domain-api";
import { domainMessages } from "./domain.messages";

/**
 * Webhook CI/CD (§8.3, Plan #36 QĐ-2, QĐ-6): đường để dán vào CI, secret ký webhook và pipeline
 * Golden Path của tool đang bật. Đọc — VIEWER; xem template — DEVELOPER (người dán nó vào repo);
 * sinh/xoay secret — MAINTAINER, cùng bậc với lưu cấu hình domain (§8.6).
 */
/**
 * [Plan #61 61d-2a] Trạng thái Trusted Deploy, nói đúng lý do khi chưa khả dụng.
 *
 * "Chưa khả dụng" KHÔNG được hiển thị như "đang tắt": tắt là một lựa chọn, còn chưa khả dụng là UDP không
 * kiểm được token của CI đang bật — và người dùng phải biết phải làm gì để mở nó.
 */
function trustedDeployText(
  state: CicdStatusWire["trustedDeploy"],
  m: { [k: string]: unknown },
): string {
  const text = (key: string) => String(m[key]);
  if (state.required) return text("trustedDeployOn");
  if (state.unavailableReason === "CLUSTER_NOT_READY") {
    return text("trustedDeployClusterNotReady");
  }
  if (state.unavailableReason === "MISSING_CIRCLECI_IDS") {
    return text("trustedDeployCircleciIds");
  }
  return text("trustedDeployWaiting");
}

export function CicdPanel() {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: qk.cicd(project.id),
    queryFn: () => domainApi.cicd(project.id),
  });
  // [Plan #61 61d-2a] Bật/tắt Trusted Deploy — thao tác riêng, không đi kèm lưu cấu hình domain
  const oidc = useMutation({
    mutationFn: (required: boolean) =>
      domainApi.setOidcRequired(project.id, required),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.cicd(project.id) });
    },
  });
  const [showTemplate, setShowTemplate] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const m = useMessages(domainMessages).cicd;

  if (status.isPending) return <Loading />;
  if (status.isError) return <ErrorState error={status.error} />;
  const { cicd } = status.data;
  if (cicd.provider === null || cicd.webhookPath === null) return null;

  return (
    <section aria-label={m.title}>
      <h2 className="h2">{m.title}</h2>
      <p className="c3">{m.lead}</p>
      {/*
        [Plan #61 61d-2a] In chuỗi của MÁY CHỦ, không ghép từ `window.location.origin`.
        Trusted Deploy đòi `aud` của token bằng đúng chuỗi mà bộ kiểm mong đợi, mà bộ kiểm chỉ
        có cấu hình máy chủ — ghép ở trình duyệt thì hai bên lệch một dấu `/` là 401 vĩnh viễn
        và không có gì chẩn đoán được.
      */}
      <CodeBlock
        code={cicd.webhookUrl ?? ""}
        label={m.url}
        copyLabel={m.copyUrl}
      />
      <dl className="props">
        <dt>{m.secret}</dt>
        <dd>{cicd.secretSet ? m.secretSet : m.secretUnset}</dd>
        <dt>{m.trustedDeploy}</dt>
        <dd>{trustedDeployText(cicd.trustedDeploy, m)}</dd>
      </dl>
      {/* [Plan #61 61d-2b-1] Bậc bảo đảm của CI trong cụm yếu hơn ba CI SaaS, và phải nói ra */}
      {IN_CLUSTER_CI.some((name: string) => name === cicd.provider) && (
        <p className="c3">{m.trustedDeployClusterOnly}</p>
      )}
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        {can(project.myRole, "MAINTAINER") && (
          <button
            type="button"
            className="btn"
            onClick={() => setSecretOpen(true)}
          >
            <Icon of={KeyRound} />
            {cicd.secretSet ? m.rotate : m.generate}
          </button>
        )}
        {can(project.myRole, "MAINTAINER") && cicd.trustedDeploy.available && (
          <button
            type="button"
            className="btn"
            disabled={oidc.isPending}
            onClick={() => oidc.mutate(!cicd.trustedDeploy.required)}
          >
            <Icon of={ShieldCheck} />
            {cicd.trustedDeploy.required
              ? m.trustedDeployRelease
              : m.trustedDeployRequire}
          </button>
        )}
        {can(project.myRole, "DEVELOPER") && (
          <button
            type="button"
            className="btn"
            aria-expanded={showTemplate}
            onClick={() => setShowTemplate((v) => !v)}
          >
            <Icon of={Workflow} />
            {showTemplate ? m.hideTemplate : m.showTemplate}
          </button>
        )}
      </div>
      {showTemplate && <PipelineTemplate />}
      {secretOpen && (
        <SecretDialog
          rotating={cicd.secretSet}
          onClose={() => setSecretOpen(false)}
        />
      )}
    </section>
  );
}

function PipelineTemplate() {
  const { project } = useProjectContext();
  const template = useQuery({
    queryKey: qk.pipelineTemplate(project.id),
    queryFn: () => domainApi.pipelineTemplate(project.id),
  });
  const m = useMessages(domainMessages).cicd;
  if (template.isPending) return <Loading />;
  if (template.isError) return <ErrorState error={template.error} />;
  return (
    <CodeBlock
      code={template.data.content}
      label={m.template(template.data.provider)}
      copyLabel={m.copyTemplate}
    />
  );
}

/**
 * Secret hiện ĐÚNG MỘT LẦN (§8.3) — cùng khuôn SDK key: giá trị chỉ sống trong state của hộp này,
 * không vào cache React Query, URL hay storage. Xoay thì secret cũ chết ngay: CI còn dùng nó nhận
 * 401 tới khi được dán secret mới — hộp nói điều đó TRƯỚC khi bấm.
 */
function SecretDialog({
  rotating,
  onClose,
}: {
  rotating: boolean;
  onClose: () => void;
}) {
  const { project } = useProjectContext();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const m = useMessages(domainMessages).cicd;
  const rotate = useMutation({
    mutationFn: () => domainApi.rotateWebhookSecret(project.id),
    onSuccess: async (data) => {
      setSecret(data.secret);
      await queryClient.invalidateQueries({ queryKey: qk.cicd(project.id) });
    },
  });

  if (secret !== null) {
    return (
      <Dialog
        title={m.secret}
        description={m.shownOnce}
        onClose={onClose}
        footer={
          <button type="button" className="btn pri" onClick={onClose}>
            {m.savedIt}
          </button>
        }
      >
        <CodeBlock code={secret} label={m.value} copyLabel={m.copySecret} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={rotating ? m.rotateTitle : m.generateTitle}
      description={rotating ? m.rotateDescription : m.generateDescription}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            {m.cancel}
          </button>
          <button
            type="button"
            className={rotating ? "btn danger-fill" : "btn pri"}
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? m.generating : rotating ? m.rotate : m.generate}
          </button>
        </>
      }
    >
      {rotate.isError && (
        <p role="alert" className="field-error">
          {messageOf(rotate.error)}
        </p>
      )}
    </Dialog>
  );
}
