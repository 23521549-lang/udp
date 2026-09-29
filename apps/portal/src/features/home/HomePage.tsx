import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HomeAttentionWire, HomeWire } from "@udp/shared-types/wire";
import { Plus } from "lucide-react";
import { BarChart } from "../../components/BarChart";
import { Icon } from "../../components/Icon";
import { PageHead } from "../../components/PageHead";
import { Empty, ErrorState, Loading } from "../../components/States";
import { StatusLabel, type Tone } from "../../components/StatusLabel";
import {
  dayLabel,
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { useAuthStore } from "../auth/auth-store";
import { PROVIDER_LABEL } from "../project/cloud/cloud-labels";
import { ProjectStatus } from "../project/ProjectStatus";
import { rolesMessages } from "../project/roles.messages";
import { useMessages } from "../../i18n";
import { jobTypeLabel } from "../provisioning/provisioning-labels";
import { RolloutStatusLabel } from "../rollout/rollout-status";
import { homeApi } from "./home-api";

/**
 * Trang chủ developer (Plan #53 QĐ-5, QĐ-7): việc cần xử lý của MỌI project đứng đầu — mỗi dòng dẫn
 * thẳng tới chỗ sửa — rồi rollout đang chạy, thẻ project và deploy 14 ngày. Một lời gọi `GET /home`.
 */
export function HomePage() {
  const user = useAuthStore((s) => s.user);
  const home = useQuery({
    queryKey: qk.home(),
    queryFn: homeApi.get,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const h = home.data?.home;

  return (
    <>
      <div className="bar">
        <div className="crumbs">
          <b>Trang chủ</b>
        </div>
        <div className="r">
          <Link to="/app/projects/new" className="btn pri">
            <Icon of={Plus} />
            Tạo project
          </Link>
        </div>
      </div>
      <div className="scroll">
        <PageHead
          title={user === null ? "Trang chủ" : `Chào ${firstNameOf(user.name)}`}
          lead="Việc cần xử lý, rollout đang chạy và deploy của mọi project bạn tham gia."
          minis={
            h === undefined
              ? undefined
              : [
                  { value: h.projects.length, label: "project" },
                  { value: h.rollouts.length, label: "rollout đang chạy" },
                  { value: h.attention.length, label: "việc cần xử lý" },
                ]
          }
        />
        <div className="page">
          {home.isPending ? (
            <Loading />
          ) : home.isError ? (
            <ErrorState
              error={home.error}
              onRetry={() => void home.refetch()}
            />
          ) : home.data.home.projects.length === 0 ? (
            <Empty title="Bạn chưa tham gia project nào">
              <Link to="/app/projects/new" className="btn pri">
                Tạo project đầu tiên
              </Link>
            </Empty>
          ) : (
            <HomeBody home={home.data.home} />
          )}
        </div>
      </div>
    </>
  );
}

/** Tên gọi: chữ cuối của họ tên Việt ("Nguyễn Thị Lan" ⇒ "Lan") */
export const firstNameOf = (name: string): string =>
  name.trim().split(/\s+/).pop() ?? name;

function HomeBody({ home }: { home: HomeWire }) {
  const roles = useMessages(rolesMessages).role;
  return (
    <>
      <section aria-labelledby="home-attention">
        <div className="sect">
          <h2 id="home-attention">Việc cần xử lý</h2>
        </div>
        {home.attention.length === 0 ? (
          <p className="c3">Không có gì cần xử lý. Mọi project đều ổn.</p>
        ) : (
          <ul className="lst" aria-labelledby="home-attention">
            {home.attention.map((a) => (
              <li
                key={`${a.kind}:${a.projectId}:${a.subject}:${a.refId ?? ""}`}
              >
                <AttentionRow item={a} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-rollouts">
        <div className="sect">
          <h2 id="home-rollouts">Rollout đang chạy</h2>
        </div>
        {home.rollouts.length === 0 ? (
          <p className="c3">Không có rollout nào đang chạy.</p>
        ) : (
          <ul className="lst" aria-labelledby="home-rollouts">
            {home.rollouts.map((r) => (
              <li key={r.id}>
                <Link
                  to="/app/projects/$projectId/rollouts/$rolloutId"
                  params={{ projectId: r.projectId, rolloutId: r.id }}
                  search={{ env: r.environment.id }}
                >
                  <span className="mono lst-name" translate="no">
                    {r.subject}
                  </span>
                  <span className="c3">
                    {r.projectName} / {r.environment.name}
                  </span>
                  <span className="lst-end">
                    <RolloutStatusLabel status={r.status} />
                    <span className="num">
                      {formatPercent(r.trafficPercentage)}
                    </span>
                  </span>
                  <span className="c3 num" title={formatDateTime(r.updatedAt)}>
                    {relativeTime(r.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-projects">
        <div className="sect">
          <h2 id="home-projects">Project</h2>
          <div className="r">
            <Link to="/app/projects" className="btn">
              Mọi project
            </Link>
          </div>
        </div>
        <ul className="home-projects">
          {home.projects.map((p) => (
            <li key={p.id}>
              <Link
                to="/app/projects/$projectId"
                params={{ projectId: p.id }}
                search={{}}
                className="home-card"
              >
                <b className="lst-name" translate="no">
                  {p.name}
                </b>
                <span className="home-card-st">
                  <ProjectStatus status={p.status} expiresAt={p.expiresAt} />
                </span>
                <span className="c3">
                  {roles[p.myRole]}
                  {p.cloudProvider !== null &&
                    `, ${PROVIDER_LABEL[p.cloudProvider]}`}
                  , {p.environmentCount} environment
                </span>
                <span className="home-card-n">
                  <span>
                    <b className="num">{p.activeRollouts}</b> rollout
                  </span>
                  <span>
                    <b className="num">{p.attention}</b> việc cần xử lý
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Deploy 14 ngày">
        <BarChart
          title="Deploy 14 ngày"
          level={2}
          format={formatNumber}
          data={home.deploys.map((d) => {
            const label = dayLabel(d.date);
            return {
              key: d.date,
              short: label.short,
              full: label.full,
              parts: [
                { label: "Thành công", value: d.success, tone: "neutral" },
                { label: "Thất bại", value: d.failure, tone: "error" },
              ],
            };
          })}
        />
      </section>
    </>
  );
}

const ATTENTION: Record<
  HomeAttentionWire["kind"],
  { tone: Tone; text: (a: HomeAttentionWire) => string }
> = {
  DEPLOY_PENDING: {
    tone: "warn",
    text: (a) => `Deploy ${a.subject} chờ duyệt`,
  },
  DOMAIN_ERROR: { tone: "error", text: (a) => `Domain ${a.subject} lỗi` },
  DOMAIN_DRIFTED: {
    tone: "warn",
    text: (a) => `Domain ${a.subject} lệch cấu hình`,
  },
  JOB_FAILED: {
    tone: "error",
    text: (a) => `${jobTypeLabel(a.subject)} thất bại`,
  },
  PROJECT_EXPIRING: {
    tone: "warn",
    text: () => "Project hết hạn trong 48 giờ",
  },
  ROLLOUT_PAUSED: {
    tone: "warn",
    text: (a) => `Rollout ${a.subject} đang tạm dừng`,
  },
};

/** Một việc cần xử lý: câu, project/env, lúc — và link tới ĐÚNG chỗ sửa */
function AttentionRow({ item: a }: { item: HomeAttentionWire }) {
  const kind = ATTENTION[a.kind];
  const body = (
    <>
      <StatusLabel tone={kind.tone}>{kind.text(a)}</StatusLabel>
      <span className="c3">
        {a.projectName}
        {a.environment !== null && ` / ${a.environment.name}`}
      </span>
      <span className="lst-end c3 num" title={formatDateTime(a.at)}>
        {relativeTime(a.at)}
      </span>
    </>
  );
  const params = { projectId: a.projectId };
  const env = a.environment === null ? {} : { env: a.environment.id };
  switch (a.kind) {
    case "DEPLOY_PENDING":
      return (
        <Link
          to="/app/projects/$projectId/deployments"
          params={params}
          search={env}
        >
          {body}
        </Link>
      );
    case "DOMAIN_ERROR":
    case "DOMAIN_DRIFTED":
      return (
        <Link
          to="/app/projects/$projectId/domains/$type"
          params={{ ...params, type: a.subject }}
          search={env}
        >
          {body}
        </Link>
      );
    case "JOB_FAILED":
      return (
        <Link to="/app/projects/$projectId/infra" params={params} search={env}>
          {body}
        </Link>
      );
    case "PROJECT_EXPIRING":
      return (
        <Link
          to="/app/projects/$projectId/settings"
          params={params}
          search={{ tab: "project" }}
        >
          {body}
        </Link>
      );
    case "ROLLOUT_PAUSED":
      return a.refId === null ? (
        <Link
          to="/app/projects/$projectId/rollouts"
          params={params}
          search={env}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/app/projects/$projectId/rollouts/$rolloutId"
          params={{ ...params, rolloutId: a.refId }}
          search={env}
        >
          {body}
        </Link>
      );
  }
}
