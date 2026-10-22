import { REPO_SCAN } from "@udp/config";
import type { RepoSource } from "@udp/golden-path";
import {
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from "@udp/http";

/**
 * Nguồn repo cho bộ quét Import Existing (§11.2, Plan #48 QĐ-5) — API CÔNG KHAI của GitHub và GitLab,
 * chi phí 0. Địa chỉ gọi đi do UDP dựng từ host CỐ ĐỊNH (`api.github.com`, `gitlab.com`), không bao
 * giờ từ host người dùng gõ — `repoUrl` chỉ góp phần đường dẫn đã kiểm, nên không có đường SSRF.
 *
 * Token (repo riêng tư) chỉ sống trong lượt quét: không log, không lưu, không vào kết quả.
 */

export type RepoHost = "github" | "gitlab";

export interface RepoRef {
  host: RepoHost;
  /** `owner/repo` (GitHub) hoặc `group/…/project` (GitLab) */
  path: string;
}

export type RepoSourceFactory = (
  repoUrl: string,
  token: string | undefined,
) => { host: RepoHost; source: RepoSource };

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** `https://github.com/acme/web(.git)` ⇒ `{github, acme/web}`; host khác ⇒ 422 nói rõ vì sao */
export function parseRepoUrl(repoUrl: string): RepoRef {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new UnprocessableError("URL kho mã không hợp lệ");
  }
  const segments = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((s) => s !== "");
  const valid =
    url.protocol === "https:" &&
    segments.length >= 2 &&
    segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
  if (valid && url.hostname === "github.com" && segments.length === 2) {
    return { host: "github", path: segments.join("/") };
  }
  if (valid && url.hostname === "gitlab.com") {
    return { host: "gitlab", path: segments.join("/") };
  }
  throw new UnprocessableError(
    "Chỉ quét được repo https trên github.com hoặc gitlab.com: với nơi khác, tự kiểm theo danh sách đề xuất của Golden Path",
  );
}

const encodePath = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

async function call(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  what: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(REPO_SCAN.requestTimeoutMs),
    });
  } catch {
    throw new ServiceUnavailableError(
      `Không kết nối được ${what}: thử lại sau`,
    );
  }
  if (res.ok) return res;
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 404) {
    throw new NotFoundError(
      "Không thấy repo: sai địa chỉ, hoặc repo riêng tư (cần token có quyền đọc)",
    );
  }
  if (res.status === 401) {
    throw new UnprocessableError(`${what} từ chối token`);
  }
  if (res.status === 403 || res.status === 429) {
    throw new ServiceUnavailableError(
      `${what} giới hạn lượt gọi (không token: 60/giờ với GitHub): thử lại sau hoặc dùng token`,
    );
  }
  throw new ServiceUnavailableError(`${what} trả lỗi ${String(res.status)}`);
}

/** Thân UTF-8 tối đa `maxFileBytes`; lớn hơn ⇒ `undefined` (bộ quét coi như không đọc được) */
async function boundedText(res: Response): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > REPO_SCAN.maxFileBytes || res.body === null) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > REPO_SCAN.maxFileBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Đọc một tệp: lỗi mạng hay 4xx của MỘT tệp không làm hỏng cả lượt quét — tệp đó coi như vắng */
async function readFile(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(REPO_SCAN.requestTimeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return await boundedText(res);
  } catch {
    return undefined;
  }
}

function githubSource(
  fetchImpl: typeof fetch,
  path: string,
  token: string | undefined,
): RepoSource {
  const auth: Record<string, string> =
    token === undefined ? {} : { Authorization: `Bearer ${token}` };
  let truncated = false;
  return {
    get truncated() {
      return truncated;
    },
    async list() {
      const res = await call(
        fetchImpl,
        `https://api.github.com/repos/${path}/git/trees/HEAD?recursive=1`,
        {
          Accept: "application/vnd.github+json",
          "User-Agent": "udp-repo-scan",
          "X-GitHub-Api-Version": "2022-11-28",
          ...auth,
        },
        "GitHub",
      );
      const body = (await res.json()) as {
        tree?: { path?: unknown; type?: unknown }[];
        truncated?: unknown;
      };
      const blobs = (body.tree ?? [])
        .filter((e) => e.type === "blob" && typeof e.path === "string")
        .map((e) => e.path as string);
      truncated =
        body.truncated === true || blobs.length > REPO_SCAN.maxTreeEntries;
      return blobs.slice(0, REPO_SCAN.maxTreeEntries);
    },
    read: (file) =>
      readFile(
        fetchImpl,
        `https://raw.githubusercontent.com/${path}/HEAD/${encodePath(file)}`,
        { "User-Agent": "udp-repo-scan", ...auth },
      ),
  };
}

function gitlabSource(
  fetchImpl: typeof fetch,
  path: string,
  token: string | undefined,
): RepoSource {
  const base = `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`;
  const headers: Record<string, string> =
    token === undefined ? {} : { "PRIVATE-TOKEN": token };
  let branch: string | undefined;
  let truncated = false;

  const defaultBranch = async (): Promise<string> => {
    if (branch === undefined) {
      const res = await call(fetchImpl, base, headers, "GitLab");
      const project = (await res.json()) as { default_branch?: unknown };
      branch =
        typeof project.default_branch === "string"
          ? project.default_branch
          : "HEAD";
    }
    return branch;
  };

  return {
    get truncated() {
      return truncated;
    },
    async list() {
      const ref = encodeURIComponent(await defaultBranch());
      const blobs: string[] = [];
      for (let page = 1; ; page += 1) {
        const res = await call(
          fetchImpl,
          `${base}/repository/tree?recursive=true&per_page=${String(REPO_SCAN.gitlabPageSize)}&page=${String(page)}&ref=${ref}`,
          headers,
          "GitLab",
        );
        const entries = (await res.json()) as {
          path?: unknown;
          type?: unknown;
        }[];
        for (const e of entries) {
          if (e.type === "blob" && typeof e.path === "string")
            blobs.push(e.path);
        }
        const next = res.headers.get("x-next-page") ?? "";
        if (next === "") break;
        if (blobs.length >= REPO_SCAN.maxTreeEntries) {
          truncated = true;
          break;
        }
      }
      truncated ||= blobs.length > REPO_SCAN.maxTreeEntries;
      return blobs.slice(0, REPO_SCAN.maxTreeEntries);
    },
    async read(file) {
      const ref = encodeURIComponent(await defaultBranch());
      return readFile(
        fetchImpl,
        `${base}/repository/files/${encodeURIComponent(file)}/raw?ref=${ref}`,
        headers,
      );
    },
  };
}

/** Nguồn thật trên `fetch` — `AppDeps.repoSource` mặc định; test tiêm nguồn trong bộ nhớ */
export function createRepoSourceFactory(
  fetchImpl: typeof fetch = fetch,
): RepoSourceFactory {
  return (repoUrl, token) => {
    const ref = parseRepoUrl(repoUrl);
    return {
      host: ref.host,
      source:
        ref.host === "github"
          ? githubSource(fetchImpl, ref.path, token)
          : gitlabSource(fetchImpl, ref.path, token),
    };
  };
}
