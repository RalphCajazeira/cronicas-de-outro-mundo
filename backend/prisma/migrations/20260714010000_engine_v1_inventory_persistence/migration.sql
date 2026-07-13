-- Phase 1H deliberately replaces conceptual quantity/equipment fields with a
-- physical inventory. No functional content is converted, deleted or copied.
DO $clean_slate$
BEGIN
  IF EXISTS (SELECT 1 FROM "ActorContent" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ContentDefinition" LIMIT 1)
     OR EXISTS (SELECT 1 FROM "ContentVersion" LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Phase 1H migration requires empty ActorContent, ContentDefinition and ContentVersion tables; clear functional data before rollout';
  END IF;
END
$clean_slate$;

CREATE TYPE "InventoryEntryKind" AS ENUM ('INSTANCE', 'STACK');
CREATE TYPE "InventoryInstanceLifecycle" AS ENUM ('AVAILABLE', 'RESERVED', 'CONSUMED', 'DESTROYED');
CREATE TYPE "ActorEquipmentSlotRef" AS ENUM (
  'MAIN_HAND', 'OFF_HAND', 'HEAD', 'CHEST', 'HANDS', 'LEGS', 'FEET', 'BODY', 'ACCESSORY_1', 'ACCESSORY_2'
);

CREATE TABLE "InventoryRulesVersion" (
  "id" UUID NOT NULL,
  "rulesetVersionId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "configHash" CHAR(64) NOT NULL,
  "configSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryRulesVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryRulesVersion_schemaVersion_check" CHECK ("schemaVersion" > 0),
  CONSTRAINT "InventoryRulesVersion_configHash_check" CHECK ("configHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "InventoryRulesVersion_configSnapshot_check" CHECK (jsonb_typeof("configSnapshot") = 'object')
);

ALTER TABLE "Actor"
  ADD COLUMN "inventoryStateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "Actor_inventoryStateVersion_check" CHECK ("inventoryStateVersion" > 0);

ALTER TABLE "ActorDerivedSnapshot"
  ADD COLUMN "inventoryStateVersion" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "ActorDerivedSnapshot_inventoryStateVersion_check" CHECK ("inventoryStateVersion" > 0);
ALTER TABLE "ActorDerivedSnapshot" ALTER COLUMN "inventoryStateVersion" DROP DEFAULT;

ALTER TABLE "ContentVersion"
  ADD COLUMN "inventoryRulesVersionId" UUID,
  ADD COLUMN "inventorySpec" JSONB,
  ADD COLUMN "inventorySpecHash" CHAR(64),
  ADD CONSTRAINT "ContentVersion_inventory_fields_check" CHECK (
    ("inventoryRulesVersionId" IS NULL AND "inventorySpec" IS NULL AND "inventorySpecHash" IS NULL)
    OR ("inventoryRulesVersionId" IS NOT NULL AND jsonb_typeof("inventorySpec") = 'object' AND "inventorySpecHash" IS NOT NULL)
  ),
  ADD CONSTRAINT "ContentVersion_inventorySpecHash_check" CHECK (
    "inventorySpecHash" IS NULL OR "inventorySpecHash" ~ '^[0-9a-f]{64}$'
  );

DROP INDEX "ContentVersion_contentDefinitionId_contentHash_key";
CREATE UNIQUE INDEX "ContentVersion_without_inventory_spec_key"
  ON "ContentVersion"("contentDefinitionId", "contentHash") WHERE "inventorySpecHash" IS NULL;
CREATE UNIQUE INDEX "ContentVersion_with_inventory_spec_key"
  ON "ContentVersion"("contentDefinitionId", "contentHash", "inventorySpecHash") WHERE "inventorySpecHash" IS NOT NULL;

ALTER TABLE "ActorContent"
  DROP COLUMN "equipped",
  DROP COLUMN "quantity";

CREATE TABLE "InventoryEntry" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "entryRef" TEXT NOT NULL,
  "contentVersionId" UUID NOT NULL,
  "inventoryRulesVersionId" UUID NOT NULL,
  "entryKind" "InventoryEntryKind" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "instanceLifecycle" "InventoryInstanceLifecycle",
  "customName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryEntry_shape_check" CHECK (
    ("entryKind" = 'INSTANCE' AND "quantity" = 1 AND "instanceLifecycle" IS NOT NULL)
    OR ("entryKind" = 'STACK' AND "quantity" > 0 AND "instanceLifecycle" IS NULL AND "customName" IS NULL)
  ),
  CONSTRAINT "InventoryEntry_customName_check" CHECK (
    "customName" IS NULL OR (char_length(btrim("customName")) > 0 AND char_length("customName") <= 200)
  )
);

CREATE TABLE "ActorEquipmentSlot" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "slotRef" "ActorEquipmentSlotRef" NOT NULL,
  "inventoryEntryId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActorEquipmentSlot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryRulesVersion_code_key" ON "InventoryRulesVersion"("code");
CREATE INDEX "InventoryRulesVersion_rulesetVersionId_idx" ON "InventoryRulesVersion"("rulesetVersionId");
CREATE INDEX "ContentVersion_inventoryRulesVersionId_idx" ON "ContentVersion"("inventoryRulesVersionId");
CREATE UNIQUE INDEX "InventoryEntry_actorId_entryRef_key" ON "InventoryEntry"("actorId", "entryRef");
CREATE UNIQUE INDEX "InventoryEntry_id_actorId_key" ON "InventoryEntry"("id", "actorId");
CREATE INDEX "InventoryEntry_contentVersionId_idx" ON "InventoryEntry"("contentVersionId");
CREATE INDEX "InventoryEntry_inventoryRulesVersionId_idx" ON "InventoryEntry"("inventoryRulesVersionId");
CREATE UNIQUE INDEX "ActorEquipmentSlot_actorId_slotRef_key" ON "ActorEquipmentSlot"("actorId", "slotRef");
CREATE INDEX "ActorEquipmentSlot_inventoryEntryId_actorId_idx" ON "ActorEquipmentSlot"("inventoryEntryId", "actorId");

ALTER TABLE "InventoryRulesVersion" ADD CONSTRAINT "InventoryRulesVersion_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_inventoryRulesVersionId_fkey"
  FOREIGN KEY ("inventoryRulesVersionId") REFERENCES "InventoryRulesVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_contentVersionId_fkey"
  FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryEntry" ADD CONSTRAINT "InventoryEntry_inventoryRulesVersionId_fkey"
  FOREIGN KEY ("inventoryRulesVersionId") REFERENCES "InventoryRulesVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActorEquipmentSlot" ADD CONSTRAINT "ActorEquipmentSlot_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActorEquipmentSlot" ADD CONSTRAINT "ActorEquipmentSlot_inventoryEntryId_actorId_fkey"
  FOREIGN KEY ("inventoryEntryId", "actorId") REFERENCES "InventoryEntry"("id", "actorId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "inventory_rules_version_block_mutation"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'InventoryRulesVersion is immutable and cannot be updated or deleted';
END
$function$;
CREATE TRIGGER "InventoryRulesVersion_reject_update" BEFORE UPDATE ON "InventoryRulesVersion"
  FOR EACH ROW EXECUTE FUNCTION "inventory_rules_version_block_mutation"();
CREATE TRIGGER "InventoryRulesVersion_reject_delete" BEFORE DELETE ON "InventoryRulesVersion"
  FOR EACH ROW EXECUTE FUNCTION "inventory_rules_version_block_mutation"();

CREATE FUNCTION "inventory_entry_validate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  spec JSONB;
  spec_rules UUID;
  spec_ruleset UUID;
  content_rules UUID;
  actor_rules UUID;
  stacking_mode TEXT;
  maximum_stack INTEGER;
BEGIN
  SELECT cv."inventorySpec", cv."inventoryRulesVersionId", cv."rulesetVersionId"
    INTO spec, spec_rules, content_rules
    FROM "ContentVersion" cv WHERE cv."id" = NEW."contentVersionId";
  IF spec IS NULL OR spec_rules IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'InventoryEntry requires a ContentVersion with inventorySpec';
  END IF;
  IF NEW."inventoryRulesVersionId" IS DISTINCT FROM spec_rules THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'InventoryEntry inventory rules do not match ContentVersion';
  END IF;
  SELECT irv."rulesetVersionId" INTO spec_ruleset
    FROM "InventoryRulesVersion" irv WHERE irv."id" = spec_rules;
  IF spec_ruleset IS NULL OR spec_ruleset IS DISTINCT FROM content_rules THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentVersion inventory rules do not match its ruleset';
  END IF;
  SELECT c."rulesetVersionId" INTO actor_rules
    FROM "Actor" a JOIN "Campaign" c ON c."id" = a."campaignId" WHERE a."id" = NEW."actorId";
  IF actor_rules IS NULL OR actor_rules IS DISTINCT FROM content_rules THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'InventoryEntry content ruleset does not match Actor Campaign';
  END IF;
  stacking_mode := spec #>> '{stacking,mode}';
  IF (NEW."entryKind" = 'INSTANCE' AND stacking_mode IS DISTINCT FROM 'unique')
     OR (NEW."entryKind" = 'STACK' AND stacking_mode IS DISTINCT FROM 'stackable') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'InventoryEntry kind does not match inventorySpec stacking mode';
  END IF;
  IF NEW."entryKind" = 'STACK' THEN
    BEGIN
      maximum_stack := (spec #>> '{stacking,maxStack}')::INTEGER;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ContentVersion inventorySpec maxStack is invalid';
    END;
    IF maximum_stack IS NULL OR NEW."quantity" > maximum_stack THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'InventoryEntry quantity exceeds inventorySpec maxStack';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."instanceLifecycle" IS DISTINCT FROM OLD."instanceLifecycle"
     AND NEW."instanceLifecycle" IS DISTINCT FROM 'AVAILABLE'
     AND EXISTS (SELECT 1 FROM "ActorEquipmentSlot" s WHERE s."inventoryEntryId" = OLD."id") THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Equipped InventoryEntry lifecycle cannot change';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "InventoryEntry_validate_write" BEFORE INSERT OR UPDATE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "inventory_entry_validate"();

CREATE FUNCTION "inventory_entry_block_equipped_delete"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "ActorEquipmentSlot" s WHERE s."inventoryEntryId" = OLD."id") THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'Equipped InventoryEntry cannot be removed';
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER "InventoryEntry_reject_equipped_delete" BEFORE DELETE ON "InventoryEntry"
  FOR EACH ROW EXECUTE FUNCTION "inventory_entry_block_equipped_delete"();

CREATE FUNCTION "actor_equipment_slot_validate"()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
DECLARE
  entry_kind "InventoryEntryKind";
  lifecycle "InventoryInstanceLifecycle";
BEGIN
  SELECT e."entryKind", e."instanceLifecycle" INTO entry_kind, lifecycle
    FROM "InventoryEntry" e WHERE e."id" = NEW."inventoryEntryId" AND e."actorId" = NEW."actorId";
  IF entry_kind IS DISTINCT FROM 'INSTANCE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActorEquipmentSlot requires an instance owned by the same Actor';
  END IF;
  IF lifecycle IS DISTINCT FROM 'AVAILABLE' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ActorEquipmentSlot requires an available InventoryEntry';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER "ActorEquipmentSlot_validate_write" BEFORE INSERT OR UPDATE ON "ActorEquipmentSlot"
  FOR EACH ROW EXECUTE FUNCTION "actor_equipment_slot_validate"();

DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['InventoryRulesVersion', 'InventoryEntry', 'ActorEquipmentSlot']
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

-- Structural rollback is a new reviewed corrective migration: remove triggers
-- and functions, slots/entries, new FKs/indexes/columns and enums, then restore
-- the two conceptual ActorContent columns only for old code. Never edit this
-- migration or delete functional inventory as an implicit rollback.
