-- Phase 1C is intentionally clean-slate for functional data. This guard runs
-- before incompatible DDL and never deletes or rewrites existing rows.
DO $clean_slate$
BEGIN
  IF EXISTS (SELECT 1 FROM "World" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "Campaign" LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Phase 1C migration requires empty World and Campaign tables; clear functional data before rollout';
  END IF;
END
$clean_slate$;

-- CreateTable
CREATE TABLE "Ruleset" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ruleset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RulesetVersion" (
    "id" UUID NOT NULL,
    "rulesetId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "configHash" CHAR(64) NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RulesetVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RulesetVersion_schemaVersion_check" CHECK ("schemaVersion" > 0),
    CONSTRAINT "RulesetVersion_configHash_check" CHECK ("configHash" ~ '^[0-9a-f]{64}$')
);

-- AlterTable
ALTER TABLE "World" ADD COLUMN "defaultRulesetVersionId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "rulesetVersionId" UUID NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Ruleset_code_key" ON "Ruleset"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RulesetVersion_code_key" ON "RulesetVersion"("code");

-- CreateIndex
CREATE INDEX "RulesetVersion_rulesetId_idx" ON "RulesetVersion"("rulesetId");

-- CreateIndex
CREATE INDEX "World_defaultRulesetVersionId_idx" ON "World"("defaultRulesetVersionId");

-- CreateIndex
CREATE INDEX "Campaign_rulesetVersionId_idx" ON "Campaign"("rulesetVersionId");

-- AddForeignKey
ALTER TABLE "RulesetVersion" ADD CONSTRAINT "RulesetVersion_rulesetId_fkey"
  FOREIGN KEY ("rulesetId") REFERENCES "Ruleset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "World" ADD CONSTRAINT "World_defaultRulesetVersionId_fkey"
  FOREIGN KEY ("defaultRulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RulesetVersion rows are published records. Runtime mutations must create a
-- new version instead of changing or deleting an existing one.
CREATE FUNCTION "ruleset_version_block_update"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'RulesetVersion is immutable and cannot be updated';
END
$function$;

CREATE FUNCTION "ruleset_version_block_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'RulesetVersion is immutable and cannot be deleted';
END
$function$;

CREATE TRIGGER "RulesetVersion_reject_update"
BEFORE UPDATE ON "RulesetVersion"
FOR EACH ROW EXECUTE FUNCTION "ruleset_version_block_update"();

CREATE TRIGGER "RulesetVersion_reject_delete"
BEFORE DELETE ON "RulesetVersion"
FOR EACH ROW EXECUTE FUNCTION "ruleset_version_block_delete"();

-- Campaigns copy the World default at creation and may never move to another
-- published ruleset version afterwards. Same-value updates remain valid.
CREATE FUNCTION "campaign_guard_ruleset_version_change"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."rulesetVersionId" IS DISTINCT FROM OLD."rulesetVersionId" THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Campaign rulesetVersionId is immutable after creation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "Campaign_reject_ruleset_version_change"
BEFORE UPDATE OF "rulesetVersionId" ON "Campaign"
FOR EACH ROW EXECUTE FUNCTION "campaign_guard_ruleset_version_change"();

-- Keep the new Node-owned tables under the same RLS/revocation posture as the
-- existing platform tables. The dedicated owner remains the runtime role.
DO $security$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Ruleset', 'RulesetVersion']
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

-- Structural rollback plan (only before compatible functional data exists):
-- drop the three triggers and their functions; drop the three new foreign keys
-- and FK indexes; drop Campaign.rulesetVersionId and
-- World.defaultRulesetVersionId; then drop RulesetVersion and Ruleset. Prisma
-- production rollback must be delivered as a new reviewed corrective migration,
-- never by editing an already-applied migration or deleting functional data.
