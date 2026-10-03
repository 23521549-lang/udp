import type { z } from "zod";
import {
  updateEnvConfigFields,
  updateEnvConfigRefine,
} from "@udp/shared-types";

/** Hợp đồng của `PATCH /internal/flag-envs/:id` — hình dùng chung ở `@udp/shared-types/flag-api` [v4.5] */
export const updateEnvConfigSchema = updateEnvConfigFields
  .strict()
  .superRefine(updateEnvConfigRefine);

export type UpdateEnvConfigInput = z.infer<typeof updateEnvConfigSchema>;

export interface PublicEnvConfig {
  id: string;
  flagId: string;
  environmentId: string;
  isEnabled: boolean;
  defaultVariantId: string | null;
  updatedAt: Date;
}
