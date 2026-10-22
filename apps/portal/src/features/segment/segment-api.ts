import type {
  CreateSegmentFields,
  UpdateSegmentFields,
} from "@udp/shared-types/segment-api";
import {
  segmentListResponseWire,
  segmentResponseWire,
} from "@udp/shared-types/wire";
import { api } from "../../lib/http";

const s = (projectId: string) => `/projects/${projectId}/segments`;

export const segmentApi = {
  list: (projectId: string) => api(segmentListResponseWire, s(projectId)),
  get: (projectId: string, segmentId: string) =>
    api(segmentResponseWire, `${s(projectId)}/${segmentId}`),
  create: (projectId: string, body: CreateSegmentFields) =>
    api(segmentResponseWire, s(projectId), { method: "POST", body }),
  update: (projectId: string, segmentId: string, body: UpdateSegmentFields) =>
    api(segmentResponseWire, `${s(projectId)}/${segmentId}`, {
      method: "PUT",
      body,
    }),
  remove: (projectId: string, segmentId: string) =>
    api(null, `${s(projectId)}/${segmentId}`, { method: "DELETE" }),
};
