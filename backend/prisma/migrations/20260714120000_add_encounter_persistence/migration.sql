-- Phase 1L-A adds encounter persistence without changing or backfilling existing rows.
-- The migration is intentionally additive and does not access external databases.
CREATE TYPE "EncounterLifecycleStatus" AS ENUM (
  'AWAITING_INTENT', 'AWAITING_REACTION', 'PROCESSING_PAUSED', 'COMPLETION_PENDING',
  'COMPLETED', 'FAILED', 'CANCELLED'
);
CREATE TYPE "EncounterStopReason" AS ENUM (
  'PLAN_COMPLETED', 'ACTOR_INCAPACITATED', 'HOSTILE_BECAME_READY', 'TARGET_SET_CHANGED',
  'RESOURCE_BELOW_REQUIRED', 'ZONE_CHANGED', 'NEW_THREAT_DETECTED', 'STATE_VERSION_CHANGED',
  'PROCESSING_LIMIT', 'NO_VALID_TARGET', 'REACTION_REQUIRED', 'NEW_INTENT_REQUIRED',
  'ENCOUNTER_COMPLETED', 'ENCOUNTER_FAILED'
);
CREATE TYPE "EncounterCompletionCandidate" AS ENUM (
  'PARTY_VICTORY_CANDIDATE', 'HOSTILE_VICTORY_CANDIDATE', 'STALEMATE_CANDIDATE', 'CANCELLED'
);
CREATE TYPE "EncounterParticipantBindingKind" AS ENUM ('PERSISTED_ACTOR', 'EPHEMERAL');
CREATE TYPE "EncounterEphemeralKind" AS ENUM ('SUMMON', 'PROJECTION', 'EPHEMERAL_CREATURE');
CREATE TYPE "EncounterOperationKind" AS ENUM (
  'CREATE', 'SUBMIT_INTENT', 'RESOLVE_REACTION', 'CONTINUE', 'CONFIRM_COMPLETION', 'CANCEL'
);
CREATE TYPE "EncounterRollKind" AS ENUM (
  'TIE_BREAK', 'HIT', 'CRITICAL', 'CONCENTRATION',
  'BLOCK', 'ACTIVE_DODGE', 'INTERRUPT', 'COUNTER_ATTACK'
);

CREATE TABLE "Encounter" (
  "id" UUID NOT NULL,
  "campaignId" UUID NOT NULL,
  "rulesetVersionId" UUID NOT NULL,
  "encounterRef" TEXT NOT NULL,
  "lifecycleStatus" "EncounterLifecycleStatus" NOT NULL,
  "stateVersion" INTEGER NOT NULL,
  "currentTick" BIGINT NOT NULL,
  "stopReason" "EncounterStopReason",
  "completionCandidate" "EncounterCompletionCandidate",
  "snapshotSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "stateSnapshot" JSONB NOT NULL,
  "stateHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "Encounter_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Encounter_encounterRef_check" CHECK (
    char_length("encounterRef") BETWEEN 1 AND 160
    AND "encounterRef" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
    AND "encounterRef" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "Encounter_stateVersion_check" CHECK ("stateVersion" >= 1),
  CONSTRAINT "Encounter_currentTick_check" CHECK ("currentTick" BETWEEN 0 AND 1000000000),
  CONSTRAINT "Encounter_snapshotSchemaVersion_check" CHECK ("snapshotSchemaVersion" = 1),
  CONSTRAINT "Encounter_stateSnapshot_check" CHECK (
    jsonb_typeof("stateSnapshot") = 'object'
    AND octet_length("stateSnapshot"::text) <= 1048576
  ),
  CONSTRAINT "Encounter_stateHash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "EncounterParticipant" (
  "id" UUID NOT NULL,
  "encounterId" UUID NOT NULL,
  "actorId" UUID,
  "actorRef" TEXT NOT NULL,
  "bindingKind" "EncounterParticipantBindingKind" NOT NULL,
  "ephemeralKind" "EncounterEphemeralKind",
  "initialMechanicsStateVersion" INTEGER,
  "initialInventoryStateVersion" INTEGER,
  "initialEffectsStateVersion" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EncounterParticipant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EncounterParticipant_actorRef_check" CHECK (
    char_length("actorRef") BETWEEN 1 AND 160
    AND "actorRef" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
    AND "actorRef" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "EncounterParticipant_binding_check" CHECK (
    (
      "bindingKind" = 'PERSISTED_ACTOR'
      AND "actorId" IS NOT NULL
      AND "ephemeralKind" IS NULL
      AND "initialMechanicsStateVersion" >= 1
      AND "initialInventoryStateVersion" >= 1
      AND "initialEffectsStateVersion" >= 1
    )
    OR (
      "bindingKind" = 'EPHEMERAL'
      AND "actorId" IS NULL
      AND "ephemeralKind" IS NOT NULL
      AND "initialMechanicsStateVersion" IS NULL
      AND "initialInventoryStateVersion" IS NULL
      AND "initialEffectsStateVersion" IS NULL
    )
  )
);

CREATE TABLE "EncounterOperation" (
  "id" UUID NOT NULL,
  "encounterId" UUID NOT NULL,
  "idempotencyRecordId" UUID NOT NULL,
  "operation" "EncounterOperationKind" NOT NULL,
  "previousStateVersion" INTEGER NOT NULL,
  "nextStateVersion" INTEGER NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "beforeStateHash" CHAR(64) NOT NULL,
  "afterStateHash" CHAR(64) NOT NULL,
  "stopReason" "EncounterStopReason",
  "resultSummary" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EncounterOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EncounterOperation_previousStateVersion_check" CHECK ("previousStateVersion" >= 1),
  CONSTRAINT "EncounterOperation_stateVersionSequence_check" CHECK ("nextStateVersion" = "previousStateVersion" + 1),
  CONSTRAINT "EncounterOperation_inputHash_check" CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EncounterOperation_beforeStateHash_check" CHECK ("beforeStateHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EncounterOperation_afterStateHash_check" CHECK ("afterStateHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EncounterOperation_resultSummary_check" CHECK (jsonb_typeof("resultSummary") = 'object')
);

CREATE TABLE "EncounterRoll" (
  "id" UUID NOT NULL,
  "encounterId" UUID NOT NULL,
  "encounterOperationId" UUID NOT NULL,
  "rollRef" TEXT NOT NULL,
  "kind" "EncounterRollKind" NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "actionRef" TEXT,
  "sourceActorRef" TEXT NOT NULL,
  "targetActorRef" TEXT,
  "targetOrdinal" INTEGER,
  "inputHash" CHAR(64) NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "resultHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EncounterRoll_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EncounterRoll_rollRef_check" CHECK (
    char_length("rollRef") BETWEEN 1 AND 512
    AND "rollRef" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
  ),
  CONSTRAINT "EncounterRoll_actionRef_check" CHECK (
    "actionRef" IS NULL OR (
      char_length("actionRef") BETWEEN 1 AND 512
      AND "actionRef" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
    )
  ),
  CONSTRAINT "EncounterRoll_sourceActorRef_check" CHECK (
    char_length("sourceActorRef") BETWEEN 1 AND 160
    AND "sourceActorRef" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
  ),
  CONSTRAINT "EncounterRoll_targetActorRef_check" CHECK (
    "targetActorRef" IS NULL OR (
      char_length("targetActorRef") BETWEEN 1 AND 160
      AND "targetActorRef" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'
    )
  ),
  CONSTRAINT "EncounterRoll_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "EncounterRoll_targetOrdinal_check" CHECK ("targetOrdinal" IS NULL OR "targetOrdinal" >= 0),
  CONSTRAINT "EncounterRoll_inputHash_check" CHECK ("inputHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "EncounterRoll_resultSnapshot_check" CHECK (jsonb_typeof("resultSnapshot") = 'object'),
  CONSTRAINT "EncounterRoll_resultHash_check" CHECK ("resultHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "Encounter_campaignId_encounterRef_key" ON "Encounter"("campaignId", "encounterRef");
CREATE UNIQUE INDEX "Encounter_one_open_per_campaign_key" ON "Encounter"("campaignId")
  WHERE "lifecycleStatus" IN ('AWAITING_INTENT', 'AWAITING_REACTION', 'PROCESSING_PAUSED', 'COMPLETION_PENDING');
CREATE INDEX "Encounter_campaignId_lifecycleStatus_idx" ON "Encounter"("campaignId", "lifecycleStatus");
CREATE INDEX "Encounter_rulesetVersionId_idx" ON "Encounter"("rulesetVersionId");
CREATE UNIQUE INDEX "EncounterParticipant_encounterId_actorRef_key" ON "EncounterParticipant"("encounterId", "actorRef");
CREATE UNIQUE INDEX "EncounterParticipant_encounterId_actorId_key" ON "EncounterParticipant"("encounterId", "actorId")
  WHERE "actorId" IS NOT NULL;
CREATE INDEX "EncounterParticipant_actorId_idx" ON "EncounterParticipant"("actorId");
CREATE UNIQUE INDEX "EncounterOperation_idempotencyRecordId_key" ON "EncounterOperation"("idempotencyRecordId");
CREATE UNIQUE INDEX "EncounterOperation_encounterId_nextStateVersion_key" ON "EncounterOperation"("encounterId", "nextStateVersion");
CREATE UNIQUE INDEX "EncounterOperation_id_encounterId_key" ON "EncounterOperation"("id", "encounterId");
CREATE INDEX "EncounterOperation_encounterId_createdAt_idx" ON "EncounterOperation"("encounterId", "createdAt");
CREATE UNIQUE INDEX "EncounterRoll_encounterId_rollRef_key" ON "EncounterRoll"("encounterId", "rollRef");
CREATE INDEX "EncounterRoll_encounterOperationId_encounterId_idx" ON "EncounterRoll"("encounterOperationId", "encounterId");

ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Encounter" ADD CONSTRAINT "Encounter_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncounterParticipant" ADD CONSTRAINT "EncounterParticipant_encounterId_fkey"
  FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncounterParticipant" ADD CONSTRAINT "EncounterParticipant_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncounterOperation" ADD CONSTRAINT "EncounterOperation_encounterId_fkey"
  FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncounterOperation" ADD CONSTRAINT "EncounterOperation_idempotencyRecordId_fkey"
  FOREIGN KEY ("idempotencyRecordId") REFERENCES "IdempotencyRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncounterRoll" ADD CONSTRAINT "EncounterRoll_encounterId_fkey"
  FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncounterRoll" ADD CONSTRAINT "EncounterRoll_encounterOperationId_encounterId_fkey"
  FOREIGN KEY ("encounterOperationId", "encounterId") REFERENCES "EncounterOperation"("id", "encounterId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "phase1la_immutable_record"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = TG_TABLE_NAME || ' is append-only and cannot be updated or deleted';
END
$function$;

CREATE TRIGGER "EncounterParticipant_reject_update" BEFORE UPDATE ON "EncounterParticipant"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();
CREATE TRIGGER "EncounterParticipant_reject_delete" BEFORE DELETE ON "EncounterParticipant"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();
CREATE TRIGGER "EncounterOperation_reject_update" BEFORE UPDATE ON "EncounterOperation"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();
CREATE TRIGGER "EncounterOperation_reject_delete" BEFORE DELETE ON "EncounterOperation"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();
CREATE TRIGGER "EncounterRoll_reject_update" BEFORE UPDATE ON "EncounterRoll"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();
CREATE TRIGGER "EncounterRoll_reject_delete" BEFORE DELETE ON "EncounterRoll"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();

CREATE FUNCTION "encounter_validate_ruleset"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Campaign" campaign
    WHERE campaign."id" = NEW."campaignId"
      AND campaign."rulesetVersionId" = NEW."rulesetVersionId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Encounter ruleset must match its Campaign';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "Encounter_validate_ruleset" BEFORE INSERT OR UPDATE OF "campaignId", "rulesetVersionId" ON "Encounter"
  FOR EACH ROW EXECUTE FUNCTION "encounter_validate_ruleset"();

CREATE FUNCTION "encounter_participant_validate_actor"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."bindingKind" = 'PERSISTED_ACTOR' AND NOT EXISTS (
    SELECT 1
    FROM "Actor" actor
    JOIN "Encounter" encounter ON encounter."id" = NEW."encounterId"
    WHERE actor."id" = NEW."actorId" AND actor."campaignId" = encounter."campaignId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EncounterParticipant Actor must belong to the Encounter Campaign';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "EncounterParticipant_validate_actor" BEFORE INSERT ON "EncounterParticipant"
  FOR EACH ROW EXECUTE FUNCTION "encounter_participant_validate_actor"();

DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Encounter', 'EncounterParticipant', 'EncounterOperation', 'EncounterRoll']
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
-- remove Phase 1L-A triggers/functions, FKs/indexes/tables and enums in dependency
-- order. Never edit this applied migration or delete encounter audit data as rollback.
