import { issueSdkKeyToken, sdkKeyMaterialOf } from "@udp/db";
import { NotFoundError, type AuditContext } from "@udp/http";
import type { AppDeps } from "../../core/app-deps.js";
import * as repository from "./environment.repository.js";
import { keyListView, keyView } from "./sdk-key.view.js";
import type {
  CreateSdkKeyBody,
  CreatedSdkKeyView,
  ListSdkKeysQuery,
  SdkKeyListView,
  SdkKeyView,
} from "./sdk-key.types.js";

/**
 * SDK key ở Service 1 (§3.1, L7) — facade: ĐỌC thẳng database, GHI qua Service 2
 * [v4.9].
 *
 * Việc quan trọng nhất của file này là NƠI SINH TOKEN. Nó ở đây, không ở Service
 * 2, và đó là quyết định L7 chốt vì hai rủi ro cùng biến mất:
 *
 *   - **R04 (rò rỉ):** plaintext không bao giờ rời tiến trình này. Nó không đi qua
 *     mạng nội bộ, không vào log của Service 2, không vào `config_change_log`,
 *     không vào `audit_logs`. Service 2 chỉ nhận `keyHash` + `keySuffix`.
 *   - **R24 (khoá mồ côi):** nếu Service 2 commit rồi response mất (hết giờ), lần
 *     thử lại của client nội bộ gửi lại CÙNG `keyHash`, và `key_hash` là `@unique`
 *     — Service 2 nhận ra hàng đã có và trả 200 `created:false`. Plaintext vẫn nằm
 *     trong bộ nhớ của hàm này, nên người dùng vẫn nhận đúng khoá vừa phát hành
 *     thay vì một 503 và một khoá mồ côi họ không biết để thu hồi (AC-5.5).
 *
 * Với hướng ngược lại — Service 2 sinh token — không có cách nào vừa thử lại vừa
 * giữ được plaintext: mỗi lần thử là một token khác, và người dùng phải tự đi tìm
 * "khoá lạ" trong danh sách để thu hồi.
 *
 * Mọi route kiểm sở hữu `:envId` TRƯỚC khi gọi Service 2 (R05): environment của
 * project khác, và khoá của environment khác, ra 404 mà Service 2 không bị gọi lần
 * nào.
 */

const ENV_NOT_FOUND = "Không tìm thấy environment trong project này";
const KEY_NOT_FOUND = "Không tìm thấy SDK key trong environment này";

export async function list(
  projectId: string,
  environmentId: string,
  query: ListSdkKeysQuery,
): Promise<SdkKeyListView> {
  await assertEnvironment(projectId, environmentId);
  return keyListView(await repository.listKeys(environmentId, query.status));
}

/**
 * Phát hành khoá — plaintext hiện ĐÚNG MỘT LẦN, trong response này (§3.1).
 *
 * Thứ tự cố định: kiểm sở hữu (cũng là nơi lấy TÊN environment cho nhãn trong
 * token) → sinh token → băm → gọi Service 2 với vật liệu đã băm → đọc lại view của
 * chính mình. Không có bước nào lưu plaintext ở đâu.
 */
export async function create(
  deps: AppDeps,
  projectId: string,
  environmentId: string,
  body: CreateSdkKeyBody,
  audit: AuditContext,
): Promise<CreatedSdkKeyView> {
  const environment = await assertEnvironment(projectId, environmentId);

  /**
   * `envSlug` lấy từ TÊN environment lúc phát hành, và nó chỉ là nhãn cho người
   * đọc: token không bao giờ được parse, environment luôn suy từ hàng tra theo
   * hash (ADR-03). Nên đổi tên environment sau này không làm khoá nào hết hiệu
   * lực, và `maskedKey` của danh sách cũng không dựng lại phần này.
   */
  const secretKey = issueSdkKeyToken(body.keyType, environment.name);
  const keyId = await deps.flagService.createSdkKey(
    {
      environmentId,
      keyType: body.keyType,
      label: body.label ?? null,
      ...sdkKeyMaterialOf(secretKey),
    },
    audit,
  );

  return { key: await keyOrThrow(environmentId, keyId), secretKey };
}

/**
 * Thu hồi — idempotent, và lần thứ hai trả đúng mốc của lần đầu (§3.1, AC-4.6).
 *
 * Đọc lại view SAU khi Service 2 commit chứ không dựng response từ thứ Service 2
 * trả: hình trên dây là hình của Service 1 (`maskedKey`, `createdBy.name`,
 * `lastUsedAt`), và Service 2 không biết tên người dùng — nó không có quyền nào
 * trên bảng `users`.
 */
export async function revoke(
  deps: AppDeps,
  projectId: string,
  environmentId: string,
  keyId: string,
  audit: AuditContext,
): Promise<{ key: SdkKeyView }> {
  await assertEnvironment(projectId, environmentId);
  /**
   * Phép kiểm sở hữu của chính KHOÁ, trước lời gọi Service 2.
   *
   * Không thể dựa vào 404 của Service 2: nó cũng kiểm (phòng thủ nhiều lớp), nhưng
   * một lời gọi tới đó cho một id không thuộc về người gọi là một lần ghi đã được
   * bắt đầu — và R05 đòi 404 mà Service 2 nhận 0 lời gọi.
   */
  await keyOrThrow(environmentId, keyId);

  await deps.flagService.revokeSdkKey(keyId, environmentId, audit);
  return { key: await keyOrThrow(environmentId, keyId) };
}

async function assertEnvironment(
  projectId: string,
  environmentId: string,
): Promise<repository.EnvironmentRef> {
  const environment = await repository.findInProject(projectId, environmentId);
  if (environment === undefined) throw new NotFoundError(ENV_NOT_FOUND);
  return environment;
}

async function keyOrThrow(
  environmentId: string,
  keyId: string,
): Promise<SdkKeyView> {
  const row = await repository.keyInEnvironment(environmentId, keyId);
  if (row === undefined) throw new NotFoundError(KEY_NOT_FOUND);
  return keyView(row);
}
