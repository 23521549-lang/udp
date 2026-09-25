import {
  putCloudBodySchema,
  type CloudAuthKindWire,
  type CloudProviderWire,
  type PutCloudBody,
} from "@udp/shared-types/cloud-api";
import { DEFAULT_REGION } from "./cloud-labels";

/**
 * Trạng thái form của bước cloud và phép dựng body `PUT /cloud` — THUẦN, kiểm bằng CHÍNH
 * schema mà Service 1 dùng (`putCloudBodySchema`), nên lỗi định dạng hiện ngay cạnh ô nhập
 * mà không phải gửi bí mật đi một vòng chỉ để nghe "sai định dạng".
 */
export interface CloudForm {
  provider: CloudProviderWire;
  mode: "BYOC" | "MANAGED";
  authKind: CloudAuthKindWire;
  region: string;
  /** Giá trị theo khoá payload (`roleArn`, `tenantId`…) */
  fields: Record<string, string>;
  /** GCP_KEY: nguyên văn khoá JSON khách dán vào */
  keyJson: string;
}

const FIRST_KIND: Record<CloudProviderWire, CloudAuthKindWire> = {
  AWS: "AWS_ROLE",
  GCP: "GCP_WIF",
  AZURE: "AZURE_FEDERATED",
};

export const initialForm = (provider: CloudProviderWire): CloudForm => ({
  provider,
  mode: "BYOC",
  authKind: FIRST_KIND[provider],
  region: DEFAULT_REGION[provider],
  fields: {},
  keyJson: "",
});

/** Bốn trường cần của khoá JSON — phần còn lại (private_key_id, client_id…) không gửi đi */
const GCP_KEY_FIELDS = ["type", "project_id", "client_email", "private_key"];

function gcpKeyOf(keyJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(keyJson);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entries = Object.entries(parsed).filter(([k]) =>
      GCP_KEY_FIELDS.includes(k),
    );
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

export type BuildResult =
  | { ok: true; body: PutCloudBody }
  | { ok: false; errors: Record<string, string> };

export function buildBody(form: CloudForm): BuildResult {
  const base = { provider: form.provider, region: form.region.trim() };
  let candidate: unknown;
  if (form.mode === "MANAGED") {
    candidate = { mode: "MANAGED", ...base };
  } else if (form.authKind === "GCP_KEY") {
    const key = gcpKeyOf(form.keyJson);
    if (key === null) {
      return { ok: false, errors: { keyJson: "Không đọc được khoá JSON." } };
    }
    candidate = {
      mode: "BYOC",
      ...base,
      credential: { authKind: "GCP_KEY", ...key },
    };
  } else {
    const trimmed = Object.fromEntries(
      Object.entries(form.fields).map(([k, v]) => [k, v.trim()]),
    );
    candidate = {
      mode: "BYOC",
      ...base,
      credential: { authKind: form.authKind, ...trimmed },
    };
  }

  const parsed = putCloudBodySchema.safeParse(candidate);
  if (parsed.success) return { ok: true, body: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const [head, field] = issue.path;
    const key =
      head === "credential"
        ? form.authKind === "GCP_KEY"
          ? "keyJson"
          : String(field ?? "credential")
        : String(head ?? "form");
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}
