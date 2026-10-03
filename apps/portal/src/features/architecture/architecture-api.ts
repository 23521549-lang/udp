import { architectureResponseWire } from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/** [Plan #53 QĐ-3] Sơ đồ kiến trúc của project — và nguồn của lưới sức khoẻ domain ở Tổng quan */
export const architectureApi = {
  get: (projectId: string) =>
    api(architectureResponseWire, `/projects/${projectId}/architecture`),
};
