import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Workflow } from "lucide-react";
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
export function CicdPanel() {
  const { project } = useProjectContext();
  const status = useQuery({
    queryKey: qk.cicd(project.id),
    queryFn: () => domainApi.cicd(project.id),
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
      <CodeBlock
        code={`${window.location.origin}${cicd.webhookPath}`}
        label={m.url}
        copyLabel={m.copyUrl}
      />
      <dl className="props">
        <dt>{m.secret}</dt>
        <dd>{cicd.secretSet ? m.secretSet : m.secretUnset}</dd>
      </dl>
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
