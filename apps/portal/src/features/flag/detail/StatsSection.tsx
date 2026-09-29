import { useQuery } from "@tanstack/react-query";
import type {
  FlagDetailWire,
  PublicEnvironmentWire,
} from "@udp/shared-types/wire";
import { ErrorState, Loading } from "../../../components/States";
import { useMessages } from "../../../i18n";
import { browserTimeZone, compactNumber } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { flagApi } from "../flag-api";
import { useProjectContext } from "../../project/ProjectLayout";
import { variantColor } from "../RuleEditor";
import { detailMessages } from "./detail.messages";

export function StatsSection({
  flag,
  env,
}: {
  flag: FlagDetailWire;
  env: PublicEnvironmentWire;
}) {
  const m = useMessages(detailMessages).stats;
  const { project } = useProjectContext();
  const tz = browserTimeZone();
  const days = 7;
  const stats = useQuery({
    queryKey: qk.flagStats(project.id, flag.id, env.id, days, "day", tz),
    queryFn: () => flagApi.stats(project.id, flag.id, env.id, days, tz),
  });
  const byEnv = stats.data?.byEnv.find((b) => b.environment.id === env.id);

  return (
    <section aria-label={m.section}>
      <div className="sect">
        <h3>{m.last7Days(env.name)}</h3>
      </div>
      {stats.isPending ? (
        <Loading />
      ) : stats.isError ? (
        <ErrorState error={stats.error} />
      ) : byEnv === undefined || byEnv.evalCount === 0 ? (
        <p className="c3">{m.none}</p>
      ) : (
        <div className="dist">
          <div className="bar2" aria-hidden="true">
            {byEnv.variants.map((v, i) => (
              <i
                key={v.variantKey}
                style={{
                  width: `${String(v.share * 100)}%`,
                  background: variantColor(i),
                }}
              />
            ))}
          </div>
          {byEnv.variants.map((v, i) => (
            <div key={v.variantKey} className="dr">
              <span className="vd" style={{ background: variantColor(i) }} />
              <span className="mono">{v.variantKey}</span>
              <span className="num c3">
                {m.evals(compactNumber(v.count), v.count)}
              </span>
              <span className="pct">{Math.round(v.share * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
