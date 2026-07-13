-- Phase 1F changes content identity and ActorContent ownership. Functional
-- content is intentionally not converted, deleted or rewritten.
DO $clean_slate$
BEGIN
  IF EXISTS (SELECT 1 FROM "ContentDefinition" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ActorContent" LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Phase 1F migration requires empty ContentDefinition and ActorContent tables; clear functional data before rollout';
  END IF;
END
$clean_slate$;

-- AlterEnum
ALTER TYPE "ContentType" ADD VALUE 'CLOTHING';
ALTER TYPE "ContentType" ADD VALUE 'CONSUMABLE';

-- CreateEnum
CREATE TYPE "ContentProfileMode" AS ENUM ('MECHANICAL', 'NARRATIVE', 'GENERIC');

-- CreateTable
CREATE TABLE "ContentProfileVersion" (
  "id" UUID NOT NULL,
  "rulesetVersionId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "configHash" CHAR(64) NOT NULL,
  "configSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContentProfileVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentProfileVersion_schemaVersion_check" CHECK ("schemaVersion" > 0),
  CONSTRAINT "ContentProfileVersion_configHash_check" CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ContentProfileVersion_configSnapshot_check" CHECK (jsonb_typeof("configSnapshot") = 'object')
);

-- CreateTable
CREATE TABLE "ContentVersion" (
  "id" UUID NOT NULL,
  "contentDefinitionId" UUID NOT NULL,
  "rulesetVersionId" UUID NOT NULL,
  "contentProfileVersionId" UUID NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "profileMode" "ContentProfileMode" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "profile" JSONB,
  "presentation" JSONB NOT NULL DEFAULT '{}',
  "tags" JSONB NOT NULL DEFAULT '[]',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "contentHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentVersion_versionNumber_check" CHECK ("versionNumber" > 0),
  CONSTRAINT "ContentVersion_schemaVersion_check" CHECK ("schemaVersion" > 0),
  CONSTRAINT "ContentVersion_contentHash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ContentVersion_profile_check" CHECK (
    ("profileMode" = 'GENERIC' AND "profile" IS NULL)
    OR ("profileMode" IN ('MECHANICAL', 'NARRATIVE') AND jsonb_typeof("profile") = 'object')
  ),
  CONSTRAINT "ContentVersion_presentation_check" CHECK (jsonb_typeof("presentation") = 'object'),
  CONSTRAINT "ContentVersion_tags_check" CHECK (jsonb_typeof("tags") = 'array'),
  CONSTRAINT "ContentVersion_metadata_check" CHECK (jsonb_typeof("metadata") = 'object')
);

-- AlterTable
ALTER TABLE "ContentDefinition"
  DROP COLUMN "name",
  DROP COLUMN "description",
  DROP COLUMN "mechanics",
  DROP COLUMN "requirements",
  DROP COLUMN "presentation",
  DROP COLUMN "tags",
  DROP COLUMN "schemaVersion",
  DROP COLUMN "metadata";

-- AlterTable
ALTER TABLE "ActorContent" ADD COLUMN "contentVersionId" UUID NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ContentProfileVersion_code_key" ON "ContentProfileVersion"("code");
CREATE INDEX "ContentProfileVersion_rulesetVersionId_idx" ON "ContentProfileVersion"("rulesetVersionId");
CREATE UNIQUE INDEX "ContentVersion_contentDefinitionId_versionNumber_key" ON "ContentVersion"("contentDefinitionId", "versionNumber");
CREATE UNIQUE INDEX "ContentVersion_contentDefinitionId_contentHash_key" ON "ContentVersion"("contentDefinitionId", "contentHash");
CREATE UNIQUE INDEX "ContentVersion_id_contentDefinitionId_key" ON "ContentVersion"("id", "contentDefinitionId");
CREATE INDEX "ContentVersion_contentDefinitionId_versionNumber_idx" ON "ContentVersion"("contentDefinitionId", "versionNumber" DESC);
CREATE INDEX "ContentVersion_rulesetVersionId_idx" ON "ContentVersion"("rulesetVersionId");
CREATE INDEX "ContentVersion_contentProfileVersionId_idx" ON "ContentVersion"("contentProfileVersionId");
CREATE INDEX "ActorContent_contentVersionId_contentDefinitionId_idx" ON "ActorContent"("contentVersionId", "contentDefinitionId");

-- AddForeignKey
ALTER TABLE "ContentProfileVersion" ADD CONSTRAINT "ContentProfileVersion_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_contentDefinitionId_fkey"
  FOREIGN KEY ("contentDefinitionId") REFERENCES "ContentDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_contentProfileVersionId_fkey"
  FOREIGN KEY ("contentProfileVersionId") REFERENCES "ContentProfileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActorContent" ADD CONSTRAINT "ActorContent_contentVersionId_contentDefinitionId_fkey"
  FOREIGN KEY ("contentVersionId", "contentDefinitionId") REFERENCES "ContentVersion"("id", "contentDefinitionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Published profile and content versions are immutable. Administrative reset
-- routines must account for these triggers explicitly; no public bypass exists.
CREATE FUNCTION "content_profile_version_block_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentProfileVersion is immutable and cannot be updated or deleted';
END
$function$;

CREATE TRIGGER "ContentProfileVersion_reject_update"
BEFORE UPDATE ON "ContentProfileVersion"
FOR EACH ROW EXECUTE FUNCTION "content_profile_version_block_mutation"();
CREATE TRIGGER "ContentProfileVersion_reject_delete"
BEFORE DELETE ON "ContentProfileVersion"
FOR EACH ROW EXECUTE FUNCTION "content_profile_version_block_mutation"();

CREATE FUNCTION "content_version_block_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentVersion is immutable and cannot be updated or deleted';
END
$function$;

CREATE TRIGGER "ContentVersion_reject_update"
BEFORE UPDATE ON "ContentVersion"
FOR EACH ROW EXECUTE FUNCTION "content_version_block_mutation"();
CREATE TRIGGER "ContentVersion_reject_delete"
BEFORE DELETE ON "ContentVersion"
FOR EACH ROW EXECUTE FUNCTION "content_version_block_mutation"();

CREATE FUNCTION "content_definition_guard_identity_change"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."worldId" IS DISTINCT FROM OLD."worldId"
     OR NEW."campaignId" IS DISTINCT FROM OLD."campaignId"
     OR NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."contentType" IS DISTINCT FROM OLD."contentType" THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentDefinition identity fields are immutable';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER "ContentDefinition_reject_identity_change"
BEFORE UPDATE OF "worldId", "campaignId", "code", "contentType" ON "ContentDefinition"
FOR EACH ROW EXECUTE FUNCTION "content_definition_guard_identity_change"();

-- Preserve the Node-owned RLS/revocation posture.
DO $security$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ContentProfileVersion', 'ContentVersion']
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

-- Structural rollback is only safe before compatible functional content exists:
-- drop the new triggers/functions, composite ActorContent FK/column, new FKs and
-- indexes, ContentVersion, ContentProfileVersion and ContentProfileMode, restore
-- the removed columns, then remove the added ContentType values through a new reviewed corrective migration.
-- Published migrations are never edited and
-- functional data is never deleted silently.
