/**
 * [Plan #61 QĐ-13] `pnpm toolchain:check` — báo image, `pack` và action mà pipeline UDP ghim có bản mới hơn, tag bị
 * đẩy lại hay ghim đã hỏng. Chỉ ĐỌC registry và GitHub (ẩn danh; trong GitHub Actions dùng `GITHUB_TOKEN` cho giới hạn
 * gọi cao hơn), không sửa gì. Thoát 1 khi có việc cần làm — workflow theo lịch tuần đỏ để có người nhìn.
 */
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_TOOLCHAIN } from "../src/build-toolchain.js";
import {
  checkoutFinding,
  dockerfileImages,
  imageFinding,
  isActionable,
  packFinding,
  parseImageRef,
  pinnedImages,
  renderReport,
  type Finding,
  type PinnedImage,
} from "../src/toolchain-check.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** Lỗi mạng thoáng qua và 429/5xx: thử lại ba lần, chờ 1 giây rồi 2 giây — một lần chập chờn không thành "HỎNG" */
async function fetchRetry(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(input, init);
      if ((res.status !== 429 && res.status < 500) || attempt === 3) return res;
    } catch (e) {
      if (attempt === 3) throw e;
    }
    await new Promise((done) => setTimeout(done, attempt * 1000));
  }
}

/** Token ẩn danh theo thách thức `WWW-Authenticate: Bearer realm=…,service=…,scope=…` của registry */
const tokens = new Map<string, string>();

async function registryFetch(
  host: string,
  repository: string,
  path: string,
  init: { method?: string; accept?: string } = {},
): Promise<Response> {
  const url = path.startsWith("/")
    ? `https://${host}${path}`
    : `https://${host}/v2/${repository}/${path}`;
  const headers = (): Record<string, string> => {
    const token = tokens.get(`${host}/${repository}`);
    return {
      ...(init.accept === undefined ? {} : { Accept: init.accept }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    };
  };
  let res = await fetchRetry(url, {
    method: init.method ?? "GET",
    headers: headers(),
  });
  const challenge = res.headers.get("www-authenticate");
  if (res.status === 401 && challenge?.startsWith("Bearer ")) {
    const params = Object.fromEntries(
      [...challenge.slice(7).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const realm = new URL(params.realm ?? "");
    if (params.service !== undefined)
      realm.searchParams.set("service", params.service);
    realm.searchParams.set(
      "scope",
      params.scope ?? `repository:${repository}:pull`,
    );
    const body = (await (await fetchRetry(realm)).json()) as {
      token?: string;
      access_token?: string;
    };
    const token = body.token ?? body.access_token;
    if (token === undefined)
      throw new Error(`${host}: không xin được token đọc ${repository}`);
    tokens.set(`${host}/${repository}`, token);
    res = await fetchRetry(url, {
      method: init.method ?? "GET",
      headers: headers(),
    });
  }
  return res;
}

async function digestOf(
  host: string,
  repository: string,
  reference: string,
): Promise<string | null> {
  const res = await registryFetch(host, repository, `manifests/${reference}`, {
    method: "HEAD",
    accept: MANIFEST_TYPES,
  });
  return res.ok ? res.headers.get("docker-content-digest") : null;
}

/** Nhiều image chung một repository (`docker` cli/dind, `node` của test và của Golden Path): đọc tag một lần */
const tagLists = new Map<string, Promise<string[]>>();

function tagsOf(host: string, repository: string): Promise<string[]> {
  const key = `${host}/${repository}`;
  const known = tagLists.get(key);
  if (known !== undefined) return known;
  const list = listTags(host, repository);
  tagLists.set(key, list);
  return list;
}

async function listTags(host: string, repository: string): Promise<string[]> {
  const tags: string[] = [];
  let path: string | null = "tags/list?n=1000";
  while (path !== null) {
    const res = await registryFetch(host, repository, path);
    if (!res.ok)
      throw new Error(
        `${host}/${repository}: đọc tag hỏng (${String(res.status)})`,
      );
    tags.push(
      ...(((await res.json()) as { tags?: string[] | null }).tags ?? []),
    );
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    path = next?.[1] ?? null;
  }
  return tags;
}

async function checkImage(pin: PinnedImage): Promise<Finding> {
  const ref = parseImageRef(pin.image);
  try {
    const [tagDigest, pinned, tags] = await Promise.all([
      digestOf(ref.host, ref.repository, ref.tag),
      digestOf(ref.host, ref.repository, ref.digest),
      tagsOf(ref.host, ref.repository),
    ]);
    return imageFinding(pin, {
      tagDigest,
      pinnedDigestExists: pinned !== null,
      tags,
    });
  } catch (e) {
    return {
      source: pin.source,
      subject: pin.image.slice(0, pin.image.indexOf("@")),
      status: "broken",
      detail: `không kiểm được: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function github<T>(path: string): Promise<T | null> {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetchRetry(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token === undefined || token === ""
        ? {}
        : { Authorization: `Bearer ${token}` }),
    },
  });
  return res.ok ? ((await res.json()) as T) : null;
}

async function checkPack(): Promise<Finding> {
  const { version } = BUILD_TOOLCHAIN.pack;
  const latest = await github<{ tag_name: string }>(
    "/repos/buildpacks/pack/releases/latest",
  );
  const sums = await fetchRetry(
    `https://github.com/buildpacks/pack/releases/download/v${version}/pack-v${version}-linux.tgz.sha256`,
  );
  const published = sums.ok
    ? ((await sums.text()).trim().split(/\s+/)[0] ?? null)
    : null;
  return packFinding({
    latestTag: latest?.tag_name ?? `v${version}`,
    publishedSha256: published,
  });
}

async function checkCheckout(): Promise<Finding> {
  const { repo, version } = BUILD_TOOLCHAIN.actions.checkout;
  const [latest, commit] = await Promise.all([
    github<{ tag_name: string }>(`/repos/${repo}/releases/latest`),
    github<{ sha: string }>(`/repos/${repo}/commits/${version}`),
  ]);
  return checkoutFinding({
    latestTag: latest?.tag_name ?? version,
    tagCommit: commit?.sha ?? null,
  });
}

/** `FROM` ghim của Dockerfile Golden Path */
function goldenPathImages(): PinnedImage[] {
  const templates = resolve(REPO_ROOT, "packages/golden-path/templates");
  return readdirSync(templates).flatMap((runtime) => {
    const file = resolve(templates, runtime, "Dockerfile");
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    return [...new Set(dockerfileImages(text))].map((image) => ({
      source: `golden-path/templates/${runtime}/Dockerfile`,
      image,
    }));
  });
}

const findings = [
  ...(await Promise.all(pinnedImages(goldenPathImages()).map(checkImage))),
  await checkPack(),
  await checkCheckout(),
];
const report = renderReport(findings);
process.stdout.write(report);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== "") appendFileSync(summary, report);
process.exitCode = findings.some(isActionable) ? 1 : 0;
