-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('USER', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('OWNER', 'MAINTAINER', 'DEVELOPER', 'VIEWER');

-- CreateEnum
CREATE TYPE "CreationMode" AS ENUM ('CREATE_NEW', 'IMPORT_EXISTING');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'PROVISIONING', 'ACTIVE', 'ERROR', 'DELETED');

-- CreateEnum
CREATE TYPE "ExpiryAction" AS ENUM ('WARN', 'TEARDOWN');

-- CreateEnum
CREATE TYPE "CloudProvider" AS ENUM ('AWS', 'GCP', 'AZURE');

-- CreateEnum
CREATE TYPE "CredentialMode" AS ENUM ('BYOC', 'MANAGED');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'DEPLOYING', 'ACTIVE', 'SWITCHING', 'RECONFIGURING', 'TEARINGDOWN', 'BLOCKED', 'ERROR');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('PROVISION', 'TEARDOWN', 'DOMAIN_APPLY');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('QUEUED', 'NETWORK', 'CLUSTER', 'CLUSTER_ACCESS', 'DOMAINS', 'DONE', 'CANCEL_REQUESTED', 'COMPENSATING', 'COMPENSATION_FAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('CREATING', 'CREATED', 'READY', 'DELETING', 'DELETED', 'ORPHAN_SUSPECTED');

-- CreateEnum
CREATE TYPE "ProvisionStep" AS ENUM ('NETWORK', 'CLUSTER', 'DOMAINS', 'K8S_MANAGED');

-- CreateEnum
CREATE TYPE "SdkKeyType" AS ENUM ('SERVER', 'CLIENT');

-- CreateEnum
CREATE TYPE "FlagType" AS ENUM ('BOOLEAN', 'STRING', 'NUMBER', 'JSON');

-- CreateEnum
CREATE TYPE "FlagLifecycleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('ALL', 'USER_BASED', 'ATTRIBUTE_BASED', 'SEGMENT');

-- CreateEnum
CREATE TYPE "RolloutScope" AS ENUM ('FLAG_LEVEL', 'SERVICE_LEVEL');

-- CreateEnum
CREATE TYPE "RolloutStrategy" AS ENUM ('CANARY', 'ATTRIBUTE_SPLIT', 'BLUE_GREEN');

-- CreateEnum
CREATE TYPE "ControlMode" AS ENUM ('UDP_DRIVEN', 'TOOL_DRIVEN');

-- CreateEnum
CREATE TYPE "RolloutStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'PAUSED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "FailReason" AS ENUM ('AUTO_ROLLBACK', 'MANUAL', 'EXPIRED', 'DEPENDENCY_DOWN');

-- CreateEnum
CREATE TYPE "RolloutAction" AS ENUM ('PROMOTE', 'ROLLBACK', 'PAUSE', 'RESUME', 'COMPLETE', 'EXPIRE', 'DEPENDENCY_DOWN');

-- CreateEnum
CREATE TYPE "TriggeredBy" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "DeploymentEventType" AS ENUM ('DEPLOY_START', 'DEPLOY_SUCCESS', 'DEPLOY_FAILURE', 'FLAG_CHANGE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "DeploymentTrigger" AS ENUM ('WEBHOOK', 'MANUAL', 'ROLLBACK', 'AUTO');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'SDK');

-- CreateTable
CREATE TABLE "domain_catalog" (
    "domain_type" VARCHAR(50) NOT NULL,
    "tier" VARCHAR(20) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "default_order" INTEGER NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "domain_catalog_pkey" PRIMARY KEY ("domain_type")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "platform_role" "PlatformRole" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "project_role" "ProjectRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "repo_url" VARCHAR(500),
    "creation_mode" "CreationMode" NOT NULL,
    "language_runtime" VARCHAR(50) NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "metadata" JSONB,
    "resource_quota" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "expiry_action" "ExpiryAction" NOT NULL DEFAULT 'WARN',
    "cluster_access" JSONB,
    "domain_set_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "environments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "k8s_namespace" VARCHAR(63) NOT NULL,
    "is_production" BOOLEAN NOT NULL DEFAULT false,
    "rank" INTEGER NOT NULL,
    "auto_deploy" BOOLEAN NOT NULL DEFAULT true,
    "config_version" INTEGER NOT NULL DEFAULT 0,
    "config_hash" VARCHAR(64) NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "environments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sdk_keys" (
    "id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "key_type" "SdkKeyType" NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "key_prefix" VARCHAR(16) NOT NULL,
    "label" VARCHAR(100),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sdk_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_credentials" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "provider" "CloudProvider" NOT NULL,
    "mode" "CredentialMode" NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "encrypted_dek" TEXT NOT NULL,
    "kek_version" INTEGER NOT NULL DEFAULT 1,
    "dek_version" INTEGER NOT NULL DEFAULT 1,
    "auth_kind" VARCHAR(20) NOT NULL,
    "nonce" CHAR(24) NOT NULL,
    "auth_tag" CHAR(24) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "last_validated_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cloud_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_configs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "domain_type" VARCHAR(50) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "domain_status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
    "selected_tool" VARCHAR(100),
    "tool_config" JSONB,
    "adapter_version" VARCHAR(20),
    "last_error" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "domain_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_bindings" (
    "id" UUID NOT NULL,
    "domain_config_id" UUID NOT NULL,
    "environment_id" UUID,
    "capability_id" VARCHAR(50) NOT NULL,
    "provided_by" VARCHAR(100) NOT NULL,
    "schema_version" VARCHAR(10) NOT NULL,
    "endpoint" VARCHAR(500),
    "attributes" JSONB,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "capability_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "capability_preferences" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "capability_id" VARCHAR(50) NOT NULL,
    "provider_tool_id" VARCHAR(100) NOT NULL,

    CONSTRAINT "capability_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioning_jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "job_type" "JobType" NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "estimated_cost" JSONB,
    "last_error" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "claimed_by" VARCHAR(100),
    "claimed_until" TIMESTAMPTZ(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provisioning_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provisioned_resources" (
    "id" UUID NOT NULL,
    "job_id" UUID,
    "project_id" UUID NOT NULL,
    "step" "ProvisionStep" NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "provider_id" VARCHAR(255),
    "provider" "CloudProvider" NOT NULL,
    "region" VARCHAR(50) NOT NULL,
    "status" "ResourceStatus" NOT NULL DEFAULT 'CREATING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provisioned_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "flag_type" "FlagType" NOT NULL,
    "default_variant_id" UUID,
    "lifecycle_status" "FlagLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "stickiness_attribute" VARCHAR(100) NOT NULL DEFAULT 'targetingKey',
    "permanent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag_variants" (
    "id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "flag_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag_env_configs" (
    "id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "default_variant_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flag_env_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag_targeting_rules" (
    "id" UUID NOT NULL,
    "flag_env_config_id" UUID NOT NULL,
    "rule_type" "RuleType" NOT NULL,
    "condition" JSONB NOT NULL,
    "serve" JSONB NOT NULL,
    "bucket_salt" VARCHAR(36) NOT NULL,
    "description" VARCHAR(255),
    "priority" INTEGER NOT NULL,

    CONSTRAINT "flag_targeting_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "conditions" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flag_evaluation_stats" (
    "id" UUID NOT NULL,
    "flag_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "variant_key" VARCHAR(100) NOT NULL,
    "eval_count" BIGINT NOT NULL DEFAULT 0,
    "bucket_hour" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "flag_evaluation_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_change_log" (
    "id" BIGSERIAL NOT NULL,
    "environment_id" UUID NOT NULL,
    "change_type" VARCHAR(50) NOT NULL,
    "payload" JSONB NOT NULL,
    "config_version" INTEGER NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rollout_sessions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "flag_env_config_id" UUID,
    "targeting_rule_id" UUID,
    "target_variant_id" UUID,
    "workload_name" VARCHAR(253),
    "rollout_scope" "RolloutScope" NOT NULL,
    "strategy" "RolloutStrategy" NOT NULL,
    "control_mode" "ControlMode" NOT NULL,
    "status" "RolloutStatus" NOT NULL DEFAULT 'PENDING',
    "current_traffic_percentage" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "baseline_percentage" DECIMAL(5,2),
    "version_new" VARCHAR(255),
    "version_old" VARCHAR(255),
    "thresholds" JSONB NOT NULL,
    "metric_queries" JSONB,
    "step_percent" DECIMAL(5,2) NOT NULL,
    "step_interval_seconds" INTEGER NOT NULL DEFAULT 300,
    "analysis_interval_seconds" INTEGER NOT NULL DEFAULT 30,
    "metric_window_seconds" INTEGER NOT NULL DEFAULT 60,
    "warm_up_requests" INTEGER NOT NULL DEFAULT 100,
    "max_duration_seconds" INTEGER NOT NULL DEFAULT 86400,
    "last_step_at" TIMESTAMPTZ(3),
    "last_decision" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "claimed_by" VARCHAR(100),
    "claimed_until" TIMESTAMPTZ(3),
    "fail_reason" "FailReason",
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rollout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rollout_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "action" "RolloutAction" NOT NULL,
    "is_intent" BOOLEAN NOT NULL DEFAULT false,
    "processed_at" TIMESTAMPTZ(3),
    "traffic_percentage" DECIMAL(5,2) NOT NULL,
    "metric_snapshot" JSONB,
    "reason" VARCHAR(255),
    "triggered_by" "TriggeredBy" NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rollout_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "environment_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "event_type" "DeploymentEventType" NOT NULL,
    "workload_name" VARCHAR(253),
    "pipeline_id" VARCHAR(255),
    "image_tag" VARCHAR(255),
    "commit_sha" VARCHAR(40),
    "commit_timestamp" TIMESTAMPTZ(3),
    "restores_deployment_id" UUID,
    "rollout_session_id" UUID,
    "triggered_by" "DeploymentTrigger" NOT NULL,
    "metadata" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "actor_user_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" VARCHAR(100) NOT NULL,
    "environment_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip_address" INET,
    "user_agent" VARCHAR(255),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "projects_owner_id_status_idx" ON "projects"("owner_id", "status");

-- CreateIndex
CREATE INDEX "projects_expires_at_idx" ON "projects"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "environments_project_id_name_key" ON "environments"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sdk_keys_key_hash_key" ON "sdk_keys"("key_hash");

-- CreateIndex
CREATE INDEX "sdk_keys_environment_id_idx" ON "sdk_keys"("environment_id");

-- CreateIndex
CREATE INDEX "cloud_credentials_project_id_idx" ON "cloud_credentials"("project_id");

-- CreateIndex
CREATE INDEX "domain_configs_domain_type_idx" ON "domain_configs"("domain_type");

-- CreateIndex
CREATE UNIQUE INDEX "domain_configs_project_id_domain_type_key" ON "domain_configs"("project_id", "domain_type");

-- CreateIndex
CREATE INDEX "capability_bindings_capability_id_idx" ON "capability_bindings"("capability_id");

-- CreateIndex
CREATE UNIQUE INDEX "capability_preferences_project_id_capability_id_key" ON "capability_preferences"("project_id", "capability_id");

-- CreateIndex
CREATE INDEX "provisioning_jobs_project_id_created_at_idx" ON "provisioning_jobs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "provisioning_jobs_state_claimed_until_idx" ON "provisioning_jobs"("state", "claimed_until");

-- CreateIndex
CREATE UNIQUE INDEX "provisioned_resources_idempotency_key_key" ON "provisioned_resources"("idempotency_key");

-- CreateIndex
CREATE INDEX "provisioned_resources_project_id_status_idx" ON "provisioned_resources"("project_id", "status");

-- CreateIndex
CREATE INDEX "provisioned_resources_job_id_idx" ON "provisioned_resources"("job_id");

-- CreateIndex
CREATE INDEX "feature_flags_project_id_lifecycle_status_idx" ON "feature_flags"("project_id", "lifecycle_status");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_project_id_key_key" ON "feature_flags"("project_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "flag_variants_flag_id_key_key" ON "flag_variants"("flag_id", "key");

-- CreateIndex
CREATE INDEX "flag_env_configs_environment_id_is_enabled_idx" ON "flag_env_configs"("environment_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "flag_env_configs_flag_id_environment_id_key" ON "flag_env_configs"("flag_id", "environment_id");

-- CreateIndex
CREATE INDEX "flag_targeting_rules_flag_env_config_id_priority_idx" ON "flag_targeting_rules"("flag_env_config_id", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "segments_project_id_name_key" ON "segments"("project_id", "name");

-- CreateIndex
CREATE INDEX "flag_evaluation_stats_bucket_hour_idx" ON "flag_evaluation_stats"("bucket_hour");

-- CreateIndex
CREATE UNIQUE INDEX "flag_evaluation_stats_flag_id_environment_id_variant_key_bu_key" ON "flag_evaluation_stats"("flag_id", "environment_id", "variant_key", "bucket_hour");

-- CreateIndex
CREATE INDEX "config_change_log_created_at_idx" ON "config_change_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "config_change_log_environment_id_config_version_key" ON "config_change_log"("environment_id", "config_version");

-- CreateIndex
CREATE INDEX "rollout_sessions_project_id_status_created_at_idx" ON "rollout_sessions"("project_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "rollout_sessions_status_claimed_until_idx" ON "rollout_sessions"("status", "claimed_until");

-- CreateIndex
CREATE INDEX "rollout_events_session_id_created_at_idx" ON "rollout_events"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "rollout_events_session_id_is_intent_processed_at_idx" ON "rollout_events"("session_id", "is_intent", "processed_at");

-- CreateIndex
CREATE INDEX "deployment_events_project_id_occurred_at_idx" ON "deployment_events"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "deployment_events_environment_id_occurred_at_idx" ON "deployment_events"("environment_id", "occurred_at");

-- CreateIndex
CREATE INDEX "deployment_events_deployment_id_idx" ON "deployment_events"("deployment_id");

-- CreateIndex
CREATE INDEX "audit_logs_project_id_occurred_at_idx" ON "audit_logs"("project_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "audit_logs"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_occurred_at_idx" ON "audit_logs"("target_type", "target_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdk_keys" ADD CONSTRAINT "sdk_keys_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sdk_keys" ADD CONSTRAINT "sdk_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_credentials" ADD CONSTRAINT "cloud_credentials_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_credentials" ADD CONSTRAINT "cloud_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_configs" ADD CONSTRAINT "domain_configs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_configs" ADD CONSTRAINT "domain_configs_domain_type_fkey" FOREIGN KEY ("domain_type") REFERENCES "domain_catalog"("domain_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_bindings" ADD CONSTRAINT "capability_bindings_domain_config_id_fkey" FOREIGN KEY ("domain_config_id") REFERENCES "domain_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_bindings" ADD CONSTRAINT "capability_bindings_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "capability_preferences" ADD CONSTRAINT "capability_preferences_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioned_resources" ADD CONSTRAINT "provisioned_resources_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "provisioning_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provisioned_resources" ADD CONSTRAINT "provisioned_resources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_default_variant_id_fkey" FOREIGN KEY ("default_variant_id") REFERENCES "flag_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_variants" ADD CONSTRAINT "flag_variants_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "feature_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_env_configs" ADD CONSTRAINT "flag_env_configs_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "feature_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_env_configs" ADD CONSTRAINT "flag_env_configs_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_env_configs" ADD CONSTRAINT "flag_env_configs_default_variant_id_fkey" FOREIGN KEY ("default_variant_id") REFERENCES "flag_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_targeting_rules" ADD CONSTRAINT "flag_targeting_rules_flag_env_config_id_fkey" FOREIGN KEY ("flag_env_config_id") REFERENCES "flag_env_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_evaluation_stats" ADD CONSTRAINT "flag_evaluation_stats_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "feature_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flag_evaluation_stats" ADD CONSTRAINT "flag_evaluation_stats_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_change_log" ADD CONSTRAINT "config_change_log_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_change_log" ADD CONSTRAINT "config_change_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_flag_env_config_id_fkey" FOREIGN KEY ("flag_env_config_id") REFERENCES "flag_env_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_targeting_rule_id_fkey" FOREIGN KEY ("targeting_rule_id") REFERENCES "flag_targeting_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_target_variant_id_fkey" FOREIGN KEY ("target_variant_id") REFERENCES "flag_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_sessions" ADD CONSTRAINT "rollout_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_events" ADD CONSTRAINT "rollout_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "rollout_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rollout_events" ADD CONSTRAINT "rollout_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_events" ADD CONSTRAINT "deployment_events_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
