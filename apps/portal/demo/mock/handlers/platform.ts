import type {
  DomainCatalogEntryWire,
  JobDetailWire,
  ProjectDomainWire,
} from "@udp/shared-types/wire";
import { elapsedSeconds, nowIso } from "../clock";
import type { Db, ProjectRecord } from "../db";
import { golden } from "../goldens";
import {
  bodyOf,
  found,
  HttpProblem,
  intParam,
  ok,
  projectOf,
  type Router,
} from "../router";
import { resourcesOf } from "../seed";
import { audit } from "./project";

/** Domain và công cụ (§5.5, §8.6), provisioning (§8.1), Golden Path và quét repo (§11) */

const CATALOG = golden<{ domains: DomainCatalogEntryWire[] }>(
  "GET /domains/catalog",
);

function domainOf(p: ProjectRecord, type: string): ProjectDomainWire {
  return found(
    p.domains.domains.find((d) => d.domainType === type),
    `domain ${type}`,
  );
}

function newJob(
  jobType: JobDetailWire["job"]["jobType"],
  state: JobDetailWire["job"]["state"],
): JobDetailWire["job"] {
  const at = nowIso();
  return {
    id: crypto.randomUUID(),
    jobType,
    state,
    attempt: 0,
    confirmedMonthlyUsd: null,
    lastError: null,
    cancellable: state === "QUEUED",
    createdAt: at,
    updatedAt: at,
  };
}

/** Giá trị rõ của trường bí mật không bao giờ được lưu hay trả lại (§4.3) — chỉ còn dấu "đã giữ" */
function maskSecrets(
  domainType: string,
  toolId: string | null,
  config: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (config === null || toolId === null) return config;
  const tool = CATALOG.domains
    .find((d) => d.domainType === domainType)
    ?.tools.find((t) => t.toolId === toolId);
  if (tool === undefined || tool.config.kind !== "object") return config;
  const masked = { ...config };
  for (const field of tool.config.fields) {
    if (field.secret === true && typeof masked[field.key] === "string") {
      masked[field.key] = { $udpSecret: "kept" };
    }
  }
  return masked;
}

/** Một domain được bật trong thân `validate`/`PUT` — domain vắng mặt là tắt */
interface DomainTarget {
  domainType: string;
  toolId: string;
  config: Record<string, unknown>;
}

const targetKey = (d: DomainTarget): string =>
  `${d.domainType.toLowerCase()}:${d.toolId}`;

function scaleCost(p: ProjectRecord, days: number) {
  if (p.cost === null) {
    throw new HttpProblem(
      409,
      "COST_NOT_ENABLED",
      "Project chưa bật OpenCost hay Kubecost — chưa có chi phí thực để hiện",
    );
  }
  const round = (x: number) => Math.round(x * days * 100) / 100;
  const environments = p.cost.environments.map((e) => ({
    ...e,
    totalUsd: round(e.totalUsd),
    cpuUsd: round(e.cpuUsd),
    ramUsd: round(e.ramUsd),
    storageUsd: round(e.storageUsd),
    networkUsd: round(e.networkUsd),
  }));
  return {
    ...p.cost,
    days,
    totalUsd:
      Math.round(environments.reduce((s, e) => s + e.totalUsd, 0) * 100) / 100,
    environments,
  };
}

function provision(
  db: Db,
  p: ProjectRecord,
  confirmedMonthlyUsd: number | null,
): JobDetailWire["job"] {
  if (p.preview.blockers.length > 0) {
    throw new HttpProblem(
      409,
      "PROVISION_BLOCKED",
      `Chưa dựng được: ${p.preview.blockers.join(", ")}`,
    );
  }
  const job = { ...newJob("PROVISION", "QUEUED"), confirmedMonthlyUsd };
  const t = elapsedSeconds();
  const provider = p.cloud?.provider ?? "AWS";
  p.jobs.unshift({
    detail: { job, resources: [], domains: [] },
    live: {
      schedule: [
        { state: "QUEUED", at: t },
        { state: "NETWORK", at: t + 4 },
        { state: "CLUSTER", at: t + 45 },
        { state: "CLUSTER_ACCESS", at: t + 110 },
        { state: "DOMAINS", at: t + 125 },
        { state: "DONE", at: t + 150 },
      ],
      plan: resourcesOf(provider, "READY", nowIso()),
      domains: [
        { domainType: "CONTAINER_REGISTRY", status: "ACTIVE", message: null },
        { domainType: "MONITORING", status: "ACTIVE", message: null },
        { domainType: "LOGGING", status: "ACTIVE", message: null },
      ],
    },
  });
  p.project.status = "PROVISIONING";
  p.preview.blockers = ["job-active"];
  audit(db, p, "project.provision", "Project", p.project.id, null, {
    confirmedMonthlyUsd,
  });
  return job;
}

export function registerPlatformRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/domains/catalog", () => ok(CATALOG))
    .on("GET", "/projects/:id/domains", (_req, [id = ""]) => {
      const { domainSetVersion, domains, preferences } = projectOf(
        db,
        id,
      ).domains;
      return ok({ domainSetVersion, domains, preferences });
    })
    .on("POST", "/projects/:id/domains/validate", (req, [id = ""]) => {
      projectOf(db, id);
      const { domains: enabled } = bodyOf<{ domains: DomainTarget[] }>(req);
      const has = (type: string) => enabled.some((d) => d.domainType === type);
      return ok({
        validation: {
          valid: true,
          errors: [],
          warnings: has("TRACING")
            ? []
            : [
                {
                  code: "RECOMMENDED_MISSING",
                  subject:
                    enabled[0] === undefined
                      ? "project"
                      : targetKey(enabled[0]),
                  detail: ["traces.sink"],
                },
              ],
          deployOrder: enabled.length === 0 ? [] : [enabled.map(targetKey)],
        },
      });
    })
    .on("PUT", "/projects/:id/domains", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const body = bodyOf<{
        domains: DomainTarget[];
        preferences: ProjectRecord["domains"]["preferences"];
      }>(req);
      const at = nowIso();
      for (const current of p.domains.domains) {
        const next = body.domains.find(
          (d) => d.domainType === current.domainType,
        );
        const unchanged =
          next !== undefined &&
          current.isEnabled &&
          current.selectedTool === next.toolId &&
          JSON.stringify(current.toolConfig) === JSON.stringify(next.config);
        if (unchanged || (next === undefined && !current.isEnabled)) continue;
        current.isEnabled = next !== undefined;
        current.selectedTool = next?.toolId ?? null;
        current.toolConfig =
          next === undefined
            ? null
            : maskSecrets(next.domainType, next.toolId, next.config);
        current.status = next === undefined ? null : "ACTIVE";
        current.adapterVersion = next === undefined ? null : "1.0.0";
        current.updatedAt = at;
        p.domains.drift[current.domainType] =
          next === undefined
            ? { verdict: "NOT_DEPLOYED", message: null, at: null }
            : { verdict: "CLEAN", message: null, at };
        if (next !== undefined) {
          p.domains.versions[current.domainType] ??= {
            domainType: current.domainType,
            toolId: next.toolId,
            current: "1.0.0",
            available: [],
          };
        }
      }
      p.domains.preferences = body.preferences;
      p.domains.domainSetVersion += 1;
      audit(db, p, "domain.update", "ProjectDomain", p.project.id, null, {
        enabled: body.domains.map((d) => d.domainType),
      });
      const running = p.project.status === "ACTIVE";
      const job = running ? newJob("DOMAIN_APPLY", "QUEUED") : null;
      if (job !== null) {
        p.jobs.unshift({
          detail: {
            job: { ...job, state: "DONE", cancellable: false },
            resources: [],
            domains: body.domains.map((d) => ({
              domainType: d.domainType,
              status: "ACTIVE" as const,
              message: null,
            })),
          },
        });
      }
      const { domainSetVersion, domains, preferences } = p.domains;
      return ok(
        { domainSetVersion, domains, preferences, job },
        running ? 202 : 200,
      );
    })
    .on("GET", "/projects/:id/domains/CICD/webhook", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      if (p.cicd === null) {
        throw new HttpProblem(
          409,
          "CICD_NOT_ENABLED",
          "Project chưa bật domain CI/CD",
        );
      }
      return ok({ cicd: p.cicd });
    })
    .on(
      "POST",
      "/projects/:id/domains/CICD/webhook-secret",
      (_req, [id = ""]) => {
        const p = projectOf(db, id);
        const cicd = found(p.cicd ?? undefined, "cấu hình CI/CD");
        cicd.secretSet = true;
        const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        audit(
          db,
          p,
          "cicd.secret.rotate",
          "ProjectDomain",
          p.project.id,
          null,
          null,
        );
        return ok({
          provider: cicd.provider,
          webhookPath: cicd.webhookPath,
          secret,
        });
      },
    )
    .on(
      "GET",
      "/projects/:id/domains/CICD/pipeline-template",
      (_req, [id = ""]) => {
        projectOf(db, id);
        return ok(golden("GET /projects/{id}/domains/CICD/pipeline-template"));
      },
    )
    .on("GET", "/projects/:id/domains/:type", (_req, [id = "", type = ""]) =>
      ok({ domain: domainOf(projectOf(db, id), type) }),
    )
    .on(
      "GET",
      "/projects/:id/domains/:type/drift",
      (_req, [id = "", type = ""]) => {
        const p = projectOf(db, id);
        domainOf(p, type);
        return ok({
          drift: p.domains.drift[type] ?? {
            verdict: "NOT_DEPLOYED",
            message: null,
            at: null,
          },
        });
      },
    )
    .on(
      "POST",
      "/projects/:id/domains/:type/drift",
      (_req, [id = "", type = ""]) => {
        const p = projectOf(db, id);
        domainOf(p, type);
        const current = p.domains.drift[type] ?? {
          verdict: "NOT_DEPLOYED" as const,
          message: null,
          at: null,
        };
        const scanned = {
          ...current,
          at: current.verdict === "NOT_DEPLOYED" ? null : nowIso(),
        };
        p.domains.drift[type] = scanned;
        return ok({ drift: scanned });
      },
    )
    .on(
      "GET",
      "/projects/:id/domains/:type/versions",
      (_req, [id = "", type = ""]) => {
        const p = projectOf(db, id);
        return ok({
          versions: found(
            p.domains.versions[type],
            `phiên bản của domain ${type}`,
          ),
        });
      },
    )
    .on(
      "POST",
      "/projects/:id/domains/:type/upgrade",
      (req, [id = "", type = ""]) => {
        const p = projectOf(db, id);
        const domain = domainOf(p, type);
        const versions = found(
          p.domains.versions[type],
          `phiên bản của domain ${type}`,
        );
        const { toVersion } = bodyOf<{ toVersion?: string }>(req);
        const target =
          toVersion ?? versions.available[0]?.version ?? versions.current;
        audit(
          db,
          p,
          "domain.upgrade",
          "ProjectDomain",
          p.project.id,
          { version: versions.current },
          { version: target },
        );
        versions.current = target;
        versions.available = [];
        domain.adapterVersion = target;
        domain.updatedAt = nowIso();
        return ok({ job: newJob("DOMAIN_APPLY", "QUEUED") }, 202);
      },
    )
    .on(
      "POST",
      "/projects/:id/domains/:type/retry",
      (_req, [id = "", type = ""]) => {
        const p = projectOf(db, id);
        const domain = domainOf(p, type);
        domain.status = "ACTIVE";
        domain.updatedAt = nowIso();
        p.domains.drift[type] = {
          verdict: "CLEAN",
          message: null,
          at: nowIso(),
        };
        audit(
          db,
          p,
          "domain.retry",
          "ProjectDomain",
          p.project.id,
          { status: "ERROR" },
          { status: "ACTIVE" },
        );
        return ok({ job: newJob("DOMAIN_APPLY", "QUEUED") }, 202);
      },
    )

    // ---------------------------------------------------------- provisioning
    .on("GET", "/projects/:id/preview", (_req, [id = ""]) =>
      ok({ preview: projectOf(db, id).preview }),
    )
    .on("GET", "/projects/:id/cost", (req, [id = ""]) => {
      const days = Math.min(Math.max(intParam(req.query, "days", 7), 1), 90);
      return ok({ cost: scaleCost(projectOf(db, id), days) });
    })
    .on("POST", "/projects/:id/provision", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const { confirmedMonthlyUsd } = bodyOf<{ confirmedMonthlyUsd?: number }>(
        req,
      );
      return ok({ job: provision(db, p, confirmedMonthlyUsd ?? null) }, 202);
    })
    .on("GET", "/projects/:id/jobs", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      return ok({
        jobs: p.jobs
          .map((j) => j.detail.job)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      });
    })
    .on("GET", "/projects/:id/jobs/:jobId", (_req, [id = "", jobId = ""]) => {
      const p = projectOf(db, id);
      return ok(
        found(
          p.jobs.find((j) => j.detail.job.id === jobId),
          "job",
        ).detail,
      );
    })
    .on(
      "POST",
      "/projects/:id/jobs/:jobId/cancel",
      (_req, [id = "", jobId = ""]) => {
        const p = projectOf(db, id);
        const record = found(
          p.jobs.find((j) => j.detail.job.id === jobId),
          "job",
        );
        const { job } = record.detail;
        if (!job.cancellable) {
          throw new HttpProblem(
            409,
            "JOB_NOT_CANCELLABLE",
            "Job đã tới trạng thái cuối, không huỷ được nữa",
          );
        }
        delete record.live;
        job.state = "FAILED";
        job.cancellable = false;
        job.updatedAt = nowIso();
        job.lastError = {
          step: "COMPENSATION",
          message: "hủy theo yêu cầu — đã dọn sạch tài nguyên đã tạo",
          orphans: [],
          at: nowIso(),
        };
        record.detail.resources = record.detail.resources.map((r) => ({
          ...r,
          status: "DELETED" as const,
        }));
        p.project.status = "DRAFT";
        p.preview.blockers = [];
        audit(db, p, "job.cancel", "ProvisioningJob", job.id, null, {
          state: "FAILED",
        });
        return ok({ job }, 202);
      },
    )

    // ---------------------------------------------------------- code
    .on("GET", "/projects/:id/golden-path", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      const path = golden<{ runtime: string; slug: string }>(
        "GET /projects/{id}/golden-path",
      );
      return ok({ ...path, slug: p.project.name });
    })
    .on("GET", "/projects/:id/repo-scan", (_req, [id = ""]) => {
      projectOf(db, id);
      return ok(golden("GET /projects/{id}/repo-scan"));
    })
    .on("POST", "/projects/:id/repo-scan", (_req, [id = ""]) => {
      projectOf(db, id);
      return ok(golden("POST /projects/{id}/repo-scan"));
    });
}
