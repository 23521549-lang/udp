import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { StatusLabel } from "../../components/StatusLabel";
import { useMessages } from "../../i18n";
import { qk } from "../../lib/query-keys";
import { architectureApi } from "../architecture/architecture-api";
import { deploymentApi } from "../deployment/deployment-api";
import { useFlagCounts } from "../flag/flag-counts";
import {
  doneCount,
  hideStart,
  isStartHidden,
  START_TASKS,
  startFacts,
  type StartTask,
} from "./getting-started";
import { useProjectContext } from "./ProjectLayout";
import { projectApi } from "./project-api";
import { projectMessages } from "./project.messages";

/**
 * [Plan #58 UX-12] Thẻ "Bắt đầu" ở Tổng quan: năm việc tự đánh dấu (SDK key, flag đầu tiên, cloud, domain, deploy
 * đầu tiên), làm thứ tự nào cũng được, mỗi việc là một link tới đúng chỗ làm nó. Xong hết hay bấm Ẩn thì thẻ biến mất
 * và KHÔNG hỏi máy chủ nữa (ghi theo project ở localStorage). Chỉ chủ sở hữu thấy: SDK key và cloud là việc của họ.
 *
 * Mọi query dùng CHÍNH key của trang Cài đặt, Tổng quan và Deploy: đã tải ở đó thì ở đây không tốn thêm lời gọi.
 */
export function GettingStarted() {
  const { project } = useProjectContext();
  const [hidden, setHidden] = useState(() => isStartHidden(project.id));
  if (hidden) return null;
  return (
    <StartCard
      onHide={() => {
        hideStart(project.id);
        setHidden(true);
      }}
    />
  );
}

function StartCard({ onHide }: { onHide: () => void }) {
  const m = useMessages(projectMessages).overview.start;
  const { project, envs, env } = useProjectContext();
  const keys = useQueries({
    queries: envs.map((e) => ({
      queryKey: qk.sdkKeys(project.id, e.id),
      queryFn: () => projectApi.sdkKeys(project.id, e.id),
    })),
  });
  const latest = useQueries({
    queries: envs.map((e) => ({
      queryKey: qk.deploymentLatest(project.id, e.id),
      queryFn: () => deploymentApi.latest(project.id, e.id),
      staleTime: 30_000,
    })),
  });
  const arch = useQuery({
    queryKey: qk.architecture(project.id),
    queryFn: () => architectureApi.get(project.id),
  });
  const flags = useFlagCounts(project.id, env.id);
  const facts = startFacts({
    keysByEnv: keys.map((q) => q.data?.keys),
    flagTotal: flags.total,
    architecture: arch.data?.architecture,
    latestByEnv: latest.map((q) => q.data),
  });
  const done = doneCount(facts);
  const complete = done === START_TASKS.length;
  // Xong hết: thẻ đã làm xong việc của nó, không hiện lại ở lần mở sau
  useEffect(() => {
    if (complete) onHide();
  }, [complete, onHide]);

  const params = { projectId: project.id };
  const search = { env: env.id };
  const link = (task: StartTask, title: string) => {
    switch (task) {
      case "sdkKey":
        return (
          <Link
            to="/app/projects/$projectId/settings"
            params={params}
            search={{ ...search, tab: "keys" }}
          >
            {title}
          </Link>
        );
      case "flag":
        return (
          <Link
            to="/app/projects/$projectId/flags"
            params={params}
            search={{ ...search, new: "1" }}
          >
            {title}
          </Link>
        );
      case "cloud":
        return (
          <Link
            to="/app/projects/$projectId/settings"
            params={params}
            search={{ ...search, tab: "cloud" }}
          >
            {title}
          </Link>
        );
      case "domains":
        return (
          <Link
            to="/app/projects/$projectId/domains"
            params={params}
            search={search}
          >
            {title}
          </Link>
        );
      case "deploy":
        // Chưa có hạ tầng thì việc đầu tiên là dựng nó; có rồi thì lịch sử deploy là chỗ thấy lần đầu
        return (
          <Link
            to={
              project.status === "ACTIVE"
                ? "/app/projects/$projectId/deployments"
                : "/app/projects/$projectId/infra"
            }
            params={params}
            search={search}
          >
            {title}
          </Link>
        );
    }
  };

  return (
    <section className="kpi start-card" aria-labelledby="ov-start">
      <div className="sect">
        <h2 id="ov-start">{m.title}</h2>
        <span className="c3">{m.progress(done, START_TASKS.length)}</span>
        <div className="r">
          <button type="button" className="btn" onClick={onHide}>
            {m.hide}
          </button>
        </div>
      </div>
      <p className="c3">{m.lead}</p>
      <ul className="start-list">
        {START_TASKS.map((task) => {
          const copy = m.task[task];
          const state = facts[task];
          return (
            <li key={task}>
              <span className="start-t">
                {link(task, copy.title)}
                <span className="c3">{copy.hint}</span>
              </span>
              {state === true ? (
                <StatusLabel tone="ok">{m.done}</StatusLabel>
              ) : state === false ? (
                <span className="chip soft">{m.todo}</span>
              ) : (
                <span className="c3">{m.checking}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
