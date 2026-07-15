-- Phase 1L-B corrects only the EncounterOperation version transition checks.
-- No data is rewritten and no external database is accessed.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "EncounterOperation"
    WHERE (
      "operation" = 'CREATE'
      AND ("previousStateVersion" <> 0 OR "nextStateVersion" <> 1)
    ) OR (
      "operation" <> 'CREATE'
      AND ("previousStateVersion" < 1 OR "nextStateVersion" <= "previousStateVersion")
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'EncounterOperation contains version transitions incompatible with Phase 1L-B; manual data migration is required';
  END IF;
END
$preflight$;

ALTER TABLE "EncounterOperation"
  DROP CONSTRAINT "EncounterOperation_previousStateVersion_check",
  DROP CONSTRAINT "EncounterOperation_stateVersionSequence_check";

ALTER TABLE "EncounterOperation"
  ADD CONSTRAINT "EncounterOperation_previousStateVersion_check" CHECK (
    ("operation" = 'CREATE' AND "previousStateVersion" = 0)
    OR ("operation" <> 'CREATE' AND "previousStateVersion" >= 1)
  ),
  ADD CONSTRAINT "EncounterOperation_stateVersionSequence_check" CHECK (
    ("operation" = 'CREATE' AND "nextStateVersion" = 1)
    OR ("operation" <> 'CREATE' AND "nextStateVersion" > "previousStateVersion")
  );
