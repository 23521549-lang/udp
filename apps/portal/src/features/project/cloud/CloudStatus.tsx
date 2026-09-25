import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  CloudCredentialWire,
  CloudPreflightWire,
} from "@udp/shared-types/wire";
import { CircleCheck, CircleAlert, TriangleAlert } from "lucide-react";
import { Icon } from "../../../components/Icon";
import { messageOf } from "../../../lib/errors";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { cloudApi } from "./cloud-api";
import { AUTH_KIND_LABEL, PROVIDER_LABEL } from "./cloud-labels";

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
    <section aria-label="Cloud đang dùng">
      <dl className="props">
        <dt>Cloud</dt>
        <dd>
          {PROVIDER_LABEL[cloud.provider]}
          <span className="chip soft">{cloud.region}</span>
        </dd>
        <dt>Xác thực</dt>
        <dd>
          {cloud.mode === "MANAGED"
            ? "Tài khoản của UDP"
            : AUTH_KIND_LABEL[cloud.authKind]}
        </dd>
        <dt>Fingerprint</dt>
        <dd className="mono">{cloud.fingerprint}</dd>
        <dt>Kiểm lần cuối</dt>
        <dd>
          {cloud.lastValidatedAt === null
            ? "Chưa kiểm"
            : formatDateTime(cloud.lastValidatedAt)}
        </dd>
      </dl>
      {!cloud.federated && (
        <div className="lock" role="note">
          <Icon of={TriangleAlert} />
          <span>
            Đang dùng credential dài hạn. Nên chuyển sang cách federation để UDP
            không giữ bí mật nào của bạn.
          </span>
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
            {validate.isPending ? "Đang kiểm..." : "Kiểm tra credential"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={preflight.isPending}
            onClick={() => preflight.mutate()}
          >
            {preflight.isPending ? "Đang kiểm..." : "Kiểm tra quyền"}
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
              <Icon of={CircleCheck} /> Credential dùng được.
            </span>
          ) : (
            <span>
              <Icon of={CircleAlert} /> Credential không dùng được:{" "}
              {validate.data.validation.reason}
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
  return (
    <div className="check-result" role="status" aria-label="Kết quả kiểm quyền">
      {report.ok ? (
        <span>
          <Icon of={CircleCheck} /> Đủ quyền để UDP dựng hạ tầng.
        </span>
      ) : (
        <>
          <span>
            <Icon of={CircleAlert} /> Còn thiếu{" "}
            {report.missingPermissions.length} quyền:
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
        {report.confidence === "exact"
          ? "Kết quả chính xác: cloud tự mô phỏng quyền."
          : "Kết quả ước lượng: cloud này không có API mô phỏng quyền."}{" "}
        <a href={report.docUrl} target="_blank" rel="noreferrer">
          Hướng dẫn cấp quyền
        </a>
      </span>
    </div>
  );
}
