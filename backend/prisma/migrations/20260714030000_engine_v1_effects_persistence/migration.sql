-- Phase 1J is deliberately clean-slate for all functional actors, content and
-- inventory. No existing row is converted, removed, copied or rewritten.
DO $clean_slate$
BEGIN
  IF EXISTS (SELECT 1 FROM "Actor" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ContentDefinition" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ContentVersion" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ActorContent" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "InventoryEntry" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ActorEquipmentSlot" LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Phase 1J migration requires empty Actor, ContentDefinition, ContentVersion, ActorContent, InventoryEntry and ActorEquipmentSlot tables; clear functional data before rollout';
  END IF;
END
$clean_slate$;

CREATE TYPE "ContentEffectBindingKind" AS ENUM ('APPLY_STATUS', 'REMOVE_STATUS');
CREATE TYPE "ActiveEffectKind" AS ENUM ('STATUS', 'PRIMARY_MODIFIER', 'SECONDARY_MODIFIER', 'REACTION_GRANT');
CREATE TYPE "ActiveEffectDurationType" AS ENUM ('TICKS', 'ACTIONS', 'SCENE', 'ENCOUNTER', 'PERMANENT');
CREATE TYPE "EffectResolutionOperation" AS ENUM ('EXECUTE_CONTENT', 'USE_CONSUMABLE');
CREATE TYPE "EffectRollKind" AS ENUM ('HIT', 'CRITICAL', 'CONCENTRATION');

CREATE TABLE "EffectRulesVersion" (
  "id" UUID NOT NULL,
  "rulesetVersionId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "configHash" CHAR(64) NOT NULL,
  "configSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EffectRulesVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EffectRulesVersion_schemaVersion_check" CHECK ("schemaVersion" > 0),
  CONSTRAINT "EffectRulesVersion_configHash_check" CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EffectRulesVersion_configSnapshot_check" CHECK (jsonb_typeof("configSnapshot") = 'object')
);

ALTER TABLE "Campaign"
  ADD COLUMN "engineTick" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "engineStateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "Campaign_engineTick_check" CHECK ("engineTick" BETWEEN 0 AND 9000000000000000),
  ADD CONSTRAINT "Campaign_engineStateVersion_check" CHECK ("engineStateVersion" > 0);

ALTER TABLE "Actor"
  ADD COLUMN "effectsStateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "Actor_effectsStateVersion_check" CHECK ("effectsStateVersion" > 0);

ALTER TABLE "ActorDerivedSnapshot"
  ADD COLUMN "effectsStateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "ActorDerivedSnapshot_effectsStateVersion_check" CHECK ("effectsStateVersion" > 0);
ALTER TABLE "ActorDerivedSnapshot" ALTER COLUMN "effectsStateVersion" DROP DEFAULT;

ALTER TABLE "ActorResource" DROP CONSTRAINT "ActorResource_stateVersion_check";
ALTER TABLE "ActorResource" ADD CONSTRAINT "ActorResource_stateVersion_check" CHECK ("stateVersion" > 0);

ALTER TABLE "ContentVersion"
  ADD COLUMN "effectBindingHash" CHAR(64) NOT NULL DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  ADD CONSTRAINT "ContentVersion_effectBindingHash_check" CHECK ("effectBindingHash" ~ '^[0-9a-f]{64}$');

DROP INDEX "ContentVersion_without_inventory_spec_key";
DROP INDEX "ContentVersion_with_inventory_spec_key";
CREATE UNIQUE INDEX "ContentVersion_without_inventory_spec_key"
  ON "ContentVersion"("contentDefinitionId", "contentHash", "effectBindingHash")
  WHERE "inventorySpecHash" IS NULL;
CREATE UNIQUE INDEX "ContentVersion_with_inventory_spec_key"
  ON "ContentVersion"("contentDefinitionId", "contentHash", "inventorySpecHash", "effectBindingHash")
  WHERE "inventorySpecHash" IS NOT NULL;

CREATE TABLE "ContentEffectBinding" (
  "id" UUID NOT NULL,
  "sourceContentVersionId" UUID NOT NULL,
  "effectIndex" INTEGER NOT NULL,
  "bindingKind" "ContentEffectBindingKind" NOT NULL,
  "targetContentDefinitionId" UUID NOT NULL,
  "targetContentVersionId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentEffectBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentEffectBinding_effectIndex_check" CHECK ("effectIndex" >= 0)
);

CREATE TABLE "ActiveEffect" (
  "id" UUID NOT NULL,
  "targetActorId" UUID NOT NULL,
  "sourceActorId" UUID NOT NULL,
  "sourceContentVersionId" UUID NOT NULL,
  "effectContentVersionId" UUID,
  "effectRulesVersionId" UUID NOT NULL,
  "effectRef" TEXT NOT NULL,
  "effectIndex" INTEGER NOT NULL,
  "kind" "ActiveEffectKind" NOT NULL,
  "stacks" INTEGER NOT NULL,
  "appliedAtTick" BIGINT NOT NULL,
  "durationType" "ActiveEffectDurationType" NOT NULL,
  "expiresAtTick" BIGINT,
  "remainingActions" INTEGER,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActiveEffect_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActiveEffect_effectRef_check" CHECK (char_length("effectRef") BETWEEN 4 AND 80 AND "effectRef" ~ '^fx_[a-z0-9]+$'),
  CONSTRAINT "ActiveEffect_effectIndex_check" CHECK ("effectIndex" >= 0),
  CONSTRAINT "ActiveEffect_stacks_check" CHECK ("stacks" BETWEEN 1 AND 10),
  CONSTRAINT "ActiveEffect_appliedAtTick_check" CHECK ("appliedAtTick" BETWEEN 0 AND 9000000000000000),
  CONSTRAINT "ActiveEffect_expiresAtTick_check" CHECK ("expiresAtTick" IS NULL OR "expiresAtTick" BETWEEN 0 AND 9000000000000000),
  CONSTRAINT "ActiveEffect_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "ActiveEffect_kind_content_check" CHECK (
    ("kind" = 'STATUS' AND "effectContentVersionId" IS NOT NULL)
    OR ("kind" <> 'STATUS' AND "effectContentVersionId" IS NULL)
  ),
  CONSTRAINT "ActiveEffect_duration_check" CHECK (
    ("durationType" = 'TICKS' AND "expiresAtTick" IS NOT NULL AND "remainingActions" IS NULL)
    OR ("durationType" = 'ACTIONS' AND "expiresAtTick" IS NULL AND "remainingActions" > 0)
    OR ("durationType" IN ('SCENE', 'ENCOUNTER', 'PERMANENT') AND "expiresAtTick" IS NULL AND "remainingActions" IS NULL)
  )
);

CREATE TABLE "EffectResolution" (
  "id" UUID NOT NULL,
  "campaignId" UUID NOT NULL,
  "sourceActorId" UUID NOT NULL,
  "targetActorId" UUID,
  "sourceContentVersionId" UUID NOT NULL,
  "effectRulesVersionId" UUID NOT NULL,
  "operation" "EffectResolutionOperation" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "engineTick" BIGINT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "resultHash" CHAR(64) NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EffectResolution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EffectResolution_engineTick_check" CHECK ("engineTick" BETWEEN 0 AND 9000000000000000),
  CONSTRAINT "EffectResolution_requestHash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EffectResolution_resultHash_check" CHECK ("resultHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EffectResolution_resultSnapshot_check" CHECK (jsonb_typeof("resultSnapshot") = 'object'),
  CONSTRAINT "EffectResolution_idempotencyKey_check" CHECK (char_length("idempotencyKey") BETWEEN 8 AND 200)
);

CREATE TABLE "EffectRoll" (
  "id" UUID NOT NULL,
  "effectResolutionId" UUID NOT NULL,
  "kind" "EffectRollKind" NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "rollBps" INTEGER NOT NULL,
  "chanceBps" INTEGER NOT NULL,
  "success" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EffectRoll_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EffectRoll_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "EffectRoll_rollBps_check" CHECK ("rollBps" BETWEEN 1 AND 10000),
  CONSTRAINT "EffectRoll_chanceBps_check" CHECK ("chanceBps" BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX "EffectRulesVersion_code_key" ON "EffectRulesVersion"("code");
CREATE INDEX "EffectRulesVersion_rulesetVersionId_idx" ON "EffectRulesVersion"("rulesetVersionId");
CREATE UNIQUE INDEX "ContentEffectBinding_sourceContentVersionId_effectIndex_bin_key"
  ON "ContentEffectBinding"("sourceContentVersionId", "effectIndex", "bindingKind");
CREATE INDEX "ContentEffectBinding_targetContentVersionId_targetContentDe_idx"
  ON "ContentEffectBinding"("targetContentVersionId", "targetContentDefinitionId");
CREATE UNIQUE INDEX "ActiveEffect_targetActorId_effectRef_key" ON "ActiveEffect"("targetActorId", "effectRef");
CREATE UNIQUE INDEX "ActiveEffect_status_version_key" ON "ActiveEffect"("targetActorId", "effectContentVersionId")
  WHERE "effectContentVersionId" IS NOT NULL;
CREATE UNIQUE INDEX "ActiveEffect_direct_origin_key" ON "ActiveEffect"("targetActorId", "sourceContentVersionId", "effectIndex", "kind");
CREATE INDEX "ActiveEffect_targetActorId_expiresAtTick_idx" ON "ActiveEffect"("targetActorId", "expiresAtTick");
CREATE INDEX "ActiveEffect_sourceActorId_idx" ON "ActiveEffect"("sourceActorId");
CREATE INDEX "ActiveEffect_sourceContentVersionId_idx" ON "ActiveEffect"("sourceContentVersionId");
CREATE INDEX "ActiveEffect_effectRulesVersionId_idx" ON "ActiveEffect"("effectRulesVersionId");
CREATE UNIQUE INDEX "EffectResolution_idempotencyKey_key" ON "EffectResolution"("idempotencyKey");
CREATE INDEX "EffectResolution_campaignId_createdAt_idx" ON "EffectResolution"("campaignId", "createdAt");
CREATE INDEX "EffectResolution_sourceActorId_createdAt_idx" ON "EffectResolution"("sourceActorId", "createdAt");
CREATE INDEX "EffectResolution_targetActorId_createdAt_idx" ON "EffectResolution"("targetActorId", "createdAt");
CREATE INDEX "EffectResolution_sourceContentVersionId_idx" ON "EffectResolution"("sourceContentVersionId");
CREATE INDEX "EffectResolution_effectRulesVersionId_idx" ON "EffectResolution"("effectRulesVersionId");
CREATE UNIQUE INDEX "EffectRoll_effectResolutionId_kind_ordinal_key" ON "EffectRoll"("effectResolutionId", "kind", "ordinal");

ALTER TABLE "EffectRulesVersion" ADD CONSTRAINT "EffectRulesVersion_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentEffectBinding" ADD CONSTRAINT "ContentEffectBinding_sourceContentVersionId_fkey"
  FOREIGN KEY ("sourceContentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentEffectBinding" ADD CONSTRAINT "ContentEffectBinding_targetContentDefinitionId_fkey"
  FOREIGN KEY ("targetContentDefinitionId") REFERENCES "ContentDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentEffectBinding" ADD CONSTRAINT "ContentEffectBinding_targetContentVersionId_targetContentD_fkey"
  FOREIGN KEY ("targetContentVersionId", "targetContentDefinitionId") REFERENCES "ContentVersion"("id", "contentDefinitionId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActiveEffect" ADD CONSTRAINT "ActiveEffect_targetActorId_fkey"
  FOREIGN KEY ("targetActorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActiveEffect" ADD CONSTRAINT "ActiveEffect_sourceActorId_fkey"
  FOREIGN KEY ("sourceActorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActiveEffect" ADD CONSTRAINT "ActiveEffect_sourceContentVersionId_fkey"
  FOREIGN KEY ("sourceContentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActiveEffect" ADD CONSTRAINT "ActiveEffect_effectContentVersionId_fkey"
  FOREIGN KEY ("effectContentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActiveEffect" ADD CONSTRAINT "ActiveEffect_effectRulesVersionId_fkey"
  FOREIGN KEY ("effectRulesVersionId") REFERENCES "EffectRulesVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EffectResolution" ADD CONSTRAINT "EffectResolution_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EffectResolution" ADD CONSTRAINT "EffectResolution_sourceActorId_fkey"
  FOREIGN KEY ("sourceActorId") REFERENCES "Actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EffectResolution" ADD CONSTRAINT "EffectResolution_targetActorId_fkey"
  FOREIGN KEY ("targetActorId") REFERENCES "Actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EffectResolution" ADD CONSTRAINT "EffectResolution_sourceContentVersionId_fkey"
  FOREIGN KEY ("sourceContentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EffectResolution" ADD CONSTRAINT "EffectResolution_effectRulesVersionId_fkey"
  FOREIGN KEY ("effectRulesVersionId") REFERENCES "EffectRulesVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EffectRoll" ADD CONSTRAINT "EffectRoll_effectResolutionId_fkey"
  FOREIGN KEY ("effectResolutionId") REFERENCES "EffectResolution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "phase1j_immutable_record"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_TABLE_NAME || ' is immutable and cannot be updated or deleted';
END
$function$;

CREATE TRIGGER "EffectRulesVersion_reject_update" BEFORE UPDATE ON "EffectRulesVersion"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "EffectRulesVersion_reject_delete" BEFORE DELETE ON "EffectRulesVersion"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "ContentEffectBinding_reject_update" BEFORE UPDATE ON "ContentEffectBinding"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "ContentEffectBinding_reject_delete" BEFORE DELETE ON "ContentEffectBinding"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "EffectResolution_reject_update" BEFORE UPDATE ON "EffectResolution"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "EffectResolution_reject_delete" BEFORE DELETE ON "EffectResolution"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "EffectRoll_reject_update" BEFORE UPDATE ON "EffectRoll"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();
CREATE TRIGGER "EffectRoll_reject_delete" BEFORE DELETE ON "EffectRoll"
  FOR EACH ROW EXECUTE FUNCTION "phase1j_immutable_record"();

CREATE FUNCTION "content_effect_binding_validate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  source_rules UUID;
  target_rules UUID;
  target_type "ContentType";
BEGIN
  SELECT "rulesetVersionId" INTO source_rules FROM "ContentVersion" WHERE "id" = NEW."sourceContentVersionId";
  SELECT cv."rulesetVersionId", cd."contentType" INTO target_rules, target_type
    FROM "ContentVersion" cv
    JOIN "ContentDefinition" cd ON cd."id" = cv."contentDefinitionId"
    WHERE cv."id" = NEW."targetContentVersionId" AND cd."id" = NEW."targetContentDefinitionId";
  IF source_rules IS NULL OR target_rules IS NULL OR source_rules IS DISTINCT FROM target_rules THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentEffectBinding ruleset is incompatible';
  END IF;
  IF target_type IS DISTINCT FROM 'STATUS_EFFECT' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentEffectBinding target must be STATUS_EFFECT';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "ContentEffectBinding_validate_write" BEFORE INSERT ON "ContentEffectBinding"
  FOR EACH ROW EXECUTE FUNCTION "content_effect_binding_validate"();

CREATE FUNCTION "active_effect_validate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  source_campaign UUID;
  target_campaign UUID;
  campaign_rules UUID;
  source_content_rules UUID;
  effect_content_rules UUID;
  effect_rules_rules UUID;
BEGIN
  SELECT "campaignId" INTO source_campaign FROM "Actor" WHERE "id" = NEW."sourceActorId";
  SELECT "campaignId" INTO target_campaign FROM "Actor" WHERE "id" = NEW."targetActorId";
  IF source_campaign IS NULL OR target_campaign IS NULL OR source_campaign IS DISTINCT FROM target_campaign THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect actors must belong to the same Campaign';
  END IF;
  SELECT "rulesetVersionId" INTO campaign_rules FROM "Campaign" WHERE "id" = target_campaign;
  SELECT "rulesetVersionId" INTO source_content_rules FROM "ContentVersion" WHERE "id" = NEW."sourceContentVersionId";
  SELECT "rulesetVersionId" INTO effect_rules_rules FROM "EffectRulesVersion" WHERE "id" = NEW."effectRulesVersionId";
  IF campaign_rules IS NULL OR source_content_rules IS DISTINCT FROM campaign_rules OR effect_rules_rules IS DISTINCT FROM campaign_rules THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect ruleset is incompatible';
  END IF;
  IF NEW."effectContentVersionId" IS NOT NULL THEN
    SELECT "rulesetVersionId" INTO effect_content_rules FROM "ContentVersion" WHERE "id" = NEW."effectContentVersionId";
    IF effect_content_rules IS DISTINCT FROM campaign_rules THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect content ruleset is incompatible';
    END IF;
  END IF;
  IF NEW."kind" = 'STATUS' AND NOT EXISTS (
    SELECT 1 FROM "ContentEffectBinding" b
    WHERE b."sourceContentVersionId" = NEW."sourceContentVersionId"
      AND b."effectIndex" = NEW."effectIndex"
      AND b."bindingKind" = 'APPLY_STATUS'
      AND b."targetContentVersionId" = NEW."effectContentVersionId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect status does not match its immutable binding';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "ActiveEffect_validate_write" BEFORE INSERT OR UPDATE ON "ActiveEffect"
  FOR EACH ROW EXECUTE FUNCTION "active_effect_validate"();

CREATE FUNCTION "effect_resolution_validate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  source_campaign UUID;
  target_campaign UUID;
  campaign_rules UUID;
  content_rules UUID;
  effect_rules_rules UUID;
BEGIN
  SELECT "campaignId" INTO source_campaign FROM "Actor" WHERE "id" = NEW."sourceActorId";
  IF source_campaign IS DISTINCT FROM NEW."campaignId" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EffectResolution source Actor Campaign is incompatible';
  END IF;
  IF NEW."targetActorId" IS NOT NULL THEN
    SELECT "campaignId" INTO target_campaign FROM "Actor" WHERE "id" = NEW."targetActorId";
    IF target_campaign IS DISTINCT FROM NEW."campaignId" THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EffectResolution target Actor Campaign is incompatible';
    END IF;
  END IF;
  SELECT "rulesetVersionId" INTO campaign_rules FROM "Campaign" WHERE "id" = NEW."campaignId";
  SELECT "rulesetVersionId" INTO content_rules FROM "ContentVersion" WHERE "id" = NEW."sourceContentVersionId";
  SELECT "rulesetVersionId" INTO effect_rules_rules FROM "EffectRulesVersion" WHERE "id" = NEW."effectRulesVersionId";
  IF campaign_rules IS NULL OR content_rules IS DISTINCT FROM campaign_rules OR effect_rules_rules IS DISTINCT FROM campaign_rules THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EffectResolution ruleset is incompatible';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "EffectResolution_validate_write" BEFORE INSERT ON "EffectResolution"
  FOR EACH ROW EXECUTE FUNCTION "effect_resolution_validate"();

DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['EffectRulesVersion', 'ContentEffectBinding', 'ActiveEffect', 'EffectResolution', 'EffectRoll']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', table_name);
    END IF;
  END LOOP;
END
$security$;

-- Structural rollback is delivered only as a new reviewed corrective migration:
-- remove Phase 1J triggers/functions, FKs/indexes/tables/enums and the added
-- columns, then restore the prior partial indexes. Never edit this migration,
-- delete functional data, or mutate an immutable publication as rollback.
