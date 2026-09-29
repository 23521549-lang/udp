import { homeResponseWire } from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/** [Plan #53 QĐ-5] Trang chủ: mọi project của người dùng trong MỘT lời gọi */
export const homeApi = {
  get: () => api(homeResponseWire, "/home"),
};
