import { ACTIVE_ROLLOUT_STATUS_SQL, type Prisma } from "@udp/db";

/**
 * Đọc `segments` và các phép kiểm quanh nó cho đường ghi segment (§2.2, §6.5).
 *
 * Mọi hàm ở đây nhận `tx` chứ không dùng `prisma` toàn cục: tất cả đều được gọi
 * TRONG `mutate` của `writeConfigChange`, tức sau khi bước 1 của ADR-05 đã khoá
 * mọi environment của project. Đó là điều kiện đúng đắn, không phải phong cách —
 * một phép kiểm "còn rule nào tham chiếu không" chạy ngoài khoá là đúng khe hở
 * mà R03 mô tả: `PUT rules` thêm rule trỏ tới segment ngay sau phép kiểm và
 * trước lệnh xoá, rồi cả hai cùng commit, để lại một tham chiếu treo mà evaluator
 * bỏ qua trong im lặng.
 */

export interface SegmentTarget {
  projectId: string;
  name: string;
  description: string | null;
  /** Đọc để ghi audit `before` (V13) và để so "conditions có đổi không" (V12) */
  conditions: Prisma.JsonValue;
  /** Mốc optimistic lock (R28) */
  updatedAt: Date;
}

/**
 * Segment ra những gì một lần ghi cần — hoặc `null` nếu không còn.
 *
 * Gọi hai lần, cùng lý do với `envConfigTargetOf` của rule: lần ngoài transaction
 * để biết khoá environment nào, lần TRONG `mutate` mới là lần đáng tin. Giữa hai
 * lần, một lần ghi khác có thể đã commit, và optimistic lock phải so với mốc SAU
 * khi khoá.
 */
export async function targetOf(
  tx: Prisma.TransactionClient,
  segmentId: string,
): Promise<SegmentTarget | null> {
  return tx.segment.findUnique({
    where: { id: segmentId },
    select: {
      projectId: true,
      name: true,
      description: true,
      conditions: true,
      updatedAt: true,
    },
  });
}

/** Số segment đang có của project — trần `SEGMENT.maxPerProject` (V5) */
export const countIn = (
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<number> => tx.segment.count({ where: { projectId } });

export interface SegmentBytes {
  /** Số byte `conditions` MỚI sẽ chiếm */
  next: number;
  /** Số byte segment đang sửa đang chiếm; 0 khi tạo mới */
  current: number;
  /** Tổng số byte của mọi segment KHÁC trong project */
  others: number;
}

/**
 * Ba con số của trần dung lượng theo project (V21), đo trong SQL, MỘT truy vấn.
 *
 * Đo bằng `octet_length(conditions::text)` chứ không kéo `conditions` về JS
 * (F6/F7): tổng của một project ở trần là 4 MiB, và đọc 4 MiB qua dây rồi
 * `JSON.parse` nó trong lúc đang giữ khoá MỌI environment của project là chặn
 * mọi lần ghi flag và cả kill-switch của Service 3 suốt thời gian đó. Postgres
 * cộng ngay tại chỗ dữ liệu nằm.
 *
 * [v4.10] Đây là thước đo CHÍNH THỨC của `SEGMENT.maxProjectBytes` (V21), không
 * phải một xấp xỉ nghiêm hơn của nó: `segmentPayloadBytesOf` (canonical JSON, ở
 * JS) là chặn DƯỚI, dùng để từ chối sớm ngoài transaction — xem chú thích của
 * hằng số. Ba con số ở đây cùng một thước là điều kiện để phép so "mới > cũ" của
 * V21 có nghĩa; trộn hai thước thì một lần sửa không đổi gì cũng có thể trông
 * như phình ra.
 *
 * `IS DISTINCT FROM` chứ không `<>`: lúc TẠO thì `segmentId` là NULL, và `s.id <>
 * NULL` ra NULL nên `FILTER` loại hết mọi hàng — tổng của project thành 0 và trần
 * không cưỡng chế được gì.
 */
export async function payloadBytesOf(
  tx: Prisma.TransactionClient,
  projectId: string,
  conditionsJson: string,
  segmentId?: string,
): Promise<SegmentBytes> {
  const target = segmentId ?? null;
  const rows = await tx.$queryRaw<SegmentBytes[]>`
    SELECT octet_length(${conditionsJson}::jsonb::text) AS "next",
           COALESCE(SUM(octet_length(s.conditions::text))
                    FILTER (WHERE s.id IS NOT DISTINCT FROM ${target}::uuid), 0)::int AS "current",
           COALESCE(SUM(octet_length(s.conditions::text))
                    FILTER (WHERE s.id IS DISTINCT FROM ${target}::uuid), 0)::int AS "others"
      FROM segments s
     WHERE s.project_id = ${projectId}::uuid`;

  const bytes = rows[0];
  if (bytes === undefined) {
    throw new Error("payloadBytesOf: truy vấn gộp không trả hàng nào");
  }
  return bytes;
}

/**
 * Flag ĐẦU TIÊN còn rule `SEGMENT` trỏ tới segment này, hoặc `undefined`.
 *
 * Phủ MỌI environment của project và MỌI trạng thái vòng đời của flag — kể cả
 * DRAFT và ARCHIVED. Rule của flag đã lưu trữ vẫn còn trong bảng, và một ngày
 * flag đó được phục hồi thì nó trỏ tới một segment không tồn tại; evaluator coi
 * rule đó là KHÔNG KHỚP (`prepare.ts`), nên một rule kiểu "chặn nhóm beta" im
 * lặng ngừng tác dụng mà không có lỗi hay cảnh báo nào.
 *
 * Không có khoá ngoại nào canh được việc này: `condition` là JSONB.
 *
 * Trả id flag vì `SEGMENT_IN_USE` mang `resourceId` = flag đầu tiên (V10) — Portal
 * cần dẫn người dùng tới chỗ gỡ tham chiếu, không chỉ nói "còn ai đang dùng".
 * `ORDER BY f.id` để hai lần gọi cho cùng câu trả lời.
 */
export async function referencingFlagId(
  tx: Prisma.TransactionClient,
  projectId: string,
  segmentId: string,
): Promise<string | undefined> {
  const rows = await tx.$queryRaw<{ flagId: string }[]>`
    SELECT f.id::text AS "flagId"
      FROM flag_targeting_rules r
      JOIN flag_env_configs c ON c.id = r.flag_env_config_id
      JOIN environments e     ON e.id = c.environment_id
      JOIN feature_flags f    ON f.id = c.flag_id
     WHERE e.project_id = ${projectId}::uuid
       AND r.rule_type = 'SEGMENT'
       AND r.condition->>'segmentId' = ${segmentId}
     ORDER BY f.id
     LIMIT 1`;
  return rows[0]?.flagId;
}

/**
 * Rollout còn SỐNG đang giữ một rule `SEGMENT` trỏ tới segment này (V12).
 *
 * Đổi `conditions` giữa lúc rollout đang ramp là đổi NHÓM CANARY giữa đường:
 * cùng lý do §1.2 chốt "một writer duy nhất tới đối tượng điều khiển traffic", và
 * cùng lý do đổi stickiness bị chặn. Đổi tên hay mô tả thì không ảnh hưởng ai, nên
 * phép kiểm này chỉ chạy khi `conditions` thực sự đổi.
 *
 * Chỉ chạm ba cột `rollout_sessions` mà `udp_s2` được cấp (`id`,
 * `targeting_rule_id`, `status`) — thêm một cột nữa vào đây là `42501`, và cấp
 * thêm quyền là phá ma trận writer I22.
 */
export async function liveRolloutId(
  tx: Prisma.TransactionClient,
  projectId: string,
  segmentId: string,
): Promise<string | undefined> {
  const rows = await tx.$queryRaw<{ rolloutId: string }[]>`
    SELECT s.id::text AS "rolloutId"
      FROM rollout_sessions s
      JOIN flag_targeting_rules r ON r.id = s.targeting_rule_id
      JOIN flag_env_configs c     ON c.id = r.flag_env_config_id
      JOIN environments e         ON e.id = c.environment_id
     WHERE e.project_id = ${projectId}::uuid
       AND s.status IN (${ACTIVE_ROLLOUT_STATUS_SQL})
       AND r.rule_type = 'SEGMENT'
       AND r.condition->>'segmentId' = ${segmentId}
     ORDER BY s.id
     LIMIT 1`;
  return rows[0]?.rolloutId;
}
