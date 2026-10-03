import {
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from "@udp/http";
import { describe, expect, it } from "vitest";
import { REPO_SCAN } from "@udp/config";
import {
  createRepoSourceFactory,
  parseRepoUrl,
} from "../src/modules/golden-path/repo-source.js";

/**
 * Nguồn repo GitHub/GitLab (Plan #48 QĐ-5) trên `fetch` giả: địa chỉ gọi đi dựng từ host CỐ ĐỊNH,
 * token đi đúng header, trần cây và trần tệp, ánh xạ lỗi. Không mạng thật.
 */

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(route: (url: string) => Response | undefined): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(
      route(url) ?? new Response("không có", { status: 404 }),
    );
  };
  return { fetch: impl, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

describe("parseRepoUrl", () => {
  it("GitHub owner/repo (bỏ .git và / cuối), GitLab nhiều cấp nhóm", () => {
    expect(parseRepoUrl("https://github.com/acme/web.git")).toEqual({
      host: "github",
      path: "acme/web",
    });
    expect(parseRepoUrl("https://github.com/acme/web/")).toEqual({
      host: "github",
      path: "acme/web",
    });
    expect(parseRepoUrl("https://gitlab.com/acme/platform/web")).toEqual({
      host: "gitlab",
      path: "acme/platform/web",
    });
  });

  it("host khác, http, thiếu đoạn, đoạn lạ ⇒ 422", () => {
    for (const bad of [
      "https://bitbucket.org/acme/web",
      "http://github.com/acme/web",
      "https://github.com/acme",
      "https://github.com/acme/web/tree/main",
      "https://github.com/acme/w%20eb",
      "không phải url",
    ]) {
      expect(() => parseRepoUrl(bad), bad).toThrow(UnprocessableError);
    }
  });
});

describe("nguồn GitHub", () => {
  it("cây một lời gọi tới api.github.com, tệp thô từ raw.githubusercontent.com, token là Bearer", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.startsWith("https://api.github.com/repos/acme/web/git/trees/HEAD")
        ? json({
            tree: [
              { path: "src", type: "tree" },
              { path: "src/app.ts", type: "blob" },
              { path: "a b.txt", type: "blob" },
            ],
            truncated: false,
          })
        : url === "https://raw.githubusercontent.com/acme/web/HEAD/a%20b.txt"
          ? new Response("nội dung")
          : undefined,
    );
    const { host, source } = createRepoSourceFactory(fetch)(
      "https://github.com/acme/web",
      "tok",
    );
    expect(host).toBe("github");
    expect(await source.list()).toEqual(["src/app.ts", "a b.txt"]);
    expect(await source.read("a b.txt")).toBe("nội dung");
    expect(await source.read("khong-co")).toBeUndefined();
    expect(source.truncated).toBe(false);
    expect(
      calls.every((c) => c.headers["Authorization"] === "Bearer tok"),
    ).toBe(true);
  });

  it("GitHub báo cắt cây ⇒ truncated; tệp lớn hơn trần ⇒ không đọc", async () => {
    const big = "x".repeat(REPO_SCAN.maxFileBytes + 1);
    const { fetch } = fakeFetch((url) =>
      url.includes("/git/trees/")
        ? json({ tree: [{ path: "a", type: "blob" }], truncated: true })
        : new Response(big),
    );
    const { source } = createRepoSourceFactory(fetch)(
      "https://github.com/acme/web",
      undefined,
    );
    await source.list();
    expect(source.truncated).toBe(true);
    expect(await source.read("a")).toBeUndefined();
  });

  it("404 ⇒ NotFound (có thể cần token); 401 ⇒ 422; 403 ⇒ 503 (hết lượt); mạng hỏng ⇒ 503", async () => {
    const at = (status: number) =>
      createRepoSourceFactory(
        fakeFetch(() => new Response("", { status })).fetch,
      )("https://github.com/a/b", undefined).source;
    await expect(at(404).list()).rejects.toBeInstanceOf(NotFoundError);
    await expect(at(401).list()).rejects.toBeInstanceOf(UnprocessableError);
    await expect(at(403).list()).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    const offline = createRepoSourceFactory(() =>
      Promise.reject(new Error("mạng")),
    )("https://github.com/a/b", undefined).source;
    await expect(offline.list()).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });
});

describe("nguồn GitLab", () => {
  it("nhánh mặc định, phân trang theo x-next-page, PRIVATE-TOKEN, tệp thô theo nhánh", async () => {
    const project = "https://gitlab.com/api/v4/projects/acme%2Fplatform%2Fweb";
    const { fetch, calls } = fakeFetch((url) => {
      if (url === project) return json({ default_branch: "main" });
      if (
        url.startsWith(`${project}/repository/tree`) &&
        url.includes("page=1&")
      )
        return json([{ path: "package.json", type: "blob" }], {
          "x-next-page": "2",
        });
      if (
        url.startsWith(`${project}/repository/tree`) &&
        url.includes("page=2&")
      )
        return json(
          [
            { path: "src/app.ts", type: "blob" },
            { path: "src", type: "tree" },
          ],
          { "x-next-page": "" },
        );
      if (url === `${project}/repository/files/src%2Fapp.ts/raw?ref=main`)
        return new Response("mã");
      return undefined;
    });
    const { host, source } = createRepoSourceFactory(fetch)(
      "https://gitlab.com/acme/platform/web",
      "glpat",
    );
    expect(host).toBe("gitlab");
    expect(await source.list()).toEqual(["package.json", "src/app.ts"]);
    expect(await source.read("src/app.ts")).toBe("mã");
    expect(calls.every((c) => c.headers["PRIVATE-TOKEN"] === "glpat")).toBe(
      true,
    );
    expect(
      calls
        .filter((c) => c.url.includes("/repository/tree"))
        .every((c) => c.url.includes("ref=main")),
    ).toBe(true);
  });
});
