-- CreateIndex
CREATE INDEX "flag_targeting_rules_serve_idx" ON "flag_targeting_rules" USING GIN ("serve" jsonb_ops);
