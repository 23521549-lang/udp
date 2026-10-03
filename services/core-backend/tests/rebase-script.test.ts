import { BUILD_TOOLCHAIN } from "@udp/config";
import { describe, expect, it } from "vitest";
import { inClusterBuildContainers } from "../src/modules/adapter-base/packaging/build-script.js";
import {
  dockerHostRebaseLines,
  inClusterRebaseContainers,
} from "../src/modules/adapter-base/packaging/rebase-script.js";
import { bashCheck, CLUSTER, HOSTS, PLANS } from "./helpers/build-plans.js";

/**
 * [Plan #61 QĐ-13] Đoạn shell của lượt rebase theo lịch: cú pháp ở mọi ô, không phải Buildpacks thì dừng xanh TRƯỚC khi
 * đăng nhập hay đụng registry, rebase tại chỗ rồi đọc digest mới; trong cluster dùng lại đúng container của lượt build.
 */
const VARS = { image: "registry.acme.vn/web", commit: "$COMMIT" };

describe("rebase-script: cú pháp shell (bash -n) ở mọi ô", () => {
  for (const [name, plan] of Object.entries(PLANS)) {
    if (plan.strategy === "dockerfile") continue;
    for (const ci of HOSTS) {
      it(`máy có Docker · ${ci} · ${name}`, () => {
        const lines = dockerHostRebaseLines(plan, ci, {
          ...VARS,
          tmp: "/tmp/udp-rebase",
        });
        expect(bashCheck(lines.join("\n"))).toBe("");
      });
    }
    for (const ci of CLUSTER) {
      it(`trong cluster · ${ci} · ${name}`, () => {
        for (const c of inClusterRebaseContainers(plan, ci, VARS)) {
          expect(bashCheck(c.script.join("\n")), c.name).toBe("");
        }
      });
    }
  }
});

describe("rebase-script: máy có Docker", () => {
  const lines = dockerHostRebaseLines(PLANS.ghcr!, "github-actions", {
    ...VARS,
    tmp: "/tmp/udp-rebase",
  });
  const at = (needle: string): number =>
    lines.findIndex((l) => l.includes(needle));

  it("không phải Buildpacks ⇒ exit 0 TRƯỚC đăng nhập; rebase tại chỗ có --publish, digest từ report.toml", () => {
    const skip = at("!= buildpacks");
    expect(skip).toBeGreaterThan(-1);
    expect(lines[skip]).toContain("exit 0");
    expect(skip).toBeLessThan(at("docker login"));
    expect(at("docker login")).toBeLessThan(at('pack" rebase'));
    expect(lines[at('pack" rebase')]).toBe(
      '"$UDP_TMP/pack" rebase "registry.acme.vn/web:$COMMIT" --publish --report-output-dir "$UDP_TMP/report"',
    );
    expect(lines.join("\n")).toContain(BUILD_TOOLCHAIN.pack.linuxSha256);
    expect(lines.at(-2)).toBe(
      'UDP_IMAGE_REF="registry.acme.vn/web:$COMMIT@$UDP_DIGEST"',
    );
  });

  it("ghim Buildpacks ⇒ không xét Dockerfile", () => {
    const pinned = dockerHostRebaseLines(PLANS.pinnedBuildpacks!, "circleci", {
      ...VARS,
      tmp: "/tmp/u",
    });
    expect(pinned.join("\n")).not.toContain("[ -f ");
    expect(pinned).toContain("UDP_STRATEGY=buildpacks");
  });
});

describe("rebase-script: trong cluster", () => {
  it("chuẩn bị → đăng nhập → rebaser → digest; container sau chuẩn bị đều có dòng chặn đứng ĐẦU", () => {
    for (const plan of [PLANS.basic!, PLANS.ecr!]) {
      const containers = inClusterRebaseContainers(plan, "tekton", VARS);
      expect(containers[0]?.name).toBe("udp-prepare");
      expect(containers.at(-2)?.name).toBe("udp-rebase");
      expect(containers.at(-1)?.name).toBe("udp-digest");
      for (const c of containers.slice(1)) {
        expect(c.script[0], c.name).toBe(
          '[ "$(cat /udp/strategy)" = buildpacks ] || exit 0',
        );
      }
    }
  });

  it("rebaser hạ quyền xuống UID của builder, ghi report vào /udp/out; digest chỉ ghi image-ref khi đã rebase", () => {
    const containers = inClusterRebaseContainers(PLANS.basic!, "drone", VARS);
    const rebase = containers.find((c) => c.name === "udp-rebase")!;
    const user = BUILD_TOOLCHAIN.builderUser;
    expect(rebase.image).toBe(BUILD_TOOLCHAIN.images.builder);
    expect(rebase.script.at(-1)).toBe(
      `/cnb/lifecycle/rebaser -uid=${String(user.uid)} -gid=${String(user.gid)} -report=/udp/out/report.toml "registry.acme.vn/web:$COMMIT"`,
    );
    const digest = containers.find((c) => c.name === "udp-digest")!;
    expect(digest.script.join("\n")).toContain(
      'echo "registry.acme.vn/web:$COMMIT@$UDP_DIGEST" > /udp/out/image-ref',
    );
  });

  it("mọi container của lượt rebase có một container CÙNG image, biến và quyền trong pod build (Jenkins dùng lại)", () => {
    for (const plan of [PLANS.basic!, PLANS.ecr!, PLANS.gcp!, PLANS.acr!]) {
      const pod = inClusterBuildContainers(plan, "jenkins", VARS);
      for (const c of inClusterRebaseContainers(plan, "jenkins", VARS)) {
        expect(
          pod.some(
            (p) =>
              p.image === c.image &&
              p.runAsUser === c.runAsUser &&
              p.unconfined === c.unconfined &&
              JSON.stringify(p.env) === JSON.stringify(c.env),
          ),
          c.name,
        ).toBe(true);
      }
    }
  });

  it("không backslash trong mọi kịch bản (an toàn cho sh ''' của Groovy)", () => {
    for (const plan of Object.values(PLANS)) {
      if (plan.strategy === "dockerfile") continue;
      const texts = [
        ...HOSTS.map((ci) =>
          dockerHostRebaseLines(plan, ci, { ...VARS, tmp: "/tmp/u" }).join(
            "\n",
          ),
        ),
        ...CLUSTER.flatMap((ci) =>
          inClusterRebaseContainers(plan, ci, VARS).map((c) =>
            c.script.join("\n"),
          ),
        ),
      ];
      for (const text of texts) expect(text).not.toContain("\\");
    }
  });
});
