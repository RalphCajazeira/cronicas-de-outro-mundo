-- Phase 1M-A adds encounter-owned effects and an append-only terminal consequence ledger.
-- Existing encounter effects and terminal encounters remain valid without backfill.
CREATE TYPE "EncounterOutcome" AS ENUM (
  'PARTY_VICTORY', 'PARTY_DEFEAT', 'STALEMATE', 'CANCELLED'
);

ALTER TABLE "ActiveEffect" ADD COLUMN "originEncounterId" UUID;

ALTER TABLE "ActiveEffect"
  ADD CONSTRAINT "ActiveEffect_originEncounterId_fkey"
  FOREIGN KEY ("originEncounterId") REFERENCES "Encounter"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ActiveEffect_originEncounter_duration_check" CHECK (
    "originEncounterId" IS NULL OR "durationType" = 'ENCOUNTER'
  );

CREATE INDEX "ActiveEffect_originEncounterId_targetActorId_idx"
  ON "ActiveEffect"("originEncounterId", "targetActorId");

CREATE FUNCTION "active_effect_validate_encounter_origin"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE origin_lifecycle "EncounterLifecycleStatus";
BEGIN
  IF NEW."durationType" <> 'ENCOUNTER' AND NEW."originEncounterId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Only ENCOUNTER effects may reference an origin Encounter';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."durationType" = 'ENCOUNTER' AND (
    OLD."durationType" IS DISTINCT FROM NEW."durationType"
    OR OLD."originEncounterId" IS DISTINCT FROM NEW."originEncounterId"
    OR OLD."targetActorId" IS DISTINCT FROM NEW."targetActorId"
    OR OLD."sourceActorId" IS DISTINCT FROM NEW."sourceActorId"
    OR OLD."effectRef" IS DISTINCT FROM NEW."effectRef"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect Encounter ownership identity is immutable';
  END IF;

  IF NEW."durationType" = 'ENCOUNTER' AND NEW."originEncounterId" IS NULL THEN
    IF TG_OP = 'INSERT'
      OR OLD."durationType" <> 'ENCOUNTER'
      OR OLD."originEncounterId" IS NOT NULL
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'New ENCOUNTER effects require an origin Encounter';
    END IF;
    -- A pre-migration ENCOUNTER effect may remain unowned, but may never be adopted.
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."originEncounterId" IS DISTINCT FROM NEW."originEncounterId"
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect Encounter ownership is immutable';
  END IF;

  IF NEW."originEncounterId" IS NOT NULL THEN
    SELECT encounter."lifecycleStatus" INTO origin_lifecycle
    FROM "Encounter" encounter
    WHERE encounter."id" = NEW."originEncounterId";

    IF origin_lifecycle IS NULL
      OR origin_lifecycle NOT IN (
        'AWAITING_INTENT', 'AWAITING_REACTION', 'PROCESSING_PAUSED', 'COMPLETION_PENDING'
      )
      OR NOT EXISTS (
        SELECT 1 FROM "EncounterParticipant" participant
        WHERE participant."encounterId" = NEW."originEncounterId"
          AND participant."bindingKind" = 'PERSISTED_ACTOR'
          AND participant."actorId" = NEW."targetActorId"
      )
      OR NOT EXISTS (
        SELECT 1 FROM "EncounterParticipant" participant
        WHERE participant."encounterId" = NEW."originEncounterId"
          AND participant."bindingKind" = 'PERSISTED_ACTOR'
          AND participant."actorId" = NEW."sourceActorId"
      )
    THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActiveEffect Encounter ownership failed integrity validation';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER "ActiveEffect_validate_encounter_origin"
  BEFORE INSERT OR UPDATE OF "durationType", "originEncounterId", "targetActorId", "sourceActorId", "effectRef"
  ON "ActiveEffect"
  FOR EACH ROW EXECUTE FUNCTION "active_effect_validate_encounter_origin"();

CREATE TABLE "EncounterConsequence" (
  "id" UUID NOT NULL,
  "encounterId" UUID NOT NULL,
  "encounterOperationId" UUID NOT NULL,
  "gameEventId" UUID NOT NULL,
  "consequenceSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "rewardPolicyVersion" TEXT,
  "outcome" "EncounterOutcome" NOT NULL,
  "resultSummary" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EncounterConsequence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EncounterConsequence_schemaVersion_check" CHECK ("consequenceSchemaVersion" = 1),
  CONSTRAINT "EncounterConsequence_rewardPolicy_check" CHECK ("rewardPolicyVersion" IS NULL),
  CONSTRAINT "EncounterConsequence_resultSummary_check" CHECK (
    jsonb_typeof("resultSummary") = 'object'
    AND "resultSummary" ->> 'schemaVersion' = '1'
    AND "resultSummary" ->> 'outcome' = lower("outcome"::text)
    AND "resultSummary" ?& ARRAY['schemaVersion', 'outcome', 'actors', 'removedEncounterEffects', 'event']
    AND "resultSummary" - ARRAY['schemaVersion', 'outcome', 'actors', 'removedEncounterEffects', 'event'] = '{}'::jsonb
    AND octet_length("resultSummary"::text) <= 2097152
  )
);

CREATE UNIQUE INDEX "EncounterConsequence_encounterId_key"
  ON "EncounterConsequence"("encounterId");
CREATE UNIQUE INDEX "EncounterConsequence_encounterOperationId_key"
  ON "EncounterConsequence"("encounterOperationId");
CREATE UNIQUE INDEX "EncounterConsequence_gameEventId_key"
  ON "EncounterConsequence"("gameEventId");
CREATE UNIQUE INDEX "EncounterConsequence_encounterOperationId_encounterId_key"
  ON "EncounterConsequence"("encounterOperationId", "encounterId");
CREATE INDEX "EncounterConsequence_outcome_createdAt_idx"
  ON "EncounterConsequence"("outcome", "createdAt");

ALTER TABLE "EncounterConsequence"
  ADD CONSTRAINT "EncounterConsequence_encounterId_fkey"
    FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EncounterConsequence_encounterOperationId_encounterId_fkey"
    FOREIGN KEY ("encounterOperationId", "encounterId")
    REFERENCES "EncounterOperation"("id", "encounterId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EncounterConsequence_gameEventId_fkey"
    FOREIGN KEY ("gameEventId") REFERENCES "GameEvent"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "EncounterConsequence_reject_update"
  BEFORE UPDATE ON "EncounterConsequence"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();
CREATE TRIGGER "EncounterConsequence_reject_delete"
  BEFORE DELETE ON "EncounterConsequence"
  FOR EACH ROW EXECUTE FUNCTION "phase1la_immutable_record"();

CREATE FUNCTION "encounter_consequence_validate"(consequence_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $function$
DECLARE row_data RECORD;
DECLARE expected_event_type TEXT;
DECLARE expected_outcome "EncounterOutcome";
DECLARE expected_operation "EncounterOperationKind";
BEGIN
  SELECT consequence.*, encounter."campaignId", encounter."lifecycleStatus",
    encounter."completionCandidate", operation."operation", operation."resultSummary" AS operation_summary,
    encounter."stateVersion" AS encounter_state_version, encounter."stateHash" AS encounter_state_hash,
    operation."nextStateVersion" AS operation_state_version, operation."afterStateHash" AS operation_state_hash,
    event."campaignId" AS event_campaign_id, event."eventType",
    event."idempotencyKey" AS event_idempotency_key, event."payload" AS event_payload
  INTO row_data
  FROM "EncounterConsequence" consequence
  JOIN "Encounter" encounter ON encounter."id" = consequence."encounterId"
  JOIN "EncounterOperation" operation
    ON operation."id" = consequence."encounterOperationId"
    AND operation."encounterId" = consequence."encounterId"
  JOIN "GameEvent" event ON event."id" = consequence."gameEventId"
  WHERE consequence."id" = consequence_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Encounter consequence is incomplete';
  END IF;

  IF row_data."lifecycleStatus" = 'COMPLETED' THEN
    expected_operation := 'CONFIRM_COMPLETION';
    expected_outcome := CASE row_data."completionCandidate"
      WHEN 'PARTY_VICTORY_CANDIDATE' THEN 'PARTY_VICTORY'::"EncounterOutcome"
      WHEN 'HOSTILE_VICTORY_CANDIDATE' THEN 'PARTY_DEFEAT'::"EncounterOutcome"
      WHEN 'STALEMATE_CANDIDATE' THEN 'STALEMATE'::"EncounterOutcome"
      ELSE NULL
    END;
  ELSIF row_data."lifecycleStatus" = 'CANCELLED' THEN
    expected_operation := 'CANCEL';
    expected_outcome := CASE row_data."completionCandidate"
      WHEN 'CANCELLED' THEN 'CANCELLED'::"EncounterOutcome"
      ELSE NULL
    END;
  ELSE
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Encounter consequence requires a completed or cancelled Encounter';
  END IF;

  expected_event_type := CASE expected_outcome
    WHEN 'PARTY_VICTORY' THEN 'encounter-completed'
    WHEN 'PARTY_DEFEAT' THEN 'encounter-defeated'
    WHEN 'STALEMATE' THEN 'encounter-stalemate'
    WHEN 'CANCELLED' THEN 'encounter-cancelled'
  END;

  IF expected_outcome IS NULL
    OR row_data."outcome" <> expected_outcome
    OR row_data."operation" <> expected_operation
    OR row_data.operation_state_version <> row_data.encounter_state_version
    OR row_data.operation_state_hash <> row_data.encounter_state_hash
    OR row_data.event_campaign_id <> row_data."campaignId"
    OR row_data."eventType" <> expected_event_type
    OR row_data.event_idempotency_key IS DISTINCT FROM ('encounter-outcome:' || row_data."encounterId"::text || ':v1')
    OR jsonb_typeof(row_data.event_payload) IS DISTINCT FROM 'object'
    OR row_data.event_payload ->> 'schemaVersion' IS DISTINCT FROM '1'
    OR row_data.event_payload ->> 'outcome' IS DISTINCT FROM lower(expected_outcome::text)
    OR row_data.operation_summary -> 'consequencesSummary' IS DISTINCT FROM row_data."resultSummary"
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Encounter consequence failed terminal integrity validation';
  END IF;
END
$function$;

CREATE FUNCTION "encounter_terminal_requires_consequence"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE consequence_id UUID;
BEGIN
  SELECT consequence."id" INTO consequence_id
  FROM "EncounterConsequence" consequence
  WHERE consequence."encounterId" = NEW."id";
  IF consequence_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Terminal Encounter requires an EncounterConsequence in the same transaction';
  END IF;
  PERFORM "encounter_consequence_validate"(consequence_id);
  RETURN NULL;
END
$function$;

CREATE FUNCTION "encounter_terminal_reject_authority_update"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."lifecycleStatus" IN ('COMPLETED', 'CANCELLED') AND (
    OLD."campaignId" IS DISTINCT FROM NEW."campaignId"
    OR OLD."rulesetVersionId" IS DISTINCT FROM NEW."rulesetVersionId"
    OR OLD."encounterRef" IS DISTINCT FROM NEW."encounterRef"
    OR OLD."lifecycleStatus" IS DISTINCT FROM NEW."lifecycleStatus"
    OR OLD."stateVersion" IS DISTINCT FROM NEW."stateVersion"
    OR OLD."currentTick" IS DISTINCT FROM NEW."currentTick"
    OR OLD."stopReason" IS DISTINCT FROM NEW."stopReason"
    OR OLD."completionCandidate" IS DISTINCT FROM NEW."completionCandidate"
    OR OLD."snapshotSchemaVersion" IS DISTINCT FROM NEW."snapshotSchemaVersion"
    OR OLD."stateSnapshot" IS DISTINCT FROM NEW."stateSnapshot"
    OR OLD."stateHash" IS DISTINCT FROM NEW."stateHash"
    OR OLD."closedAt" IS DISTINCT FROM NEW."closedAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Terminal Encounter authority is immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "Encounter_terminal_reject_authority_update"
  BEFORE UPDATE ON "Encounter"
  FOR EACH ROW EXECUTE FUNCTION "encounter_terminal_reject_authority_update"();

CREATE CONSTRAINT TRIGGER "Encounter_terminal_requires_consequence"
  AFTER UPDATE ON "Encounter"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (
    NEW."lifecycleStatus" IN ('COMPLETED', 'CANCELLED')
    AND (
      OLD."lifecycleStatus" IN ('AWAITING_INTENT', 'AWAITING_REACTION', 'PROCESSING_PAUSED', 'COMPLETION_PENDING')
      OR OLD."lifecycleStatus" IS DISTINCT FROM NEW."lifecycleStatus"
    )
  )
  EXECUTE FUNCTION "encounter_terminal_requires_consequence"();

CREATE CONSTRAINT TRIGGER "Encounter_insert_terminal_requires_consequence"
  AFTER INSERT ON "Encounter"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."lifecycleStatus" IN ('COMPLETED', 'CANCELLED'))
  EXECUTE FUNCTION "encounter_terminal_requires_consequence"();

CREATE FUNCTION "encounter_consequence_reject_invalid"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM "encounter_consequence_validate"(NEW."id");
  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER "EncounterConsequence_validate"
  AFTER INSERT ON "EncounterConsequence"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "encounter_consequence_reject_invalid"();

ALTER TABLE "EncounterConsequence" ENABLE ROW LEVEL SECURITY;
DO $security$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE "EncounterConsequence" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE "EncounterConsequence" FROM authenticated;
  END IF;
END
$security$;

-- Rollback is an additive corrective migration. Never remove confirmed consequence data.
