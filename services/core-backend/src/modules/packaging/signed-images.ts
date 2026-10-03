import { registryPushOf, type SignedImages } from "@udp/adapter-core";
import { workloadSlugFor } from "@udp/config";
import type { PrismaClient } from "@udp/db";
import { bindingsOfProject } from "../capability/capability-binding.repository.js";
import { providerFromDb } from "../provisioning/provider-codec.js";
import { settingsOf, signingUnavailable } from "./build-plan.js";

/**
 * [Plan #61 61d-3b] Hai dữ kiện mà một policy admission cần, đọc từ ĐÚNG MỘT chỗ.
 *
 * **Vì sao một hàm dùng chung chứ không hai lượt truy vấn ở hai chỗ gọi:** `ctx` của adapter được dựng ở **hai**
 * đường — đường áp domain (`job-kit.domainInput` → `adapterContext`) và đường quét trôi (`drift-scan.job.ts`). Nếu
 * hai đường tính ra hai giá trị khác nhau thì `values` của companion khác nhau, và mọi lượt quét báo **trôi giả**
 * vĩnh viễn (I32 chiều b). Một hàm, hai chỗ gọi.
 *
 * **Vì sao dùng `bindingsOfProject` chứ không một `findFirst` riêng:** cổng deploy 61d-1 (`assertOwnImage`) chọn
 * endpoint bằng `bindingsOfProject(...).find(b => b.capabilityId === "registry.oci")`, tức binding có `id` nhỏ nhất
 * theo thứ tự `capabilityId asc, id asc` của chính hàm đó. Một project có HAI binding `registry.oci` (hai
 * environment) mà hai chỗ chọn hai hàng khác nhau thì policy đòi chữ ký ở một repository còn cổng deploy kiểm một
 * repository khác — một lỗ mà không test nào của đường này thấy. Dùng chung hàm là cách để nó không xảy ra được.
 *
 * `null` khi project chưa có khoá ký CÔNG KHAI hay chưa có registry: lúc đó KHÔNG sinh policy nào. Một
 * `ImageValidatingPolicy` không có attestor là một policy không kiểm được gì — tệ hơn là không có policy, vì nó làm
 * người đọc báo cáo tin rằng chữ ký đang được kiểm.
 *
 * **Và `null` khi project KHÔNG KÝ ĐƯỢC, dù đã lưu khoá** (`signingUnavailable`). Đây là một lỗ của bản 61d-3b, tìm
 * ra khi phân tích lại 61d-2b-2 sau khi Kyverno đã ship: một project CircleCI + Azure lưu được khoá ký (phép kiểm
 * lúc lưu chỉ đòi khoá P-256 cùng cloud với danh tính), nhưng `buildSigningOf` trả `null` nên pipeline **không có
 * bước ký** và không image nào được ký bao giờ. Nếu chỉ xét "có khoá hay chưa", project đó nhận một policy đòi chữ
 * ký mà không bao giờ có chữ ký — ở `Audit` là **mọi pod vi phạm vĩnh viễn**, và nếu có ngày bật `Deny` thì là chặn
 * sạch. Một policy báo sai mãi mãi còn tệ hơn không có policy: nó dạy người đọc bỏ qua báo cáo.
 */
export async function signedImagesOf(
  prisma: PrismaClient,
  projectId: string,
): Promise<SignedImages | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, buildSettings: true },
  });
  if (project === null) return null;

  /**
   * Khoá công khai theo thứ tự đã lưu: `buildSigningSchema` nói khoá MỚI NHẤT đứng đầu và mọi khoá trong danh sách
   * được chấp nhận khi kiểm — xoay khoá không gián đoạn. Policy giữ nguyên thứ tự đó.
   */
  const publicKeys = settingsOf(project.buildSettings).signing.keys.map(
    (k) => k.publicKey,
  );
  if (publicKeys.length === 0) return null;

  /**
   * Project có ký ĐƯỢC không — cùng phép kiểm mà `buildSigningOf` dùng để quyết pipeline có bước ký hay không, nên
   * hai bên không lệch nhau được: không có bước ký ⇒ không có chữ ký ⇒ không được sinh policy đòi chữ ký.
   */
  const [credential, cicd] = await Promise.all([
    prisma.cloudCredential.findFirst({
      where: { projectId, isActive: true },
      select: { provider: true },
    }),
    prisma.domainConfig.findFirst({
      where: { projectId, domainType: "CICD", isEnabled: true },
      select: { selectedTool: true },
    }),
  ]);
  const unavailable = signingUnavailable(
    credential === null ? null : providerFromDb(credential.provider),
    cicd?.selectedTool ?? null,
  );
  if (unavailable !== null) return null;

  const binding = (await bindingsOfProject(prisma, projectId)).find(
    (b) => b.capabilityId === "registry.oci",
  );
  const endpoint = binding?.endpoint;
  if (endpoint == null || endpoint === "") return null;

  const attributes = binding?.attributes;
  const push = registryPushOf({
    endpoint,
    ...(attributes == null ? {} : { attributes }),
  });
  return {
    repository: `${endpoint}/${workloadSlugFor(project.name)}`,
    publicKeys,
    registryKind: push === null ? "other" : push.kind,
  };
}
