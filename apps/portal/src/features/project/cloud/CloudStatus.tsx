import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CloudCredentialWire,
  CloudPreflightWire,
} from "@udp/shared-types/wire";
import { CircleCheck, CircleAlert, TriangleAlert } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { useMessages } from "../../../i18n";
import { messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { cloudApi } from "./cloud-api";
import { cloudMessages } from "./cloud.messages";
import { PROVIDER_LABEL } from "./cloud-labels";

/**
 * Cấu hình cloud đang dùng và hai phép kiểm (§4.3): credential còn dùng được không, và
 * còn thiếu quyền gì. Chỉ metadata — Portal không bao giờ nhận lại bí mật đã lưu.
 */
export function CloudStatus({
  projectId,
  cloud,
  canCheck,
}: {
  projectId: string;
  cloud: CloudCredentialWire;
  canCheck: boolean;
}) {
  const m = useMessages(cloudMessages);
  const queryClient = useQueryClient();
  const validate = useMutation({
    mutationFn: () => cloudApi.validate(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.cloud(projectId) });
    },
  });
  const preflight = useMutation({
    mutationFn: () => cloudApi.preflight(projectId),
  });

  return (
    <section aria-label={m.status.label}>
      <dl className="props">
        <dt>{m.cloud}</dt>
        <dd>
          {PROVIDER_LABEL[cloud.provider]}
          <span className="chip soft">{cloud.region}</span>
        </dd>
        <dt>{m.auth}</dt>
        <dd>
          {cloud.mode === "MANAGED" ? m.udpAccount : m.authKind[cloud.authKind]}
        </dd>
        <dt>{m.status.fingerprint}</dt>
        <dd className="mono">{cloud.fingerprint}</dd>
        <dt>{m.lastChecked}</dt>
        <dd>
          {cloud.lastValidatedAt === null
            ? m.notChecked
            : formatDateTime(cloud.lastValidatedAt)}
        </dd>
      </dl>
      {!cloud.federated && (
        <div className="lock" role="note">
          <Icon of={TriangleAlert} />
          <span>{m.status.longLived}</span>
        </div>
      )}

      {canCheck && (
        <div className="form-actions" style={{ justifyContent: "flex-start" }}>
          <button
            type="button"
            className="btn"
            disabled={validate.isPending}
            onClick={() => validate.mutate()}
          >
            {validate.isPending ? m.status.checking : m.status.validate}
          </button>
          <button
            type="button"
            className="btn"
            disabled={preflight.isPending}
            onClick={() => preflight.mutate()}
          >
            {preflight.isPending ? m.status.checking : m.status.preflight}
          </button>
        </div>
      )}

      {validate.isError && (
        <p role="alert" className="field-error">
          {messageOf(validate.error)}
        </p>
      )}
      {validate.data !== undefined && (
        <div className="check-result" role="status">
          {validate.data.validation.valid ? (
            <span>
              <Icon of={CircleCheck} /> {m.status.valid}
            </span>
          ) : (
            <span>
              <Icon of={CircleAlert} />{" "}
              {m.status.invalid(validate.data.validation.reason ?? "")}
            </span>
          )}
        </div>
      )}

      {preflight.isError && (
        <p role="alert" className="field-error">
          {messageOf(preflight.error)}
        </p>
      )}
      {preflight.data !== undefined && (
        <PreflightResult report={preflight.data.preflight} />
      )}
    </section>
  );
}

function PreflightResult({ report }: { report: CloudPreflightWire }) {
  const m = useMessages(cloudMessages).status;
  return (
    <div className="check-result" role="status" aria-label={m.preflightLabel}>
      {report.ok ? (
        <span>
          <Icon of={CircleCheck} /> {m.preflightOk}
        </span>
      ) : (
        <>
          <span>
            <Icon of={CircleAlert} />{" "}
            {m.missing(report.missingPermissions.length)}
          </span>
          <ul>
            {report.missingPermissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {report.quotaWarnings.map((w) => (
        <span key={w}>
          <Icon of={TriangleAlert} /> {w}
        </span>
      ))}
      <span className="c3">
        {report.confidence === "exact" ? m.exact : m.estimated}{" "}
        <a href={report.docUrl} target="_blank" rel="noreferrer">
          {m.guide}
        </a>
      </span>
    </div>
  );
}
