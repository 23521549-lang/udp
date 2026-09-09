/*
  Warnings:

  - Made the column `job_id` on table `provisioned_resources` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "provisioned_resources" DROP CONSTRAINT "provisioned_resources_job_id_fkey";

-- DropForeignKey
ALTER TABLE "rollout_sessions" DROP CONSTRAINT "rollout_sessions_flag_env_config_id_fkey";

-- DropForeignKey
ALTER TABLE "rollout_sessions" DROP CONSTRAINT "rollout_sessions_targeting_rule_id_fkey";

-- AlterTable
ALTER TABLE "provisioned_resources" ALTER COLUMN "job_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "deployment_events_project_id_environment_id_occurred_at_idx" ON "deployment_events"("project_id", "environment_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "provisioned_resources" ADD CONSTRAINT "provisioned_resources_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "provisioning_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_flag_env_config_id_fkey" FOREIGN KEY ("flag_env_config_id") REFERENCES "flag_env_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_targeting_rule_id_fkey" FOREIGN KEY ("targeting_rule_id") REFERENCES "flag_targeting_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
