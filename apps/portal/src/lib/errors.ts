import { ERROR_CATALOG, type ErrorCode } from "@udp/shared-types/problem";
import { messagesOf } from "../i18n";
import { errorsMessages } from "./errors.messages";
import { isApiError } from "./http";

/** Slug cuối của `type` (`https://.../problems/<slug>`) — để component rẽ nhánh theo lỗi */
export function problemSlugOf(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  return error.problem?.type.split("/").pop();
}

const isErrorCode = (code: string): code is ErrorCode => code in ERROR_CATALOG;

/**
 * Một câu cho người dùng từ một lỗi bất kỳ.
 *
 * Lỗi mà "không ai sửa được" (`fixableBy: nobody`) và lỗi 5xx kèm mã tra cứu: đó là bug,
 * nói "thử lại" là bảo người dùng lặp một việc vô ích (§9, `ErrorCodeSpec.fixableBy`).
 */
export function messageOf(error: unknown): string {
  const m = messagesOf(errorsMessages);
  if (!isApiError(error)) return m.unexpected;
  if (error.kind === "network") return m.network;
  if (error.kind === "contract") return m.contract;

  const problem = error.problem;
  const code = problem?.code;
  if (code !== undefined && isErrorCode(code)) {
    const text = m.code[code];
    return ERROR_CATALOG[code].fixableBy === "nobody"
      ? m.withTrace(text, problem?.traceId ?? "?")
      : text;
  }
  const slugCopy = m.slug[problemSlugOf(error) ?? ""];
  if (slugCopy !== undefined) return slugCopy;
  const field = problem?.errors?.[0];
  if (field !== undefined) return field.message;
  if (error.status >= 500) {
    return m.system(problem?.traceId ?? "?");
  }
  return m.status[error.status] ?? problem?.detail ?? m.generic;
}

/** Lỗi theo từng trường của form — hiện NGAY cạnh ô nhập, không bao giờ qua toast (§10.10) */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiError(error)) return {};
  const out: Record<string, string> = {};
  for (const e of error.problem?.errors ?? []) {
    if (out[e.field] === undefined) out[e.field] = e.message;
  }
  return out;
}
