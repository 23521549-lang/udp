import { NotFoundError, type AuditContext } from "@udp/http";
import type { AppDeps } from "../../core/app-deps.js";
import * as repository from "./segment.repository.js";
import { detailView, listView } from "./segment.view.js";
import type {
  CreateSegmentBody,
  ListSegmentsQuery,
  SegmentDetailView,
  SegmentListView,
  UpdateSegmentBody,
} from "./segment.types.js";

/**
 * Segment ở Service 1 (§3.1) — facade: ĐỌC thẳng database, GHI qua Service 2.
 *
 * Việc chia đôi như vậy không phải tuỳ tiện: mọi lần ghi cấu hình phải đi qua
 * `writeWithOutbox` của ADR-05 (tăng `config_version`, tính lại `config_hash`,
 * ghi outbox cho MỌI environment của project), và §1.2 chốt Service 2 là writer
 * duy nhất của đường đó. Còn đọc thì không cần khoá gì.
 *
 * Trước mỗi lời gọi ghi lên một segment có sẵn, `belongsToProject` chạy TRƯỚC:
 * `requireMinProjectRole` chỉ chứng minh người gọi có quyền trong project trên
 * đường dẫn, không chứng minh `:segmentId` thuộc project đó. Thiếu bước này thì
 * MAINTAINER của project A sửa được segment của project B chỉ bằng cách đổi id
 * trên URL (R05), và Service 2 sẽ vui vẻ ghi vì route nội bộ tin id nó nhận.
 */

const NOT_FOUND = "Không tìm thấy segment trong project này";

export async function list(
  projectId: string,
  query: ListSegmentsQuery,
): Promise<SegmentListView> {
  const [rows, quota] = await Promise.all([
    repository.list(projectId, query.search),
    repository.quota(projectId),
  ]);
  return listView(rows, quota);
}

export async function get(
  projectId: string,
  segmentId: string,
): Promise<SegmentDetailView> {
  const row = await repository.detail(projectId, segmentId);
  if (row === undefined) throw new NotFoundError(NOT_FOUND);
  return detailView(row, await repository.flagUsage(projectId, segmentId));
}

export async function create(
  deps: AppDeps,
  projectId: string,
  body: CreateSegmentBody,
  audit: AuditContext,
): Promise<SegmentDetailView> {
  const segmentId = await deps.flagService.createSegment(
    { ...body, projectId },
    audit,
  );
  return get(projectId, segmentId);
}

export async function update(
  deps: AppDeps,
  projectId: string,
  segmentId: string,
  body: UpdateSegmentBody,
  audit: AuditContext,
): Promise<SegmentDetailView> {
  await assertOwned(projectId, segmentId);
  await deps.flagService.updateSegment(segmentId, projectId, body, audit);
  return get(projectId, segmentId);
}

export async function remove(
  deps: AppDeps,
  projectId: string,
  segmentId: string,
  audit: AuditContext,
): Promise<void> {
  await assertOwned(projectId, segmentId);
  await deps.flagService.deleteSegment(segmentId, projectId, audit);
}

async function assertOwned(
  projectId: string,
  segmentId: string,
): Promise<void> {
  if (!(await repository.belongsToProject(projectId, segmentId))) {
    throw new NotFoundError(NOT_FOUND);
  }
}
