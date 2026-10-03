import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert, Copy, ExternalLink } from "lucide-react";
import { componentsMessages } from "../../../components/components.messages";
import { Icon } from "../../../components/Icon";
import { InfoTip } from "../../../components/InfoTip";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { toast } from "../../../components/Toast";
import { useMessages } from "../../../i18n";
import {
  formatDateTime,
  formatNumber,
  formatUsd,
  relativeTime,
} from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { adminApi, type AdminOrphanRow } from "../admin-api";
import {
  ORPHAN_DEFAULT,
  ORPHAN_SORTS,
  setParam,
  type OrphanSortKey,
} from "../admin-search";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";
import { cloudConsoleUrl } from "../cloud-console";
import { useProjectDirectory } from "../project-directory";
import { useProjectPeek } from "../ProjectPeek";
import { SortHeader } from "../SortHeader";
import { parseSort, sortParam, sortRows, toggleSort } from "../sort";

/** Giá trị của mỗi cột sắp được — `null` (chưa rõ giá) luôn cuối bảng */
const orphanValue = (r: AdminOrphanRow, key: OrphanSortKey): number | null =>
  key === "cost" ? r.usdPerHour : Date.parse(r.updatedAt);

/** Chi phí đắt nhất trước; "mồ côi từ" cũ nhất trước — cả hai là thứ đáng xử lý trước */
const FIRST_DIR = { cost: "desc", since: "asc" } as const;

/**
 * Màn hình DUY NHẤT nhìn thấy tiền đang bị đốt (§10.13). `null` USD/giờ nghĩa là không
 * định giá được — hiện "chưa rõ giá", tuyệt đối không hiện 0.
 *
 * [Plan #58 UX-33] Có việc làm được: chủ project (để báo khách) và "mồ côi từ" khi nào, đắt nhất trước, nút sao chép id
 * và link sang console của đúng cloud để xoá tay. Tên project mở panel của nó.
 */
export function AdminOrphansPage() {
  const t = useMessages(adminMessages);
  const m = t.orphans;
  const copyFailed = useMessages(componentsMessages).copyFailed;
  const search = useSearch({ from: "/admin/orphans" });
  const navigate = useNavigate({ from: "/admin/orphans" });
  const sort = parseSort(search.sort, ORPHAN_SORTS) ?? ORPHAN_DEFAULT;
  const orphans = useQuery({
    queryKey: qk.adminOrphans(),
    queryFn: adminApi.orphans,
  });
  const directory = useProjectDirectory();
  const setProject = (id: string | undefined): void => {
    void navigate({
      search: (prev) => setParam(prev, "project", id),
      resetScroll: false,
    });
  };
  const peek = useProjectPeek(search.project, setProject);
  const onSort = (key: OrphanSortKey): void => {
    const next = toggleSort(sort, key, FIRST_DIR[key]);
    void navigate({
      search: (prev) => setParam(prev, "sort", sortParam(next, ORPHAN_DEFAULT)),
      replace: true,
      resetScroll: false,
    });
  };
  const copy = (id: string): void => {
    // clipboard vắng mặt ngoài HTTPS dù kiểu DOM nói có: đi qua Promise để thành lỗi bắt được
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(id))
      .then(
        () => toast.info(m.copied),
        () => toast.error(copyFailed),
      );
  };
  const d = orphans.data;

  return (
    <AdminPage
      title={m.title}
      lead={
        <>
          {m.lead}
          <InfoTip term="orphan" />
        </>
      }
      peek={peek}
    >
      {orphans.isPending ? (
        <Loading />
      ) : orphans.isError ? (
        <ErrorState
          error={orphans.error}
          onRetry={() => void orphans.refetch()}
        />
      ) : d === undefined ? null : (
        <>
          <div className="stat">
            <div>
              <div className="l">{m.burning}</div>
              <div className="v num">
                {formatUsd(d.estimatedUsdPerHour)}
                <small>{m.perHourUnit}</small>
              </div>
            </div>
            <div>
              <div className="l">{m.perDay}</div>
              <div className="v num">
                {formatUsd(d.estimatedUsdPerHour * 24)}
              </div>
            </div>
            <div>
              <div className="l">{m.resources}</div>
              <div className="v num">{formatNumber(d.resources.length)}</div>
            </div>
            <div>
              <div className="l">{m.unpriced}</div>
              <div className="v num">{formatNumber(d.unpriced.length)}</div>
            </div>
          </div>
          {!d.cloudScanned && (
            <div className="alert amber" role="status">
              <Icon of={CircleAlert} />
              <div>{m.notScanned(d.pricingAsOf)}</div>
            </div>
          )}
          {d.resources.length === 0 ? (
            <Empty title={m.empty} />
          ) : (
            <div className="table-wrap">
              <table className="dtable" aria-label={m.title}>
                <thead>
                  <tr>
                    <th scope="col">{t.project}</th>
                    <SortHeader
                      label={m.usdPerHour}
                      column="cost"
                      sort={sort}
                      onSort={onSort}
                      num
                    />
                    <th scope="col">{t.owner}</th>
                    <th scope="col">{m.kind}</th>
                    <th scope="col">{m.region}</th>
                    <th scope="col">{m.cloudId}</th>
                    <SortHeader
                      label={m.since}
                      column="since"
                      sort={sort}
                      onSort={onSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortRows(d.resources, sort, orphanValue).map((r) => {
                    const owner = directory.byId.get(r.projectId)?.owner.email;
                    return (
                      <tr
                        key={r.id}
                        className={
                          r.projectId === search.project ? "on" : undefined
                        }
                      >
                        <th scope="row">
                          <Link
                            to="/admin/orphans"
                            search={setParam(search, "project", r.projectId)}
                            resetScroll={false}
                            translate="no"
                          >
                            {r.projectName}
                          </Link>
                        </th>
                        <td className="num">
                          {r.usdPerHour === null
                            ? m.unpriced
                            : formatUsd(r.usdPerHour)}
                        </td>
                        <td translate={owner === undefined ? undefined : "no"}>
                          {owner ??
                            (directory.isPending ? "…" : m.ownerUnknown)}
                        </td>
                        <td className="mono" translate="no">
                          {r.kind}
                        </td>
                        <td>
                          {PROVIDER_LABEL[r.provider]}{" "}
                          <span className="mono" translate="no">
                            {r.region}
                          </span>
                        </td>
                        <td>
                          <span className="orphan-id">
                            <span className="mono" translate="no">
                              {r.providerId ?? m.unknownId}
                            </span>
                            {r.providerId !== null && (
                              <button
                                type="button"
                                className="ib"
                                aria-label={m.copyId(r.kind, r.projectName)}
                                onClick={() => copy(r.providerId ?? "")}
                              >
                                <Icon of={Copy} size={14} />
                              </button>
                            )}
                            <a
                              className="ib"
                              href={cloudConsoleUrl(r)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={m.openConsole(
                                PROVIDER_LABEL[r.provider],
                              )}
                            >
                              <Icon of={ExternalLink} size={14} />
                            </a>
                          </span>
                        </td>
                        <td title={formatDateTime(r.updatedAt)}>
                          {relativeTime(r.updatedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </AdminPage>
  );
}
