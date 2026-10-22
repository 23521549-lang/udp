/**
 * [Plan #61 QĐ-13] `pnpm toolchain:check` — báo image, `pack` và action mà pipeline UDP ghim có bản mới hơn, tag bị
 * đẩy lại hay ghim đã hỏng. Chỉ ĐỌC registry và GitHub (ẩn danh; trong GitHub Actions dùng `GITHUB_TOKEN` cho giới hạn
 * gọi cao hơn), không sửa gì. Thoát 1 khi có việc cần làm — workflow theo lịch tuần đỏ để có người nhìn.
 */
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_TOOLCHAIN } from "../src/build-toolchain.js";
import {
  applyEdits,
  checkoutFinding,
  dockerfileImages,
  GOLDEN_PATH_FROMS,
  imageEdits,
  imageFinding,
  isActionable,
  isFixable,
  newerTags,
  parseImageRef,
  pinnedReleases,
  publishedSha256Of,
  releaseEdits,
  releaseFinding,
  pinnedImages,
  renderReport,
  PORTAL_MOCK_FILE,
  TOOLCHAIN_FILE,
  type Finding,
  type PatchEdit,
  type PinnedRelease,
  type PinnedImage,
} from "../src/toolchain-check.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** `--fix`: soạn phép thay và GHI tệp; vắng cờ ⇒ chỉ đọc, y như trước */
const { values } = parseArgs({ options: { fix: { type: "boolean" } } });

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
      kind: "image",
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

async function checkRelease(release: PinnedRelease): Promise<Finding> {
  const latest = await github<{ tag_name: string }>(
    `/repos/${release.repo}/releases/latest`,
  );
  const sums = await fetchRetry(
    `https://github.com/${release.repo}/releases/download/v${release.version}/${release.checksums}`,
  );
  return releaseFinding(release, {
    latestTag: latest?.tag_name ?? `v${release.version}`,
    publishedSha256: sums.ok
      ? publishedSha256Of(await sums.text(), release.asset)
      : null,
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

/** Số dòng `FROM` ghim digest của mỗi Dockerfile Golden Path — `applyEdits` cần số thật, không đoán */
function goldenPathFromCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of Object.values(GOLDEN_PATH_FROMS)) {
    try {
      out[file] = dockerfileImages(
        readFileSync(resolve(REPO_ROOT, file), "utf8"),
      ).length;
    } catch {
      out[file] = 0;
    }
  }
  return out;
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

/**
 * [Plan #61 61d-3c-2] Giá trị MỚI của một ghim — phần MẠNG lấy, vì phần kiểm không bao giờ hỏi nó.
 *
 * `checkImage` chỉ hỏi digest của tag ĐANG ghim và `checkRelease` chỉ tải tệp checksums của bản ĐANG ghim (cả hai
 * để phát hiện ghim hỏng). Nên `--fix` phải gọi thêm: digest của tag ĐÍCH, và tệp checksums của bản ĐÍCH. Thiếu hai
 * lượt gọi đó thì `--fix` chỉ ghi được *version mới + sha256 cũ* ⇒ `sha256sum -c -` đỏ ⇒ pipeline đóng gói của MỌI
 * project khách hỏng.
 */
async function imageFixEdits(
  pin: PinnedImage,
  finding: Finding,
  fromCounts: Readonly<Record<string, number>>,
): Promise<PatchEdit[]> {
  const ref = parseImageRef(pin.image);
  const tags = await tagsOf(ref.host, ref.repository);
  const patch = newerTags(ref.tag, tags).patch;
  if (patch === null) return [];
  const digest = await digestOf(ref.host, ref.repository, patch);
  if (digest === null) {
    throw new Error(`${pin.source}: không đọc được digest của tag ${patch}`);
  }
  const name = pin.image.slice(0, pin.image.indexOf(":"));
  const dockerfile = GOLDEN_PATH_FROMS[finding.source];
  return imageEdits({
    source: finding.source,
    oldImage: pin.image,
    newImage: `${name}:${patch}@${digest}`,
    /**
     * Đầu thứ BA của cùng bất biến: bản xem thử Portal chép cứng bảng `TEST_IMAGES`, và
     * `pinned-digest-copies.test.ts` canh nó. ĐỌC tệp để biết chuỗi có ở đó, không đoán — lượt `--fix` đầu tiên
     * làm đúng cổng đó đỏ vì thiếu phép thay này.
     */
    inPortalMock: portalMock().includes(pin.image),
    ...(dockerfile === undefined
      ? {}
      : { fromCount: fromCounts[dockerfile] ?? 0 }),
  });
}

/** Nội dung bản xem thử Portal, đọc một lần — nó chép cứng bảng `TEST_IMAGES` (xem `PORTAL_MOCK_FILE`) */
let portalMockCache: string | null = null;
function portalMock(): string {
  portalMockCache ??= (() => {
    try {
      return readFileSync(resolve(REPO_ROOT, PORTAL_MOCK_FILE), "utf8");
    } catch {
      return "";
    }
  })();
  return portalMockCache;
}

async function releaseFixEdits(
  release: PinnedRelease,
  finding: Finding,
): Promise<PatchEdit[]> {
  const latest = await github<{ tag_name: string }>(
    `/repos/${release.repo}/releases/latest`,
  );
  const next = (latest?.tag_name ?? "").replace(/^v/, "");
  if (next === "" || next === release.version) return [];
  /** Tên tệp tải và tệp checksums SUY từ version, nên bản đích có tên khác bản ghim — phải dựng lại cả hai */
  const target: PinnedRelease = {
    ...release,
    version: next,
    asset: release.asset.replaceAll(release.version, next),
    checksums: release.checksums.replaceAll(release.version, next),
  };
  const sums = await fetchRetry(
    `https://github.com/${release.repo}/releases/download/v${next}/${target.checksums}`,
  );
  if (!sums.ok) {
    throw new Error(
      `${release.key}: không tải được checksums của v${next} (HTTP ${String(sums.status)})`,
    );
  }
  const sha256 = publishedSha256Of(await sums.text(), target.asset);
  if (sha256 === null) {
    throw new Error(
      `${release.key}: tệp checksums của v${next} không có dòng cho ${target.asset}`,
    );
  }
  return releaseEdits({
    source: finding.source,
    oldVersion: release.version,
    newVersion: next,
    oldSha256: release.sha256,
    newSha256: sha256,
  });
}

const findings = [
  ...(await Promise.all(pinnedImages(goldenPathImages()).map(checkImage))),
  ...(await Promise.all(pinnedReleases().map(checkRelease))),
  await checkCheckout(),
];
const report = renderReport(findings);
process.stdout.write(report);
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary !== undefined && summary !== "") appendFileSync(summary, report);

if (!values.fix) {
  process.exitCode = findings.some(isActionable) ? 1 : 0;
} else {
  /**
   * Chế độ `--fix`: soạn phép thay cho những ghim **dữ liệu thuần** rồi ghi tệp. Không commit, không push, không mở
   * PR — xem `docs/plans/plan61-plan.md` (61d-3c-2) để biết vì sao đường PR bị bỏ: PR mở bằng `GITHUB_TOKEN` không
   * kích hoạt workflow nào, và `build-smoke` của `ci.yml` bỏ qua `pull_request`, nên PR đó có ZERO phép kiểm máy.
   *
   * Mã thoát ở chế độ này nói về **việc soạn**, không về "còn việc cần làm": thoát 1 lúc có việc sửa sẽ làm bước
   * sau của workflow không chạy, và bước sau chính là bước đính kèm bản `.patch`.
   */
  const images = new Map(
    pinnedImages(goldenPathImages()).map((pin) => [pin.source, pin]),
  );
  const releases = new Map(
    pinnedReleases().map((r) => [`BUILD_TOOLCHAIN.${r.key}`, r]),
  );
  const fromCounts = goldenPathFromCounts();

  const edits: PatchEdit[] = [];
  const refused: string[] = [];
  for (const f of findings) {
    if (!isFixable(f)) {
      /**
       * Finding của Dockerfile Golden Path KHÔNG vào danh sách từ chối: ghim của nó là CÙNG chuỗi với
       * `TEST_IMAGES.<runtime>` và đã được sửa theo cặp. Để nó ở đó thì báo cáo nói sai — "không tự sửa" cho một
       * thứ vừa được sửa.
       */
      const paired = Object.values(GOLDEN_PATH_FROMS).some((d) =>
        d.endsWith(f.source),
      );
      if (isActionable(f) && !paired) {
        refused.push(`${f.source}: ${f.status} — ${f.detail}`);
      }
      continue;
    }
    const image = images.get(f.source);
    const release = releases.get(f.source);
    if (image !== undefined) {
      edits.push(...(await imageFixEdits(image, f, fromCounts)));
    } else if (release !== undefined) {
      edits.push(...(await releaseFixEdits(release, f)));
    }
  }

  const files: Record<string, string> = {};
  for (const e of edits) {
    files[e.file] ??= readFileSync(resolve(REPO_ROOT, e.file), "utf8");
  }
  const patched = applyEdits(files, edits);
  for (const [file, text] of Object.entries(patched)) {
    if (text !== files[file]) writeFileSync(resolve(REPO_ROOT, file), text);
  }

  const lines = [
    "",
    `## \`--fix\`: ${String(edits.length)} phép thay trên ${String(Object.keys(patched).length)} tệp`,
    "",
    ...edits.map((e) => `- \`${e.file}\` × ${String(e.expect)} — ${e.source}`),
    ...(refused.length === 0
      ? []
      : [
          "",
          "**KHÔNG tự sửa** (xem `isFixable` để biết lý do từng nhóm):",
          "",
          ...refused.map((r) => `- ${r}`),
        ]),
    "",
  ].join("\n");
  process.stdout.write(lines);
  if (summary !== undefined && summary !== "") appendFileSync(summary, lines);
  process.exitCode = 0;
}
