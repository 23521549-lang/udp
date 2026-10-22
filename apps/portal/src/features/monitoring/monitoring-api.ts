import { redMetricsResponseWire, type RedRange } from "@udp/shared-types/wire";
import { api } from "../../lib/http";

/** [Plan #53 QĐ-4] Request, lỗi, độ trễ theo thời gian cho từng workload của MỘT env */
export const monitoringApi = {
  red: (projectId: string, envId: string, range: RedRange) =>
    api(redMetricsResponseWire, `/projects/${projectId}/metrics/red`, {
      query: { envId, range },
    }),
};
