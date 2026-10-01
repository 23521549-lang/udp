import type { BuildSettings } from "@udp/shared-types/build";
import {
  buildViewWire,
  goldenPathResponseWire,
  repoScanResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

const p = (projectId: string) => `/projects/${projectId}`;

/** [Plan #48] Golden Path (§11.1) và quét repo của Import Existing (§11.2) */
export const codeApi = {
  goldenPath: (projectId: string) =>
    api(goldenPathResponseWire, `${p(projectId)}/golden-path`),
  lastScan: (projectId: string) =>
    api(repoScanResponseWire, `${p(projectId)}/repo-scan`),
  /** `token` chỉ đi trong lượt quét này — Service 1 không lưu nó */
  scan: (projectId: string, token: string | undefined) =>
    api(repoScanResponseWire, `${p(projectId)}/repo-scan`, {
      method: "POST",
      body: token === undefined ? {} : { token },
    }),
  /** [Plan #61] Mục Đóng gói: cách UDP build image, việc cần làm, script danh tính build */
  build: (projectId: string) => api(buildViewWire, `${p(projectId)}/build`),
  saveBuild: (projectId: string, settings: BuildSettings) =>
    api(buildViewWire, `${p(projectId)}/build`, {
      method: "PUT",
      body: settings,
    }),
};
