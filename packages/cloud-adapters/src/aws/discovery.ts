import {
  ListOpenIDConnectProvidersCommand,
  ListOpenIDConnectProviderTagsCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import { GetResourcesCommand } from "@aws-sdk/client-resource-groups-tagging-api";
import {
  parseIdempotencyKey,
  type CreatedResource,
  type CreatedResourceKind,
} from "@udp/adapter-core";
import type { AwsClients } from "./clients.js";
import { parseArn } from "./arn.js";
import { aws } from "./errors.js";
import { UDP_IAM_PATH } from "./resources/identity.js";
import { tagsFromList } from "./tags.js";

/**
 * Tìm tài nguyên theo tag, ĐỦ mọi trang. Lỗi ở bất kỳ trang nào là ném — một danh sách
 * thiếu trang trông giống hệt "cloud không có gì", và runner sẽ tạo lại (§4.2 v4.10).
 *
 * Hai nguồn: Resource Groups Tagging API (EC2, EKS, ELB — theo region) và IAM (toàn cục,
 * quét trong path `/udp/`).
 */

const IAM_KINDS: readonly CreatedResourceKind[] = ["iam-role", "oidc-provider"];

/** `createdAt` của tài nguyên TÌM THẤY: API tag không trả thời điểm tạo, nên là lúc phát hiện */
const discovered = (
  kind: CreatedResourceKind,
  id: string,
  region: string,
  tags: Record<string, string>,
): CreatedResource => ({
  kind,
  id,
  provider: "aws",
  region,
  createdAt: new Date().toISOString(),
  tags,
  ...(Object.keys(tags).some((k) => k.startsWith("kubernetes.io/cluster/")) &&
  tags["udp.key"] === undefined
    ? { managedByK8s: true }
    : {}),
});

async function fromTaggingApi(
  c: AwsClients,
  region: string,
  key: string,
  value: string,
): Promise<CreatedResource[]> {
  const out: CreatedResource[] = [];
  let token: string | undefined;
  do {
    const page = await aws(() =>
      c.tagging.send(
        new GetResourcesCommand({
          TagFilters: [{ Key: key, Values: [value] }],
          ...(token === undefined ? {} : { PaginationToken: token }),
        }),
      ),
    );
    for (const mapping of page.ResourceTagMappingList ?? []) {
      const parsed =
        mapping.ResourceARN === undefined
          ? null
          : parseArn(mapping.ResourceARN);
      if (parsed === null) continue;
      out.push(
        discovered(
          parsed.kind,
          parsed.id,
          parsed.region === "" ? region : parsed.region,
          tagsFromList(mapping.Tags),
        ),
      );
    }
    token =
      page.PaginationToken === undefined || page.PaginationToken === ""
        ? undefined
        : page.PaginationToken;
  } while (token !== undefined);
  return out;
}

async function iamRoles(
  c: AwsClients,
  key: string,
  value: string,
): Promise<CreatedResource[]> {
  const out: CreatedResource[] = [];
  let marker: string | undefined;
  do {
    const page = await aws(() =>
      c.iam.send(
        new ListRolesCommand({
          PathPrefix: UDP_IAM_PATH,
          ...(marker === undefined ? {} : { Marker: marker }),
        }),
      ),
    );
    for (const role of page.Roles ?? []) {
      const roleName = role.RoleName;
      const arn = role.Arn;
      if (roleName === undefined || arn === undefined) continue;
      const tags = await aws(() =>
        c.iam.send(new ListRoleTagsCommand({ RoleName: roleName })),
      );
      const map = tagsFromList(tags.Tags);
      if (map[key] === value)
        out.push(discovered("iam-role", arn, "global", map));
    }
    marker = page.IsTruncated === true ? page.Marker : undefined;
  } while (marker !== undefined);
  return out;
}

async function oidcProviders(
  c: AwsClients,
  key: string,
  value: string,
): Promise<CreatedResource[]> {
  const list = await aws(() =>
    c.iam.send(new ListOpenIDConnectProvidersCommand({})),
  );
  const out: CreatedResource[] = [];
  for (const provider of list.OpenIDConnectProviderList ?? []) {
    const arn = provider.Arn;
    if (arn === undefined) continue;
    const tags = await aws(() =>
      c.iam.send(
        new ListOpenIDConnectProviderTagsCommand({
          OpenIDConnectProviderArn: arn,
        }),
      ),
    );
    const map = tagsFromList(tags.Tags);
    if (map[key] === value) {
      out.push(discovered("oidc-provider", arn, "global", map));
    }
  }
  return out;
}

/**
 * Tra theo `udp.key` biết trước kind (khoá chứa kind) ⇒ chỉ hỏi đúng một nguồn; tra theo
 * khoá khác (`udp.project`) ⇒ hỏi cả hai.
 */
export async function findAwsByTag(
  c: AwsClients,
  region: string,
  key: string,
  value: string,
): Promise<CreatedResource[]> {
  const kind = key === "udp.key" ? parseIdempotencyKey(value)?.kind : undefined;
  const wantsIam = kind === undefined || IAM_KINDS.includes(kind);
  const wantsRegional = kind === undefined || !IAM_KINDS.includes(kind);
  const found: CreatedResource[] = [];
  if (wantsRegional)
    found.push(...(await fromTaggingApi(c, region, key, value)));
  if (wantsIam && (kind === undefined || kind === "iam-role")) {
    found.push(...(await iamRoles(c, key, value)));
  }
  if (wantsIam && (kind === undefined || kind === "oidc-provider")) {
    found.push(...(await oidcProviders(c, key, value)));
  }
  return found;
}
