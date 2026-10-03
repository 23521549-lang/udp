import {
  BUILD_TOOLCHAIN,
  STEP_IMAGES,
  stepImage,
  TEST_IMAGES,
  type StepImageTool,
} from "./build-toolchain.js";

/**
 * [Plan #61 QĐ-13] Phần thuần của `toolchain:check`: gom mọi image ghim, tách tag thành phiên bản, tìm bản mới hơn,
 * dựng báo cáo. Phần mạng (registry, GitHub) ở `scripts/toolchain-check.ts` — ở đây không có I/O nên test được.
 */

export interface PinnedImage {
  /** Ai dùng image này — hiện ở báo cáo */
  source: string;
  /** `name:tag@sha256:…` */
  image: string;
}

/** Mọi image ghim của `@udp/config`; `extra` là `FROM` của Dockerfile Golden Path (script đọc tệp) */
export function pinnedImages(
  extra: readonly PinnedImage[] = [],
): PinnedImage[] {
  // Chỉ bản mặc định: bản cũ ở lại trong bảng để project đã lưu nó không bị nâng, không phải để theo dõi
  const steps = (Object.keys(STEP_IMAGES) as StepImageTool[]).map((tool) => ({
    source: `STEP_IMAGES.${tool}`,
    image: stepImage(tool, STEP_IMAGES[tool].latest),
  }));
  return [
    ...Object.entries(BUILD_TOOLCHAIN.images).map(([key, image]) => ({
      source: `BUILD_TOOLCHAIN.images.${key}`,
      image,
    })),
    ...Object.entries(TEST_IMAGES).map(([key, image]) => ({
      source: `TEST_IMAGES.${key}`,
      image,
    })),
    ...steps,
    ...extra,
  ];
}

export interface ImageRef {
  /** Máy chủ registry thật (`registry-1.docker.io` cho Docker Hub) */
  host: string;
  /** Đường repository trên máy chủ đó (`library/alpine` cho image chính thức) */
  repository: string;
  tag: string;
  digest: string;
}

/** `name:tag@sha256:…` ⇒ các phần; tên không có máy chủ là Docker Hub */
export function parseImageRef(image: string): ImageRef {
  const at = image.indexOf("@");
  if (at < 0) throw new Error(`image không ghim digest: ${image}`);
  const digest = image.slice(at + 1);
  const named = image.slice(0, at);
  const colon = named.lastIndexOf(":");
  if (colon < 0 || colon < named.lastIndexOf("/")) {
    throw new Error(`image thiếu tag phiên bản: ${image}`);
  }
  const name = named.slice(0, colon);
  const tag = named.slice(colon + 1);
  const first = name.split("/")[0] ?? name;
  const hasHost = name.includes("/") && /[.:]/.test(first);
  if (hasHost) {
    return {
      host: first,
      repository: name.slice(first.length + 1),
      tag,
      digest,
    };
  }
  return {
    host: "registry-1.docker.io",
    repository: name.includes("/") ? name : `library/${name}`,
    tag,
    digest,
  };
}

export interface VersionTag {
  prefix: "v" | "";
  numbers: number[];
  /** Phần sau phiên bản, gồm cả dấu `-` (`-alpine`, `-rootless`) */
  suffix: string;
}

const VERSION_TAG = /^(v?)(\d+(?:\.\d+)*)(-[A-Za-z0-9._-]+)?$/;

/** Tag ⇒ phiên bản số + hậu tố; `null` với tag không theo phiên bản (`latest`, `stable`) */
export function parseVersionTag(tag: string): VersionTag | null {
  const m = VERSION_TAG.exec(tag);
  if (m === null) return null;
  return {
    prefix: m[1] === "v" ? "v" : "",
    numbers: (m[2] ?? "").split(".").map(Number),
    suffix: m[3] ?? "",
  };
}

export function compareVersions(
  a: readonly number[],
  b: readonly number[],
): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Cùng dòng phát hành: mọi thành phần trừ cái cuối giống nhau — khác nhau chỉ ở bản vá */
function samePatchLine(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.slice(0, -1).every((n, i) => n === b[i]);
}

export interface NewerTags {
  /** Bản vá mới nhất cùng dòng — nâng an toàn, là việc cần làm */
  patch: string | null;
  /** Bản mới nhất ở dòng mới hơn — nâng là một quyết định riêng (Node 22 ⇒ 26), chỉ để biết */
  newerLine: string | null;
}

/** Tag mới hơn `current` cùng tiền tố, cùng hậu tố, cùng số thành phần (bỏ qua bản dựng đêm, rc…) */
export function newerTags(current: string, tags: readonly string[]): NewerTags {
  const base = parseVersionTag(current);
  if (base === null) return { patch: null, newerLine: null };
  const candidates = tags
    .map((tag) => ({ tag, v: parseVersionTag(tag) }))
    .filter(
      (c): c is { tag: string; v: VersionTag } =>
        c.v !== null &&
        c.v.prefix === base.prefix &&
        c.v.suffix === base.suffix &&
        c.v.numbers.length === base.numbers.length &&
        compareVersions(c.v.numbers, base.numbers) > 0,
    )
    .sort((x, y) => compareVersions(y.v.numbers, x.v.numbers));
  const patch =
    candidates.find((c) => samePatchLine(c.v.numbers, base.numbers))?.tag ??
    null;
  const top = candidates[0];
  const newerLine =
    top === undefined || samePatchLine(top.v.numbers, base.numbers)
      ? null
      : top.tag;
  return { patch, newerLine };
}

/**
 * `update`, `moved`, `broken` là việc cần làm (workflow tuần đỏ); `newer-line` chỉ để biết — báo dòng mới mỗi tuần
 * như một lỗi thì job đỏ vĩnh viễn và không ai nhìn nữa.
 */
export type FindingStatus =
  | "ok"
  | "newer-line"
  | "update"
  | "moved"
  | "broken"
  /**
   * [Plan #61 61d-3c] Ba trạng thái của ghim CHART, và chúng tồn tại vì `newerTags` không trả lời được câu hỏi của
   * chúng.
   *
   *  - `shape`: không bản nào trong `index.yaml` cùng **hình dạng** với ghim (tiền tố `v`, hậu tố, số thành phần).
   *    `newerTags` trả `{null, null}` ở HAI ca khác nhau — "đã là bản mới nhất" và "không có bản nào cùng hình
   *    dạng" — và `versionFinding` gộp cả hai thành `ok`. Đó là cách ghim `raw 0.3.2` im lặng xanh trong khi repo
   *    phát hành `v0.3.2` và `helm` không tải được gì.
   *  - `repo-gone`: địa chỉ repo không trả về một `index.yaml` đọc được. Hai repo của sản phẩm đã 404 toàn site.
   *  - `unwatched`: `oci://`, `gs://`, hay `installer: "manifest-bundle"` — không có `index.yaml` để canh. Có tên
   *    riêng để nó KHÔNG rơi vào `broken` giả.
   */
  | "shape"
  | "repo-gone"
  | "unwatched"
  /**
   * Ghim hỏng NẰM TRONG `KNOWN_BROKEN_CHARTS` — hiện trong bảng kèm lý do, nhưng không làm job đỏ. Một đường cơ sở
   * có tên để cổng mới không đỏ ngay ngày đầu vì những lỗi có TRƯỚC nó; mục mới hỏng thì vẫn đỏ.
   */
  | "known-broken"
  /**
   * Bản vá của một chart. KHÔNG actionable, và đó là một quyết định đo được: toàn bộ ghim chart của sản phẩm cho
   * 27–29 mục `update` ngay lượt chạy đầu, mỗi mục đòi một lượt nâng cấp §8.6 đầy đủ (bump `adapter_version` +
   * `upgradesFrom` mang định nghĩa cũ), và 52 repo upstream tái sinh hàng đợi liên tục. Để nó làm job đỏ là dựng
   * đúng cái mà chú thích của `versionFinding` dưới đây đã cấm — một cổng đỏ vĩnh viễn không ai nhìn, và nó chôn
   * luôn tín hiệu của ghim image.
   */
  | "chart-update";

/** Loại ghim — `isFixable` lọc theo đây và theo `source`, không theo hình dạng chuỗi */
export type FindingKind = "image" | "release" | "action" | "chart";

export interface Finding {
  kind: FindingKind;
  source: string;
  subject: string;
  status: FindingStatus;
  detail: string;
}

/**
 * Việc cần làm trong TUẦN này — thứ làm job đỏ.
 *
 * `chart-update` và `newer-line` không nằm đây: cả hai là "có bản mới hơn", một việc cần một quyết định nâng cấp
 * riêng chứ không phải một việc dọn trong tuần. `shape`, `repo-gone` và `broken` thì khác hẳn: chúng nghĩa là ghim
 * **không cài được**, tức một domain không deploy nổi — và chúng xuất hiện không báo trước khi upstream xoá một bản
 * hay chuyển repo.
 */
export const isActionable = (f: Finding): boolean =>
  f.status === "update" ||
  f.status === "moved" ||
  f.status === "broken" ||
  f.status === "shape" ||
  f.status === "repo-gone";

/** Bản vá ⇒ `update`; chỉ có dòng mới ⇒ `newer-line`; không có gì ⇒ `ok` */
function versionFinding(
  base: Omit<Finding, "status" | "detail">,
  newer: NewerTags,
): Finding {
  const notes = [
    ...(newer.patch === null ? [] : [`bản vá: ${newer.patch}`]),
    ...(newer.newerLine === null ? [] : [`dòng mới hơn: ${newer.newerLine}`]),
  ];
  const status: FindingStatus =
    newer.patch !== null
      ? "update"
      : newer.newerLine !== null
        ? "newer-line"
        : "ok";
  return { ...base, status, detail: notes.join("; ") };
}

/** Kết quả của một image: digest của tag hiện nay, digest ghim còn không, các tag của repository */
export function imageFinding(
  pin: PinnedImage,
  observed: {
    tagDigest: string | null;
    pinnedDigestExists: boolean;
    tags: readonly string[];
  },
): Finding {
  const ref = parseImageRef(pin.image);
  const base = {
    kind: "image" as const,
    source: pin.source,
    subject: pin.image.slice(0, pin.image.indexOf("@")),
  };
  if (!observed.pinnedDigestExists) {
    return {
      ...base,
      status: "broken",
      detail: `digest ghim không còn trên registry (${ref.digest.slice(0, 19)}…)`,
    };
  }
  const finding = versionFinding(base, newerTags(ref.tag, observed.tags));
  if (observed.tagDigest !== null && observed.tagDigest !== ref.digest) {
    return {
      ...base,
      status: "moved",
      detail: [
        `tag đã được đẩy lại (thường là bản dựng lại có bản vá): ${observed.tagDigest}`,
        ...(finding.detail === "" ? [] : [finding.detail]),
      ].join("; "),
    };
  }
  return finding;
}

/** Phiên bản phát hành (`v1.2.3`) so với bản ghim — cùng luật bản vá/dòng mới như image */
function releaseNewer(current: string, latestTag: string): NewerTags {
  const tag = (v: string) => `v${v.replace(/^v/, "")}`;
  return newerTags(tag(current), [tag(latestTag)]);
}

/**
 * Công cụ tải bản phát hành rồi kiểm sha256 trong pipeline (`pack`, cosign, oras): repository GitHub, tệp tải và nơi
 * nhà phát hành công bố sha256 của nó
 */
export interface PinnedRelease {
  key: "pack" | "cosign" | "oras";
  repo: string;
  version: string;
  sha256: string;
  /** Tên tệp tải của bản ghim */
  asset: string;
  /** Tệp công bố sha256: riêng cho tệp tải (`.sha256`) hay danh sách chung (`checksums.txt`) */
  checksums: string;
}

export function pinnedReleases(): PinnedRelease[] {
  const { pack, cosign, oras } = BUILD_TOOLCHAIN;
  return [
    {
      key: "pack",
      repo: "buildpacks/pack",
      version: pack.version,
      sha256: pack.linuxSha256,
      asset: `pack-v${pack.version}-linux.tgz`,
      checksums: `pack-v${pack.version}-linux.tgz.sha256`,
    },
    {
      key: "cosign",
      repo: "sigstore/cosign",
      version: cosign.version,
      sha256: cosign.linuxSha256,
      asset: "cosign-linux-amd64",
      checksums: "cosign_checksums.txt",
    },
    {
      key: "oras",
      repo: "oras-project/oras",
      version: oras.version,
      sha256: oras.linuxSha256,
      asset: `oras_${oras.version}_linux_amd64.tar.gz`,
      checksums: `oras_${oras.version}_checksums.txt`,
    },
  ];
}

/** sha256 của `asset` trong nội dung tệp công bố (`<sha256>  <tên tệp>` mỗi dòng, hay một sha256 trần) */
export function publishedSha256Of(text: string, asset: string): string | null {
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha !== undefined && /^[0-9a-f]{64}$/.test(sha)) {
      if (name === undefined || name.replace(/^\*/, "") === asset) return sha;
    }
  }
  return null;
}

/** Công cụ tải bản phát hành: sha256 công bố phải khớp bản ghim; bản vá là việc cần làm, dòng mới chỉ để biết */
export function releaseFinding(
  release: PinnedRelease,
  observed: { latestTag: string; publishedSha256: string | null },
): Finding {
  const base = {
    kind: "release" as const,
    source: `BUILD_TOOLCHAIN.${release.key}`,
    subject: `${release.key} v${release.version}`,
  };
  if (observed.publishedSha256 !== release.sha256) {
    return {
      ...base,
      status: "broken",
      detail: `sha256 công bố khác bản ghim: ${observed.publishedSha256 ?? "không đọc được"}`,
    };
  }
  return versionFinding(
    base,
    releaseNewer(release.version, observed.latestTag),
  );
}

/** `actions/checkout`: SHA ghim phải đúng commit của tag ghim; báo bản phát hành mới hơn */
export function checkoutFinding(observed: {
  latestTag: string;
  tagCommit: string | null;
}): Finding {
  const checkout = BUILD_TOOLCHAIN.actions.checkout;
  const base = {
    kind: "action" as const,
    source: "BUILD_TOOLCHAIN.actions.checkout",
    subject: `${checkout.repo}@${checkout.version}`,
  };
  if (observed.tagCommit !== checkout.sha) {
    return {
      ...base,
      status: "broken",
      detail: `tag ${checkout.version} trỏ tới ${observed.tagCommit ?? "không đọc được"}, không phải SHA ghim ${checkout.sha}`,
    };
  }
  return versionFinding(
    base,
    releaseNewer(checkout.version, observed.latestTag),
  );
}

const STATUS_TEXT: Record<FindingStatus, string> = {
  broken: "HỎNG",
  "repo-gone": "REPO CHẾT",
  shape: "GHIM SAI HÌNH",
  "known-broken": "hỏng (đã biết)",
  moved: "tag đẩy lại",
  update: "có bản vá",
  "chart-update": "chart có bản vá",
  "newer-line": "có dòng mới",
  unwatched: "không canh được",
  ok: "ổn",
};

const ORDER: FindingStatus[] = [
  "broken",
  "repo-gone",
  "shape",
  "known-broken",
  "moved",
  "update",
  "chart-update",
  "newer-line",
  "unwatched",
  "ok",
];

/**
 * Bảng Markdown — việc cần làm lên trước; cũng là nội dung tóm tắt của lượt chạy CI.
 *
 * `opts` để `chart:check` dùng lại ĐÚNG bộ dựng bảng này: hai báo cáo khác nhau mà hai hàm render là hai chỗ để
 * lệch nhau, và cái lệch đầu tiên sẽ là thứ tự ưu tiên trạng thái.
 */
export function renderReport(
  findings: readonly Finding[],
  opts: { title?: string; hint?: string } = {},
): string {
  const sorted = [...findings].sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      a.source.localeCompare(b.source),
  );
  const pending = sorted.filter(isActionable).length;
  const cell = (text: string) => text.replace(/\|/g, "/");
  const hint =
    opts.hint ??
    "Sửa ở `packages/config/src/build-toolchain.ts` (đủ tag và digest) hay `FROM` của Dockerfile Golden Path, rồi chạy lại test.";
  return [
    `## ${opts.title ?? "Kiểm phiên bản công cụ build (toolchain:check)"}`,
    "",
    pending === 0
      ? `Không có việc cần làm trong ${String(findings.length)} mục (dòng mới hơn, nếu có, là quyết định nâng cấp riêng).`
      : `${String(pending)}/${String(findings.length)} mục cần làm. ${hint}`,
    "",
    "| Trạng thái | Mục | Ở đâu | Chi tiết |",
    "| --- | --- | --- | --- |",
    ...sorted.map(
      (f) =>
        `| ${STATUS_TEXT[f.status]} | \`${cell(f.subject)}\` | ${cell(f.source)} | ${cell(f.detail)} |`,
    ),
    "",
  ].join("\n");
}

// --------------------------------------------------------------------- ghim chart Helm (Plan #61 61d-3c)

/** Một ghim chart cần canh, gồm nơi nó được dùng và nó có phải ghim ĐÓNG BĂNG của `upgradesFrom` hay không */
export interface ChartPin {
  name: string;
  version: string;
  repo: string;
  installer?: "manifest-bundle";
  /**
   * Ghim lịch sử trong `upgradesFrom` của một adapter. Với nó chỉ chạy luật **TỒN TẠI**: `restoreTo` của §8.6 là
   * đường duy nhất áp lại chart cũ, và nó chỉ chạy được nếu chart đó còn tải về được — mà repo **có** xoá bản (đo
   * 03/10/2026: `mysql-operator` giữ đúng một bản, `zipkin` đã bỏ `0.3.6`, `tekton-pipeline` đã bỏ `1.1.4`). Nhưng
   * KHÔNG gọi `newerTags` cho nó: báo "3.2.7 có bản vá" mỗi tuần cho một ghim cố ý đóng băng là nhiễu thuần.
   */
  frozen?: boolean;
  /** Adapter dùng ghim này — một chart dùng chung ra MỘT dòng báo cáo, cột này liệt kê nguồn */
  usedBy: readonly string[];
}

/**
 * `index.yaml` của một repo Helm ⇒ danh sách version của MỘT chart; chart không có trong index ⇒ `null`.
 *
 * Parse bằng regex thay vì một YAML parser vì `@udp/config` là package mà cả ba service nạp, và thêm một
 * dependency YAML vào đó cho một phép kiểm chỉ chạy hằng tuần là sai chỗ; thêm nữa một index thật nặng tới 6,17 MB
 * (`prometheus-community`, đo 03/10/2026) nên nạp thành object tốn ~26 MB heap mỗi repo. Hình dạng cần đọc thì cố
 * định: `entries:` ⇒ `  <tên chart>:` ⇒ các mục `    version: <x>` của chart đó, cho tới khoá chart kế tiếp.
 * `null` phân biệt "repo không có chart tên đó" với "chart có nhưng chưa có bản nào".
 *
 * **Đối chiếu với một phép parse YAML thật** (03/10/2026, `js-yaml` trên chính 5 tệp index đã tải): `kyverno`
 * 268/268, `kyverno-policies` 204/204, `spinnaker` 5/5 (index này có version của dependency ở cấp 6 và mục đầu là
 * `  - annotations:` — hai cái bẫy), `sealed-secrets` 88/88, `tekton-pipeline` 55/55, `zipkin` 2/2. Khớp từng phần
 * tử, đúng thứ tự.
 */
export function chartVersionsOf(index: string, chart: string): string[] | null {
  const head = new RegExp(
    `^  ${chart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`,
    "m",
  );
  const at = head.exec(index);
  if (at === null) return null;
  const rest = index.slice(at.index + at[0].length);
  /**
   * Khối của chart này đóng ở khoá CHART kế tiếp (`^  <tên>:`) hay ở một khoá cấp 0 (`generated:`).
   *
   * `(?!-)` là bắt buộc, không phải phòng xa: mục đầu của mỗi bản trong index thật của Kyverno là
   * `  - annotations:`, và dòng đó khớp `^ {2}\S[^\n]*:$` — thiếu `(?!-)` thì khối bị cắt ngay dòng đầu và hàm
   * trả về danh sách RỖNG, tức mọi ghim thành `shape` oan.
   */
  const nextKey = /^(?: {2}(?!-)\S[^\n]*|\S[^\n]*):\s*$/m.exec(rest);
  const body = nextKey === null ? rest : rest.slice(0, nextKey.index);
  /**
   * ĐÚNG bốn khoảng trắng: trường của một bản nằm ở cấp 4 (`    version: 3.9.1`), còn version của **dependency**
   * nằm ở cấp 6 (`      version: 10.5.3` — xem index của opsmx/spinnaker). Một `^\s+version:` lỏng sẽ trộn version
   * của chart phụ thuộc vào danh sách, và cổng sẽ coi một ghim không tồn tại là tồn tại.
   */
  return [...body.matchAll(/^ {4}version:\s*(\S+)\s*$/gm)].map((m) =>
    (m[1] ?? "").replace(/^["']|["']$/g, ""),
  );
}

/** Repo mà không có `index.yaml` để canh: registry OCI, bucket, hay bundle manifest */
export const unwatchableReason = (pin: ChartPin): string | null => {
  if (pin.installer === "manifest-bundle") {
    return "nguồn là bundle manifest, không phải chart Helm";
  }
  if (pin.repo.startsWith("oci://")) {
    return "registry OCI không có index.yaml (cần `helm show chart oci://…`)";
  }
  if (!pin.repo.startsWith("https://") && !pin.repo.startsWith("http://")) {
    return `scheme ${pin.repo.split(":")[0] ?? pin.repo} không phải repo Helm HTTP`;
  }
  return null;
};

/** Có bản nào CÙNG HÌNH DẠNG với ghim: cùng tiền tố `v`, cùng hậu tố, cùng số thành phần */
function sameShape(pin: string, versions: readonly string[]): string[] {
  const base = parseVersionTag(pin);
  if (base === null) return [];
  return versions.filter((v) => {
    const t = parseVersionTag(v);
    return (
      t !== null &&
      t.prefix === base.prefix &&
      t.suffix === base.suffix &&
      t.numbers.length === base.numbers.length
    );
  });
}

/**
 * Phán quyết cho một ghim chart — BA luật, theo thứ tự, rồi mới tới `newerTags`.
 *
 * `newerTags` trả lời "có bản nào mới hơn cùng hình dạng không". Nó **không** trả lời "ghim này có tồn tại không",
 * và nó gộp hai ca khác nhau vào cùng một `{null, null}`. Nên ba luật trước nó không phải trang trí: cả ba đều có
 * một ca THẬT trong sản phẩm trước đợt 61d-3c.
 *
 * `versions === null` nghĩa là repo đọc được nhưng **không có chart tên đó** — cũng là `repo-gone` về hệ quả (không
 * cài được), nhưng `detail` nói đúng nguyên nhân.
 */
export function chartFinding(
  pin: ChartPin,
  observed: { versions: string[] | null; error?: string },
): Finding {
  const base = {
    kind: "chart" as const,
    source: pin.usedBy.join(", "),
    subject: `${pin.name}@${pin.version}${pin.frozen === true ? " (đóng băng)" : ""}`,
  };

  const unwatchable = unwatchableReason(pin);
  if (unwatchable !== null) {
    return { ...base, status: "unwatched", detail: unwatchable };
  }
  if (observed.error !== undefined) {
    return {
      ...base,
      status: "repo-gone",
      detail: `${pin.repo}: ${observed.error}`,
    };
  }
  if (observed.versions === null) {
    return {
      ...base,
      status: "repo-gone",
      detail: `${pin.repo} không có chart tên "${pin.name}"`,
    };
  }
  const shaped = sameShape(pin.version, observed.versions);
  if (shaped.length === 0) {
    return {
      ...base,
      status: "shape",
      detail: `không bản nào cùng hình dạng với "${pin.version}"; repo có: ${observed.versions.slice(0, 4).join(", ")}`,
    };
  }
  if (!observed.versions.includes(pin.version)) {
    return {
      ...base,
      status: "broken",
      detail: `ghim không còn trong index.yaml; cùng dòng: ${shaped.slice(0, 4).join(", ")}`,
    };
  }
  if (pin.frozen === true) {
    return { ...base, status: "ok", detail: "ghim đóng băng còn tải về được" };
  }
  const newer = newerTags(pin.version, observed.versions);
  if (newer.patch === null && newer.newerLine === null) {
    return { ...base, status: "ok", detail: "" };
  }
  return {
    ...base,
    status: newer.patch !== null ? "chart-update" : "newer-line",
    detail: [
      ...(newer.patch === null ? [] : [`bản vá: ${newer.patch}`]),
      ...(newer.newerLine === null ? [] : [`dòng mới hơn: ${newer.newerLine}`]),
    ].join("; "),
  };
}

/**
 * [Plan #61 61d-3c] Ghim ĐÃ hỏng trước khi cổng này tồn tại — một đường cơ sở có tên, không phải một chỗ để quên.
 *
 * Vì sao cần nó: cổng chart tìm ra **tám** ghim không cài được ngay lượt chạy đầu. Năm cái sửa được bằng một phép
 * đổi version (xem `helm-charts.ts`); ba cái còn lại cần đổi `values` của adapter hay đổi nguồn chart, vì chart
 * tồn tại nhưng **khoá mà adapter đặt không tồn tại trong chart** — và Helm bỏ qua khoá nó không biết trong im
 * lặng, nên sửa version mà giữ `values` sai là biến một lỗi ỒN (chart không tải được, job đỏ) thành một lỗi IM
 * LẶNG (chart cài xong, cấu hình không có tác dụng). Đó là thoái cấp, nên ba cái đó là **nợ có tên**, không phải
 * một bản sửa vội.
 *
 * Để một đường cơ sở không mục: hàm này cũng báo **actionable** khi một mục trong danh sách đã HẾT hỏng. Nghĩa là
 * danh sách không thể âm thầm giữ một lời miễn trừ đã hết lý do.
 */
export const KNOWN_BROKEN_CHARTS: Readonly<Record<string, string>> = {
  spinnaker:
    "chart 2.2.7 KHÔNG có khoá `kayenta` nào (values.yaml chỉ có halyard/minio/redis/gcs/s3/azs); " +
    "adapter đặt `kayenta.metricsStore` nên Kayenta sẽ KHÔNG được cấu hình dù chart cài xong — §16",
  "tekton-pipeline":
    "chart 1.15.3 không có `controller.replicas`, và annotation của nó là `controller.pod.annotations`; " +
    "sửa cần đổi `tektonConfigSchema` (một knob cấu hình đã lưu của project) — §16",
  "secrets-store-csi-driver-provider-gcp":
    "chart chưa bao giờ được phát hành lên một repo Helm nào: tài liệu của Google cài từ thư mục `charts/` " +
    "trong git. Cần một nguồn khác (bundle manifest) hay bỏ companion — §16",
};

/**
 * Áp đường cơ sở: mục đã biết hỏng thì KHÔNG làm job đỏ nữa (nhưng vẫn hiện, kèm lý do), còn mục đã hết hỏng thì
 * làm job đỏ để ai đó xoá nó khỏi danh sách.
 *
 * Nhận `known` qua tham số để test được cả hai chiều mà không phụ thuộc trạng thái thật của sản phẩm.
 */
export function applyKnownBroken(
  findings: readonly Finding[],
  known: Readonly<Record<string, string>> = KNOWN_BROKEN_CHARTS,
): Finding[] {
  const nameOf = (f: Finding): string => f.subject.split("@")[0] ?? "";
  return findings.map((f) => {
    if (f.kind !== "chart") return f;
    const reason = known[nameOf(f)];
    if (reason === undefined) return f;
    if (isActionable(f)) {
      return {
        ...f,
        status: "known-broken",
        detail: `${f.detail} — ĐÃ BIẾT: ${reason}`,
      };
    }
    return {
      ...f,
      status: "broken",
      detail: `ghim này đã hết hỏng (${f.status}) — xoá nó khỏi KNOWN_BROKEN_CHARTS`,
    };
  });
}

// --------------------------------------------------------------------- `--fix` (Plan #61 61d-3c-2)

/**
 * Ghim mà `--fix` được sửa — allowlist **DƯƠNG** theo `source`, không theo hình dạng chuỗi.
 *
 * Năm nhóm bị loại, mỗi nhóm một lý do đã kiểm ở nguồn:
 *
 *  - `STEP_IMAGES.*`: **không** là chuỗi `name:tag@sha256:…` (0/16 chuỗi ghim đầy đủ thuộc nó — `stepImage()` lắp
 *    lúc chạy từ `repo`/`tagSuffix`/`version`/`pins`). Sửa nó là một phép **chèn** vào `pins` cộng quyết định đổi
 *    `latest`, mà đổi `latest` là đổi **mặc định cấu hình domain** — chú thích của `STEP_IMAGES` viết ra để chống
 *    đúng điều đó ("project đã lưu nó không bị nâng âm thầm").
 *  - `BUILD_TOOLCHAIN.actions.checkout`: ghim theo **SHA commit**, một loại khác hẳn; bump `version` mà giữ `sha`
 *    làm chú thích nói sai và `checkoutFinding` báo `broken` mãi.
 *  - `BUILD_TOOLCHAIN.cosign`: có một điều kiện **con người phải kiểm** — bản mới phải kéo `sigstore/sigstore`
 *    ≥ v1.10.10 (lỗi Azure KMS sigstore#2409). Nâng tự động có thể KÝ SAI, một lỗi chỉ lộ ở cổng deploy.
 *  - `images.builder`, `images.buildkit`: mỗi cái có ba hằng **vệ tinh** đi thẳng vào pod build (`builderUser`,
 *    `cnbPlatformApi`, `buildkitUser`) mà không cổng nào canh quan hệ ấy. Một bản builder mới đổi lifecycle là
 *    build của mọi khách hỏng, và không test nào đỏ trước khi gộp.
 *  - ghim chart: một bản vá chart là bump `adapter_version` + `upgradesFrom` (§8.6, cổng F3) — có ngữ nghĩa.
 *
 * Và **chỉ** `status === "update"`: `moved` nghĩa là *tag giữ nguyên, digest đổi*, tức có thể là một lần đẩy đè
 * thù địch (sự cố Trivy 03/2026, CVE-2026-33634 — đúng lý do `build-toolchain.ts` ghim theo digest). Một `--fix`
 * theo `isActionable` sẽ **tự động hoá việc chấp nhận** một lần đẩy đè, kèm một PR trông như PR làm mới checksum.
 */
export function isFixable(f: Finding): boolean {
  if (f.status !== "update") return false;
  const excluded = [
    "BUILD_TOOLCHAIN.images.builder",
    "BUILD_TOOLCHAIN.images.buildkit",
    "BUILD_TOOLCHAIN.cosign",
  ];
  if (excluded.includes(f.source)) return false;
  return (
    f.source.startsWith("BUILD_TOOLCHAIN.images.") ||
    f.source.startsWith("TEST_IMAGES.") ||
    f.source === "BUILD_TOOLCHAIN.pack" ||
    f.source === "BUILD_TOOLCHAIN.oras"
  );
}

/**
 * Một phép thay chuỗi, kèm **số lần khớp dự kiến**.
 *
 * Vì sao không phải "đúng một lần": `TEST_IMAGES.nodejs` và `.python` có một bất biến hai đầu —
 * `golden-path-pins.test.ts` khẳng định **mọi** dòng `FROM` của Dockerfile Golden Path bằng đúng
 * `TEST_IMAGES.<runtime>`, và mỗi Dockerfile có **hai** dòng `FROM`. Luật "đúng một lần" sẽ ném ở chính ghim được
 * vá dày nhất; còn sửa một đầu thì cổng kia đỏ. Nên mỗi phép thay tự khai số lần, và `applyEdits` ném khi số thật
 * khác số khai.
 */
export interface PatchEdit {
  file: string;
  from: string;
  to: string;
  expect: number;
  /** Ghim nào sinh phép thay này — hiện trong báo cáo */
  source: string;
}

export const TOOLCHAIN_FILE = "packages/config/src/build-toolchain.ts";

/** Dockerfile Golden Path dùng CÙNG chuỗi ghim với `TEST_IMAGES` — hai đầu của một bất biến, sửa cùng lúc */
export const GOLDEN_PATH_FROMS: Readonly<Record<string, string>> = {
  "TEST_IMAGES.nodejs": "packages/golden-path/templates/node/Dockerfile",
  "TEST_IMAGES.python": "packages/golden-path/templates/python/Dockerfile",
};

/**
 * Đầu thứ BA của cùng bất biến: bản xem thử Portal chép cứng bảng `TEST_IMAGES`.
 *
 * Nó không import được `@udp/config` (gốc package re-export `env`, và kéo một package server-side vào app trình
 * duyệt là đi ngược ranh giới package), nên bản chép là có chủ ý và `pinned-digest-copies.test.ts` canh nó. Hệ quả
 * cho `--fix`: không sửa chỗ này thì chính cổng đó đỏ — đã xảy ra thật ở lượt `--fix` đầu tiên.
 *
 * Mọi ghim của `TEST_IMAGES` đều có mặt ở đó, nên đây là một tệp cho CẢ bảng, không phải một tệp cho mỗi ngôn ngữ.
 */
export const PORTAL_MOCK_FILE = "apps/portal/demo/mock/build.ts";

/**
 * Phép thay cho một ghim image. Hàm THUẦN: nhận chuỗi ghim CŨ đầy đủ và chuỗi MỚI đầy đủ.
 *
 * Nhận chuỗi đầy đủ chứ không suy lại từ `Finding`: `Finding.detail` là văn xuôi cho người đọc, và suy ngược
 * digest cũ từ đó là đúng loại khảo cổ chuỗi đã sinh ra mọi lỗi mà vòng QA tìm thấy. Bên gọi đã có `PinnedImage`
 * trong tay — nó là nguồn.
 *
 * `fromCount` là số dòng `FROM` của Dockerfile tương ứng, do phần mạng ĐẾM từ tệp thật; 0 ⇒ không sinh phép thay
 * cho Dockerfile. Truyền vào thay vì đoán 2, để một Dockerfile ba tầng không làm `applyEdits` ném.
 */
export function imageEdits(args: {
  source: string;
  oldImage: string;
  newImage: string;
  fromCount?: number;
  /** Chuỗi ghim này có mặt trong bản xem thử Portal (phần mạng ĐỌC tệp để biết, không đoán) */
  inPortalMock?: boolean;
}): PatchEdit[] {
  const edits: PatchEdit[] = [
    {
      file: TOOLCHAIN_FILE,
      from: args.oldImage,
      to: args.newImage,
      expect: 1,
      source: args.source,
    },
  ];
  const dockerfile = GOLDEN_PATH_FROMS[args.source];
  const count = args.fromCount ?? 0;
  if (dockerfile !== undefined && count > 0) {
    edits.push({
      file: dockerfile,
      from: args.oldImage,
      to: args.newImage,
      expect: count,
      source: `${args.source} → ${dockerfile}`,
    });
  }
  if (args.source.startsWith("TEST_IMAGES.") && args.inPortalMock === true) {
    edits.push({
      file: PORTAL_MOCK_FILE,
      from: args.oldImage,
      to: args.newImage,
      expect: 1,
      source: `${args.source} → ${PORTAL_MOCK_FILE}`,
    });
  }
  return edits;
}

/** Phép thay cho một bản phát hành (`pack`, `oras`): version và sha256, mỗi cái một chuỗi literal trong bảng */
export function releaseEdits(args: {
  source: string;
  oldVersion: string;
  newVersion: string;
  oldSha256: string;
  newSha256: string;
}): PatchEdit[] {
  return [
    {
      file: TOOLCHAIN_FILE,
      from: `version: "${args.oldVersion}"`,
      to: `version: "${args.newVersion}"`,
      expect: 1,
      source: args.source,
    },
    {
      file: TOOLCHAIN_FILE,
      from: args.oldSha256,
      to: args.newSha256,
      expect: 1,
      source: `${args.source} (sha256)`,
    },
  ];
}

/**
 * Áp một tập phép thay lên nội dung tệp. Ném khi số lần khớp KHÁC số khai — và ném thì **không tệp nào** được ghi,
 * vì hàm trả về một object MỚI và bên gọi chỉ ghi sau khi nó trả về.
 *
 * "Ném chứ không sửa một nửa" là điều kiện để `--fix` an toàn: khớp 0 lần nghĩa là giả định về hình dạng tệp đã
 * sai, và khớp nhiều hơn số khai nghĩa là phép thay đang chạm một ghim khác.
 */
export function applyEdits(
  files: Readonly<Record<string, string>>,
  edits: readonly PatchEdit[],
): Record<string, string> {
  const out: Record<string, string> = { ...files };
  for (const e of edits) {
    const text = out[e.file];
    if (text === undefined) {
      throw new Error(`${e.file}: không có nội dung để sửa (${e.source})`);
    }
    const count = text.split(e.from).length - 1;
    if (count !== e.expect) {
      throw new Error(
        `${e.file}: "${e.from.slice(0, 60)}" khớp ${String(count)} lần, khai ${String(e.expect)} (${e.source})`,
      );
    }
    out[e.file] = text.split(e.from).join(e.to);
  }
  return out;
}

/** `FROM <image>` của một Dockerfile ⇒ các image (bỏ tham chiếu tới tầng trước như `FROM build`) */
export function dockerfileImages(text: string): string[] {
  return [...text.matchAll(/^FROM\s+(\S+)/gim)]
    .map((m) => m[1] ?? "")
    .filter((image) => image.includes("@sha256:"));
}
