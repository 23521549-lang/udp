import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { InfoTip } from "../../../components/InfoTip";
import { Empty, ErrorState, Loading } from "../../../components/States";
import { StatusLabel } from "../../../components/StatusLabel";
import { useMessages } from "../../../i18n";
import { formatDateTime } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { PROVIDER_LABEL } from "../../project/cloud/cloud-labels";
import { cloudMessages } from "../../project/cloud/cloud.messages";
import { labelOf } from "../../provisioning/provisioning-labels";
import { adminApi, type AdminCredentialRow } from "../admin-api";
import {
  CREDENTIAL_DEFAULT,
  CREDENTIAL_SORTS,
  setParam,
  type CredentialSortKey,
} from "../admin-search";
import { adminMessages } from "../admin.messages";
import { AdminPage } from "../AdminLayout";
import { credentialState } from "../credential-state";
import { useProjectPeek } from "../ProjectPeek";
import { SortHeader } from "../SortHeader";
import { parseSort, sortParam, sortRows, toggleSort } from "../sort";

/** Chưa kiểm lần nào đứng như mốc xa nhất: sắp "kiểm lần cuối" tăng dần là đưa chúng lên đầu */
const credentialValue = (
  c: AdminCredentialRow,
  key: CredentialSortKey,
): number =>
  key === "created"
    ? Date.parse(c.createdAt)
    : c.lastValidatedAt === null
      ? 0
      : Date.parse(c.lastValidatedAt);

const FIRST_DIR = { created: "desc", validated: "asc" } as const;

/**
 * Credential cloud của mọi project — chỉ siêu dữ liệu (§9).
 *
 * [Plan #58 UX-7] Tên cloud, chế độ và cách xác thực bằng chữ đọc được thay cho mã (`AZURE`, `BYOC`); credential chưa
 * kiểm lần nào hay không còn dùng mang nhãn cam. Tên project mở panel của nó; sắp theo ngày tạo hay lần kiểm cuối.
 */
export function AdminCredentialsPage() {
  const t = useMessages(adminMessages);
  const m = t.credentials;
  const auth = useMessages(cloudMessages).authKind;
  const search = useSearch({ from: "/admin/credentials" });
  const navigate = useNavigate({ from: "/admin/credentials" });
  const sort = parseSort(search.sort, CREDENTIAL_SORTS) ?? CREDENTIAL_DEFAULT;
  const creds = useQuery({
    queryKey: qk.adminCredentials(),
    queryFn: adminApi.credentials,
  });
  const setProject = (id: string | undefined): void => {
    void navigate({
      search: (prev) => setParam(prev, "project", id),
      resetScroll: false,
    });
  };
  const peek = useProjectPeek(search.project, setProject);
  const onSort = (key: CredentialSortKey): void => {
    const next = toggleSort(sort, key, FIRST_DIR[key]);
    void navigate({
      search: (prev) =>
        setParam(prev, "sort", sortParam(next, CREDENTIAL_DEFAULT)),
      replace: true,
      resetScroll: false,
    });
  };
  const list = creds.data?.credentials;
  const unchecked = list?.filter(
    (c) => credentialState(c).state !== "ok",
  ).length;

  return (
    <AdminPage
      title={m.title}
      lead={m.lead}
      minis={
        list === undefined || unchecked === undefined
          ? undefined
          : [
              { value: list.length, label: m.count(list.length) },
              { value: unchecked, label: m.unchecked(unchecked) },
            ]
      }
      peek={peek}
    >
      {creds.isPending ? (
        <Loading />
      ) : creds.isError ? (
        <ErrorState error={creds.error} onRetry={() => void creds.refetch()} />
      ) : creds.data.credentials.length === 0 ? (
        <Empty title={m.empty} />
      ) : (
        <div className="table-wrap">
          <table className="dtable" aria-label={m.title}>
            <thead>
              <tr>
                <th scope="col">{t.project}</th>
                <th scope="col">{m.check}</th>
                <th scope="col">{t.cloud}</th>
                <th scope="col">
                  {m.mode}
                  <InfoTip term="byoc" />
                </th>
                <th scope="col">{m.auth}</th>
                <th scope="col">{m.fingerprint}</th>
                <SortHeader
                  label={m.lastValidated}
                  column="validated"
                  sort={sort}
                  onSort={onSort}
                />
                <SortHeader
                  label={t.created}
                  column="created"
                  sort={sort}
                  onSort={onSort}
                />
              </tr>
            </thead>
            <tbody>
              {sortRows(creds.data.credentials, sort, credentialValue).map(
                (c) => {
                  const s = credentialState(c);
                  return (
                    <tr
                      key={c.id}
                      className={
                        c.project.id === search.project ? "on" : undefined
                      }
                    >
                      <th scope="row">
                        <Link
                          to="/admin/credentials"
                          search={setParam(search, "project", c.project.id)}
                          resetScroll={false}
                          translate="no"
                        >
                          {c.project.name}
                        </Link>
                      </th>
                      <td>
                        <StatusLabel tone={s.tone}>
                          {m.state[s.state]}
                        </StatusLabel>
                      </td>
                      <td>{PROVIDER_LABEL[c.provider]}</td>
                      <td>{labelOf(m.modes, c.mode)}</td>
                      <td>{labelOf(auth, c.authKind)}</td>
                      <td className="mono" translate="no">
                        {c.fingerprint}…
                      </td>
                      <td className="num">
                        {c.lastValidatedAt === null
                          ? "–"
                          : formatDateTime(c.lastValidatedAt)}
                      </td>
                      <td className="num">{formatDateTime(c.createdAt)}</td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
