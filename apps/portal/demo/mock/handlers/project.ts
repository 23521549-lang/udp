import type {
  CloudCredentialWire,
  CloudSetupWire,
  ProjectRoleWire,
  PublicEnvironmentWire,
  SdkKeyWire,
} from "@udp/shared-types/wire";
import { nowIso } from "../clock";
import type { Db, ProjectRecord } from "../db";
import { golden } from "../goldens";
import { hex } from "../random";
import {
  bodyOf,
  found,
  HttpProblem,
  intParam,
  noContent,
  ok,
  projectOf,
  type Router,
} from "../router";
import { createDraftProject } from "../seed";

/** Project, thành viên, environment, SDK key, nhật ký thao tác, cloud (§9 nhóm project) */

const randomHex = (n: number): string => hex(() => Math.random(), n);

function queuedJob(
  jobType: "ENVIRONMENT_APPLY" | "DOMAIN_APPLY" | "PROVISION" | "TEARDOWN",
) {
  const at = nowIso();
  return {
    id: crypto.randomUUID(),
    jobType,
    state: "QUEUED" as const,
    attempt: 0,
    confirmedMonthlyUsd: null,
    lastError: null,
    cancellable: false,
    createdAt: at,
    updatedAt: at,
  };
}

export function audit(
  db: Db,
  p: ProjectRecord,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown,
  environmentId: string | null = null,
): void {
  p.audit.unshift({
    id: crypto.randomUUID(),
    action,
    actorType: "USER",
    actorUserId: db.me.id,
    targetType,
    targetId,
    environmentId,
    before,
    after,
    occurredAt: nowIso(),
  });
}

const envOf = (p: ProjectRecord, envId: string): PublicEnvironmentWire =>
  found(
    p.environments.find((e) => e.id === envId),
    "environment",
  );

function setupFor(
  provider: "AWS" | "GCP" | "AZURE",
  projectId: string,
): CloudSetupWire {
  const setup = golden<{ setup: CloudSetupWire }>(
    "GET /projects/{id}/cloud/setup",
  ).setup;
  const subject = `project:${projectId}`;
  if (provider === "AZURE") return { ...setup, subject };
  const aws = provider === "AWS";
  return {
    ...setup,
    provider,
    subject,
    methods: [
      {
        authKind: aws ? "AWS_ROLE" : "GCP_WIF",
        federated: true,
        available: true,
        unavailableReason: null,
        snippets: [
          aws
            ? {
                id: "aws-role-trust-policy",
                language: "json",
                content: JSON.stringify(
                  {
                    Version: "2012-10-17",
                    Statement: [
                      {
                        Effect: "Allow",
                        Principal: {
                          AWS: "arn:aws:iam::381492000150:role/udp-control-plane",
                        },
                        Action: "sts:AssumeRole",
                        Condition: {
                          StringEquals: {
                            "sts:ExternalId": `udp-${projectId.slice(0, 8)}`,
                          },
                        },
                      },
                    ],
                  },
                  null,
                  2,
                ),
              }
            : {
                id: "gcp-workload-identity-pool",
                language: "shell",
                content: [
                  "gcloud iam workload-identity-pools create udp --location=global",
                  "gcloud iam workload-identity-pools providers create-oidc udp \\",
                  "  --location=global --workload-identity-pool=udp \\",
                  "  --issuer-uri=https://udp.example/oidc \\",
                  `  --attribute-mapping=google.subject=assertion.sub --attribute-condition="assertion.sub=='${subject}'"`,
                  "gcloud iam service-accounts add-iam-policy-binding udp-deployer@<PROJECT_ID>.iam.gserviceaccount.com \\",
                  "  --role=roles/iam.workloadIdentityUser \\",
                  `  --member="principal://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/udp/subject/${subject}"`,
                ].join("\n"),
              },
        ],
      },
      {
        authKind: aws ? "AWS_KEY" : "GCP_KEY",
        federated: false,
        available: true,
        unavailableReason: null,
        snippets: [
          {
            id: aws ? "aws-access-key" : "gcp-service-account-key",
            language: "shell",
            content: aws
              ? "aws iam create-access-key --user-name udp-deployer"
              : "gcloud iam service-accounts keys create key.json --iam-account=udp-deployer@<PROJECT_ID>.iam.gserviceaccount.com",
          },
        ],
      },
    ],
    requiredPermissions: aws
      ? [
          "ec2:CreateVpc",
          "ec2:CreateSubnet",
          "ec2:CreateNatGateway",
          "eks:CreateCluster",
          "eks:CreateNodegroup",
          "iam:CreateRole",
          "iam:PassRole",
        ]
      : [
          "compute.networks.create",
          "compute.subnetworks.create",
          "compute.routers.create",
          "container.clusters.create",
          "iam.serviceAccounts.actAs",
        ],
    docUrl: `https://udp.example/docs/byoc/${provider.toLowerCase()}`,
  };
}

export function registerProjectRoutes(router: Router, db: Db): void {
  router
    .on("GET", "/projects", (req) => {
      const visible = db.projects.filter(
        (p) => !p.adminOnly && p.project.status !== "DELETED",
      );
      const offset = intParam(req.query, "offset", 0);
      const limit = intParam(req.query, "limit", 50);
      return ok({
        projects: visible.slice(offset, offset + limit).map((p) => p.project),
        total: visible.length,
      });
    })
    .on("POST", "/projects", (req) => {
      const body = bodyOf<{
        name: string;
        creationMode: "CREATE_NEW" | "IMPORT_EXISTING";
        languageRuntime: string;
        repoUrl?: string;
      }>(req);
      if (
        db.projects.some(
          (p) => p.project.name === body.name && p.project.status !== "DELETED",
        )
      ) {
        throw new HttpProblem(
          409,
          "PROJECT_NAME_TAKEN",
          `Đã có project tên "${body.name}"`,
        );
      }
      const record = createDraftProject(body);
      db.projects.unshift(record);
      audit(db, record, "project.create", "Project", record.project.id, null, {
        name: body.name,
        creationMode: body.creationMode,
      });
      return ok(
        {
          project: record.project,
          environments: record.environments,
          cluster: null,
        },
        201,
      );
    })
    .on("GET", "/projects/:id", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      return ok({
        project: p.project,
        environments: p.environments,
        cluster: p.cluster,
      });
    })
    .on("DELETE", "/projects/:id", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      p.project.status = "DELETED";
      return noContent;
    })
    .on("PATCH", "/projects/:id/quota", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const { resourceQuota } = bodyOf<{
        resourceQuota: typeof p.project.resourceQuota;
      }>(req);
      audit(
        db,
        p,
        "project.quota.update",
        "Project",
        p.project.id,
        p.project.resourceQuota,
        resourceQuota,
      );
      p.project.resourceQuota = resourceQuota;
      return ok({ project: p.project });
    })
    .on("PATCH", "/projects/:id/ttl", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const { expiresAt } = bodyOf<{ expiresAt: string | null }>(req);
      p.project.expiresAt = expiresAt;
      audit(db, p, "project.ttl.update", "Project", p.project.id, null, {
        expiresAt,
      });
      return ok({ project: p.project });
    })
    .on("GET", "/projects/:id/audit", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const action = req.query.get("action");
      const limit = intParam(req.query, "limit", 50);
      const offset = intParam(req.query, "offset", 0);
      const matched = p.audit.filter(
        (e) => action === null || action === "" || e.action.startsWith(action),
      );
      return ok({
        entries: matched.slice(offset, offset + limit),
        total: matched.length,
      });
    })

    // ---------------------------------------------------------- thành viên
    .on("GET", "/projects/:id/members", (_req, [id = ""]) =>
      ok({ members: projectOf(db, id).members }),
    )
    .on("POST", "/projects/:id/members", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const body = bodyOf<{
        email: string;
        projectRole: Exclude<ProjectRoleWire, "OWNER">;
      }>(req);
      const user = db.users.find((u) => u.email === body.email.toLowerCase());
      if (user === undefined) {
        throw new HttpProblem(
          404,
          "USER_NOT_FOUND",
          `Không có người dùng nào đăng ký bằng ${body.email}`,
        );
      }
      if (p.members.some((m) => m.userId === user.id)) {
        throw new HttpProblem(
          409,
          "ALREADY_MEMBER",
          `${user.name} đã là thành viên`,
        );
      }
      const member = {
        userId: user.id,
        projectRole: body.projectRole,
        createdAt: nowIso(),
        user: { id: user.id, email: user.email, name: user.name },
      };
      p.members.push(member);
      audit(db, p, "member.add", "ProjectMember", user.id, null, {
        projectRole: body.projectRole,
      });
      return ok({ member }, 201);
    })
    .on(
      "PATCH",
      "/projects/:id/members/:userId",
      (req, [id = "", userId = ""]) => {
        const p = projectOf(db, id);
        const member = found(
          p.members.find((m) => m.userId === userId),
          "thành viên",
        );
        const { projectRole } = bodyOf<{
          projectRole: Exclude<ProjectRoleWire, "OWNER">;
        }>(req);
        audit(
          db,
          p,
          "member.update",
          "ProjectMember",
          userId,
          { projectRole: member.projectRole },
          { projectRole },
        );
        member.projectRole = projectRole;
        return ok({ member });
      },
    )
    .on(
      "DELETE",
      "/projects/:id/members/:userId",
      (_req, [id = "", userId = ""]) => {
        const p = projectOf(db, id);
        p.members = p.members.filter((m) => m.userId !== userId);
        audit(db, p, "member.remove", "ProjectMember", userId, null, null);
        return noContent;
      },
    )
    .on("POST", "/projects/:id/transfer-ownership", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const { userId } = bodyOf<{ userId: string }>(req);
      const next = found(
        p.members.find((m) => m.userId === userId),
        "thành viên",
      );
      for (const m of p.members) {
        if (m.projectRole === "OWNER") m.projectRole = "MAINTAINER";
      }
      next.projectRole = "OWNER";
      p.project.ownerId = userId;
      p.project.myRole = userId === db.me.id ? "OWNER" : "MAINTAINER";
      audit(db, p, "project.transfer", "Project", p.project.id, null, {
        ownerId: userId,
      });
      return ok({ member: next });
    })

    // ---------------------------------------------------------- environment
    .on("GET", "/projects/:id/environments", (_req, [id = ""]) =>
      ok({ environments: projectOf(db, id).environments }),
    )
    .on("POST", "/projects/:id/environments", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const body = bodyOf<{
        name: string;
        isProduction?: boolean;
        autoDeploy?: boolean;
      }>(req);
      const environment: PublicEnvironmentWire = {
        id: crypto.randomUUID(),
        name: body.name,
        k8sNamespace: `udp-${p.project.name}-${p.project.id.slice(0, 6)}-${body.name}`,
        isProduction: body.isProduction ?? false,
        rank: p.environments.length,
        autoDeploy: body.autoDeploy ?? true,
      };
      p.environments.push(environment);
      p.sdkKeys[environment.id] = [];
      p.deployments[environment.id] = [];
      for (const f of p.flags) {
        f.rules[environment.id] = [];
        f.rulesUpdatedAt[environment.id] = nowIso();
        f.daily[environment.id] = Array.from({ length: 30 }, () => 0);
        f.mix[environment.id] = {};
        f.detail.envs.push({
          environment: {
            id: environment.id,
            name: environment.name,
            isProduction: environment.isProduction,
          },
          configId: crypto.randomUUID(),
          isEnabled: false,
          defaultVariantId: null,
          isTracked: false,
          ruleCount: 0,
          updatedAt: nowIso(),
        });
      }
      audit(db, p, "environment.create", "Environment", environment.id, null, {
        name: body.name,
      });
      const job = p.cluster === null ? null : queuedJob("ENVIRONMENT_APPLY");
      return ok({ environment, job }, 201);
    })
    .on(
      "PATCH",
      "/projects/:id/environments/:envId",
      (req, [id = "", envId = ""]) => {
        const p = projectOf(db, id);
        const env = envOf(p, envId);
        const body =
          bodyOf<
            Partial<Pick<PublicEnvironmentWire, "autoDeploy" | "isProduction">>
          >(req);
        Object.assign(env, body);
        audit(
          db,
          p,
          "environment.update",
          "Environment",
          env.id,
          null,
          body,
          env.id,
        );
        return ok({ environment: env });
      },
    )
    .on(
      "DELETE",
      "/projects/:id/environments/:envId",
      (_req, [id = "", envId = ""]) => {
        const p = projectOf(db, id);
        envOf(p, envId);
        p.environments = p.environments.filter((e) => e.id !== envId);
        for (const f of p.flags) {
          f.detail.envs = f.detail.envs.filter(
            (e) => e.environment.id !== envId,
          );
        }
        return ok(
          { job: p.cluster === null ? null : queuedJob("ENVIRONMENT_APPLY") },
          p.cluster === null ? 200 : 202,
        );
      },
    )

    // ---------------------------------------------------------- SDK key
    .on(
      "GET",
      "/projects/:id/environments/:envId/keys",
      (_req, [id = "", envId = ""]) => {
        const p = projectOf(db, id);
        envOf(p, envId);
        return ok({ keys: p.sdkKeys[envId] ?? [] });
      },
    )
    .on(
      "POST",
      "/projects/:id/environments/:envId/keys",
      (req, [id = "", envId = ""]) => {
        const p = projectOf(db, id);
        const env = envOf(p, envId);
        const body = bodyOf<{
          keyType: "SERVER" | "CLIENT";
          label: string | null;
        }>(req);
        const secret = randomHex(32);
        const prefix = body.keyType === "SERVER" ? "udp_sk" : "udp_ck";
        const key: SdkKeyWire = {
          id: crypto.randomUUID(),
          environmentId: env.id,
          keyType: body.keyType,
          label: body.label,
          keySuffix: secret.slice(-6),
          maskedKey: `${prefix}_…${secret.slice(-6)}`,
          status: "active",
          createdBy: { id: db.me.id, name: db.me.name },
          createdAt: nowIso(),
          lastUsedAt: null,
          revokedAt: null,
        };
        (p.sdkKeys[env.id] ??= []).unshift(key);
        audit(
          db,
          p,
          "sdk_key.create",
          "SdkKey",
          key.id,
          null,
          { keyType: key.keyType, label: key.label },
          env.id,
        );
        return ok({ key, secretKey: `${prefix}_${env.name}_${secret}` }, 201);
      },
    )
    .on(
      "DELETE",
      "/projects/:id/environments/:envId/keys/:keyId",
      (_req, [id = "", envId = "", keyId = ""]) => {
        const p = projectOf(db, id);
        const key = found(
          p.sdkKeys[envId]?.find((k) => k.id === keyId),
          "khoá SDK",
        );
        key.status = "revoked";
        key.revokedAt = nowIso();
        audit(
          db,
          p,
          "sdk_key.revoke",
          "SdkKey",
          key.id,
          { status: "active" },
          { status: "revoked" },
          envId,
        );
        return ok({ key });
      },
    )

    // ---------------------------------------------------------- cloud
    .on("GET", "/projects/:id/cloud", (_req, [id = ""]) =>
      ok({ cloud: projectOf(db, id).cloud }),
    )
    .on("GET", "/projects/:id/cloud/setup", (req, [id = ""]) => {
      const provider = req.query.get("provider");
      const p = projectOf(db, id);
      const chosen =
        provider === "GCP" || provider === "AZURE" ? provider : "AWS";
      return ok({ setup: setupFor(chosen, p.project.id) });
    })
    .on("PUT", "/projects/:id/cloud", (req, [id = ""]) => {
      const p = projectOf(db, id);
      const body = bodyOf<{
        provider: CloudCredentialWire["provider"];
        mode: CloudCredentialWire["mode"];
        region: string;
        credential?: { authKind?: CloudCredentialWire["authKind"] };
      }>(req);
      const authKind =
        body.credential?.authKind ??
        (
          { AWS: "AWS_ROLE", GCP: "GCP_WIF", AZURE: "AZURE_FEDERATED" } as const
        )[body.provider];
      p.cloud = {
        provider: body.provider,
        mode: body.mode,
        authKind,
        federated:
          authKind.endsWith("ROLE") ||
          authKind.endsWith("WIF") ||
          authKind.endsWith("FEDERATED"),
        region: body.region,
        fingerprint: randomHex(12),
        lastValidatedAt: null,
        createdAt: nowIso(),
        createdBy: { id: db.me.id, email: db.me.email },
      };
      p.preview.provider = body.provider;
      p.preview.region = body.region;
      p.preview.blockers = ["cloud-not-validated"];
      audit(db, p, "cloud.update", "CloudCredential", p.project.id, null, {
        provider: body.provider,
        region: body.region,
      });
      return ok({ cloud: p.cloud });
    })
    .on("POST", "/projects/:id/cloud/validate", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      const at = nowIso();
      if (p.cloud !== null) p.cloud.lastValidatedAt = at;
      p.preview.blockers = p.preview.blockers.filter(
        (b) => b !== "cloud-not-validated",
      );
      return ok({ validation: { valid: true, reason: null, checkedAt: at } });
    })
    .on("POST", "/projects/:id/cloud/preflight", (_req, [id = ""]) => {
      const p = projectOf(db, id);
      return ok({
        preflight: {
          ok: true,
          confidence: "exact",
          missingPermissions: [],
          quotaWarnings:
            p.cloud?.provider === "AWS"
              ? ["EIP: đang dùng 4/5 ở ap-southeast-1"]
              : [],
          docUrl: `https://udp.example/docs/byoc/${(p.cloud?.provider ?? "aws").toLowerCase()}`,
          checkedAt: nowIso(),
        },
      });
    });
}
