import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Workflow } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "../../components/CodeBlock";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ErrorState, Loading } from "../../components/States";
import { messageOf } from "../../lib/errors";
import { qk } from "../../lib/query-keys";
import { useProjectContext } from "../project/ProjectLayout";
import { can } from "../project/roles";
import { domainApi } from "./domain-api";

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

  if (status.isPending) return <Loading />;
  if (status.isError) return <ErrorState error={status.error} />;
  const { cicd } = status.data;
  if (cicd.provider === null || cicd.webhookPath === null) return null;

  return (
    <section aria-label="Webhook CI/CD">
      <h3 className="h2">Webhook CI/CD</h3>
      <p className="c3">
        Bước cuối của pipeline gọi địa chỉ này, ký thân bằng secret webhook.
        Deploy xong flag vẫn tắt: deploy không phải release.
      </p>
      <CodeBlock
        code={`${window.location.origin}${cicd.webhookPath}`}
        label="Địa chỉ webhook"
        copyLabel="Sao chép địa chỉ"
      />
      <dl className="props">
        <dt>Secret webhook</dt>
        <dd>
          {cicd.secretSet
            ? "Đã sinh (không xem lại được)"
            : "Chưa sinh: mọi webhook đều bị từ chối"}
        </dd>
      </dl>
      <div className="form-actions" style={{ justifyContent: "flex-start" }}>
        {can(project.myRole, "MAINTAINER") && (
          <button
            type="button"
            className="btn"
            onClick={() => setSecretOpen(true)}
          >
            <Icon of={KeyRound} />
            {cicd.secretSet ? "Xoay secret" : "Sinh secret"}
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
            {showTemplate ? "Ẩn template pipeline" : "Xem template pipeline"}
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
  if (template.isPending) return <Loading />;
  if (template.isError) return <ErrorState error={template.error} />;
  return (
    <CodeBlock
      code={template.data.content}
      label={`Template pipeline ${template.data.provider}`}
      copyLabel="Sao chép template"
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
        title="Secret webhook"
        description="Sao chép ngay vào biến UDP_WEBHOOK_SECRET của CI: đây là lần duy nhất secret hiện đầy đủ."
        onClose={onClose}
        footer={
          <button type="button" className="btn pri" onClick={onClose}>
            Đã lưu secret
          </button>
        }
      >
        <CodeBlock
          code={secret}
          label="Giá trị secret webhook"
          copyLabel="Sao chép secret"
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={rotating ? "Xoay secret webhook?" : "Sinh secret webhook"}
      description={
        rotating
          ? "Secret cũ hết hiệu lực ngay: CI còn dùng nó nhận 401 tới khi bạn dán secret mới."
          : "Secret ký mọi webhook của project; UDP chỉ hiện nó một lần."
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" data-close onClick={onClose}>
            Huỷ
          </button>
          <button
            type="button"
            className={rotating ? "btn danger-fill" : "btn pri"}
            disabled={rotate.isPending}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending
              ? "Đang sinh..."
              : rotating
                ? "Xoay secret"
                : "Sinh secret"}
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
