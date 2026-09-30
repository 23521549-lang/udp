import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HomeAttentionWire, HomeWire } from "@udp/shared-types/wire";
import { Plus } from "lucide-react";
import { BarChart } from "../../components/BarChart";
import { Icon } from "../../components/Icon";
import { PageHead } from "../../components/PageHead";
import { ErrorState, Loading } from "../../components/States";
import { StatusLabel, type Tone } from "../../components/StatusLabel";
import {
  formatDateTime,
  formatNumber,
  formatPercent,
  relativeTime,
} from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { useAuthStore } from "../auth/auth-store";
import { deployBars } from "../deployment/deploy-bars";
import { PROVIDER_LABEL } from "../project/cloud/cloud-labels";
import { ProjectStatus } from "../project/ProjectStatus";
import { rolesMessages } from "../project/roles.messages";
import { useLocale, useMessages, type Locale } from "../../i18n";
import { domainName } from "../domain/domain-labels";
import { jobTypeLabel } from "../provisioning/provisioning-labels";
import { RolloutStatusLabel } from "../rollout/rollout-status";
import { FirstRun } from "./FirstRun";
import { homeApi } from "./home-api";
import { homeMessages } from "./home.messages";

type AttentionCopy = (typeof homeMessages)["vi"]["attention"];

/**
 * Trang chủ developer (Plan #53 QĐ-5, QĐ-7): việc cần xử lý của MỌI project đứng đầu — mỗi dòng dẫn
 * thẳng tới chỗ sửa — rồi rollout đang chạy, thẻ project và deploy 14 ngày. Một lời gọi `GET /home`.
 */
export function HomePage() {
  const m = useMessages(homeMessages);
  const locale = useLocale();
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
          <b>{m.home}</b>
        </div>
        <div className="r">
          <Link to="/app/projects/new" className="btn pri">
            <Icon of={Plus} />
            {m.createProject}
          </Link>
        </div>
      </div>
      <div className="scroll">
        <PageHead
          title={
            user === null ? m.home : m.hello(givenNameOf(user.name, locale))
          }
          lead={m.lead}
          minis={
            // [Plan #58 UX-11] Ba số 0 không nói gì với người mới: ẩn khi mọi số đều 0
            h === undefined ||
            h.projects.length + h.rollouts.length + h.attention.length === 0
              ? undefined
              : [
                  {
                    value: h.projects.length,
                    label: m.minis.projects(h.projects.length),
                  },
                  {
                    value: h.rollouts.length,
                    label: m.minis.rollouts(h.rollouts.length),
                  },
                  {
                    value: h.attention.length,
                    label: m.minis.attention(h.attention.length),
                  },
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
            <FirstRun />
          ) : (
            <HomeBody home={home.data.home} />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Tên gọi trong lời chào. Tiếng Việt gọi bằng chữ CUỐI của họ tên ("Nguyễn Thị Lan" ⇒ "Lan"); [Plan #58 UX-24]
 * tiếng Anh gọi bằng chữ ĐẦU ("Jane Doe" ⇒ "Jane"), không phải họ.
 */
export function givenNameOf(name: string, locale: Locale): string {
  const words = name.trim().split(/\s+/);
  const given = locale === "vi" ? words[words.length - 1] : words[0];
  return given === undefined || given === "" ? name : given;
}

function HomeBody({ home }: { home: HomeWire }) {
  const roles = useMessages(rolesMessages).role;
  const m = useMessages(homeMessages);
  return (
    <>
      <section aria-labelledby="home-attention">
        <div className="sect">
          <h2 id="home-attention">{m.attentionTitle}</h2>
        </div>
        {home.attention.length === 0 ? (
          <p className="c3">{m.attentionNone}</p>
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
          <h2 id="home-rollouts">{m.rolloutsTitle}</h2>
        </div>
        {home.rollouts.length === 0 ? (
          <p className="c3">{m.rolloutsNone}</p>
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
          <h2 id="home-projects">{m.projectsTitle}</h2>
          <div className="r">
            <Link to="/app/projects" className="btn">
              {m.allProjects}
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
                  , {m.card.environments(p.environmentCount)}
                </span>
                <span className="home-card-n">
                  <span>
                    {m.card.rollouts(
                      <b className="num">{p.activeRollouts}</b>,
                      p.activeRollouts,
                    )}
                  </span>
                  <span>
                    {m.card.attention(
                      <b className="num">{p.attention}</b>,
                      p.attention,
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label={m.deploys}>
        <BarChart
          title={m.deploys}
          level={2}
          format={formatNumber}
          data={deployBars(home.deploys, {
            success: m.succeeded,
            failure: m.failed,
          })}
        />
      </section>
    </>
  );
}

const ATTENTION: Record<
  HomeAttentionWire["kind"],
  { tone: Tone; text: (a: HomeAttentionWire, t: AttentionCopy) => string }
> = {
  DEPLOY_PENDING: {
    tone: "warn",
    text: (a, t) => t.deployPending(a.subject),
  },
  // [Plan #58 UX-7] Tên domain đọc được ("GitOps"), không phải mã GITOPS
  DOMAIN_ERROR: {
    tone: "error",
    text: (a, t) => t.domainError(domainName(a.subject)),
  },
  DOMAIN_DRIFTED: {
    tone: "warn",
    text: (a, t) => t.domainDrifted(domainName(a.subject)),
  },
  JOB_FAILED: {
    tone: "error",
    text: (a, t) => t.jobFailed(jobTypeLabel(a.subject)),
  },
  PROJECT_EXPIRING: {
    tone: "warn",
    text: (_a, t) => t.projectExpiring,
  },
  ROLLOUT_PAUSED: {
    tone: "warn",
    text: (a, t) => t.rolloutPaused(a.subject),
  },
};

/** Một việc cần xử lý: câu, project/env, lúc — và link tới ĐÚNG chỗ sửa */
function AttentionRow({ item: a }: { item: HomeAttentionWire }) {
  const copy = useMessages(homeMessages).attention;
  const kind = ATTENTION[a.kind];
  const body = (
    <>
      <StatusLabel tone={kind.tone}>{kind.text(a, copy)}</StatusLabel>
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
