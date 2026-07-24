ALTER TYPE "EncounterRollKind" ADD VALUE 'STEALTH';
ALTER TYPE "EncounterRollKind" ADD VALUE 'DETECTION';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ActorDerivedSnapshot" LIMIT 1) THEN
    RAISE EXCEPTION
      'RC1.3 stealth/detection migration requires an empty functional database; reset the local or staging database explicitly before applying';
  END IF;
END
$$;

ALTER TABLE "ActorDerivedSnapshot"
  ADD COLUMN "stealth" INTEGER NOT NULL,
  ADD COLUMN "detection" INTEGER NOT NULL;

ALTER TABLE "ActorDerivedSnapshot"
  ADD CONSTRAINT "ActorDerivedSnapshot_stealth_detection_check"
  CHECK (
    "stealth" >= 0
    AND "detection" >= 0
  );

ALTER TABLE "Encounter"
  DROP CONSTRAINT "Encounter_snapshotSchemaVersion_check",
  ADD CONSTRAINT "Encounter_snapshotSchemaVersion_check"
  CHECK ("snapshotSchemaVersion" IN (1, 2));
