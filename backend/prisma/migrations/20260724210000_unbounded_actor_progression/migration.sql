-- Phase 1M-B RC1.2 keeps published RC1.1 rows and campaign bindings intact.
-- The database envelope is widened; ruleset-specific limits remain enforced by
-- the transactional application layer.
ALTER TABLE "Actor"
  DROP CONSTRAINT "Actor_level_check",
  ADD CONSTRAINT "Actor_level_check" CHECK ("level" BETWEEN 1 AND 20722);

ALTER TABLE "ActorAttribute"
  DROP CONSTRAINT "ActorAttribute_baseValue_check",
  DROP CONSTRAINT "ActorAttribute_effective_cap_check",
  ADD CONSTRAINT "ActorAttribute_baseValue_check" CHECK ("baseValue" BETWEEN 4 AND 16);

ALTER TABLE "GameEvent"
  ADD COLUMN "xpSourceType" TEXT,
  ADD COLUMN "xpSourceRef" TEXT,
  ADD CONSTRAINT "GameEvent_xp_source_pair_check" CHECK (
    ("xpSourceType" IS NULL AND "xpSourceRef" IS NULL)
    OR ("xpSourceType" IS NOT NULL AND "xpSourceRef" IS NOT NULL)
  );

CREATE UNIQUE INDEX "GameEvent_actorId_xpSourceType_xpSourceRef_key"
  ON "GameEvent"("actorId", "xpSourceType", "xpSourceRef")
  WHERE "actorId" IS NOT NULL
    AND "xpSourceType" IS NOT NULL
    AND "xpSourceRef" IS NOT NULL;

-- Existing actors, campaigns, ruleset publications and hashes are not updated.
-- Applying over incompatible local data fails explicitly at the new base check.
-- Rollback requires proving no level > 20, no effective attribute > 30 and no
-- semantic XP-source rows exist before restoring the previous constraints.
