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
export type FindingStatus = "ok" | "newer-line" | "update" | "moved" | "broken";

export interface Finding {
  source: string;
  subject: string;
  status: FindingStatus;
  detail: string;
}

export const isActionable = (f: Finding): boolean =>
  f.status === "update" || f.status === "moved" || f.status === "broken";

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

/** `pack`: bản phát hành mới nhất và sha256 công bố của bản đang ghim */
export function packFinding(observed: {
  latestTag: string;
  publishedSha256: string | null;
}): Finding {
  const pack = BUILD_TOOLCHAIN.pack;
  const base = {
    source: "BUILD_TOOLCHAIN.pack",
    subject: `pack v${pack.version}`,
  };
  if (observed.publishedSha256 !== pack.linuxSha256) {
    return {
      ...base,
      status: "broken",
      detail: `sha256 công bố khác bản ghim: ${observed.publishedSha256 ?? "không đọc được"}`,
    };
  }
  return versionFinding(base, releaseNewer(pack.version, observed.latestTag));
}

/** `actions/checkout`: SHA ghim phải đúng commit của tag ghim; báo bản phát hành mới hơn */
export function checkoutFinding(observed: {
  latestTag: string;
  tagCommit: string | null;
}): Finding {
  const checkout = BUILD_TOOLCHAIN.actions.checkout;
  const base = {
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
  moved: "tag đẩy lại",
  update: "có bản vá",
  "newer-line": "có dòng mới",
  ok: "ổn",
};

const ORDER: FindingStatus[] = [
  "broken",
  "moved",
  "update",
  "newer-line",
  "ok",
];

/** Bảng Markdown — việc cần làm lên trước; cũng là nội dung tóm tắt của lượt chạy CI */
export function renderReport(findings: readonly Finding[]): string {
  const sorted = [...findings].sort(
    (a, b) =>
      ORDER.indexOf(a.status) - ORDER.indexOf(b.status) ||
      a.source.localeCompare(b.source),
  );
  const pending = sorted.filter(isActionable).length;
  const cell = (text: string) => text.replace(/\|/g, "/");
  return [
    "## Kiểm phiên bản công cụ build (toolchain:check)",
    "",
    pending === 0
      ? `Không có việc cần làm trong ${String(findings.length)} mục (dòng mới hơn, nếu có, là quyết định nâng cấp riêng).`
      : `${String(pending)}/${String(findings.length)} mục cần làm: bản vá, tag bị đẩy lại hay ghim hỏng. Sửa ở \`packages/config/src/build-toolchain.ts\` (đủ tag và digest) hay \`FROM\` của Dockerfile Golden Path, rồi chạy lại test.`,
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

/** `FROM <image>` của một Dockerfile ⇒ các image (bỏ tham chiếu tới tầng trước như `FROM build`) */
export function dockerfileImages(text: string): string[] {
  return [...text.matchAll(/^FROM\s+(\S+)/gim)]
    .map((m) => m[1] ?? "")
    .filter((image) => image.includes("@sha256:"));
}
