-- Phase 1D replaces every legacy Actor mechanics column. Functional Actor
-- rows are intentionally not converted, deleted or rewritten by this migration.
DO $clean_slate$
BEGIN
  IF EXISTS (SELECT 1 FROM "Actor" LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'Phase 1D migration requires an empty Actor table; clear functional data before rollout';
  END IF;
END
$clean_slate$;

-- CreateEnum
CREATE TYPE "ActorAttributeCode" AS ENUM (
  'strength', 'vitality', 'agility', 'dexterity', 'intelligence',
  'wisdom', 'perception', 'willpower', 'luck'
);

-- CreateEnum
CREATE TYPE "ActorResourceType" AS ENUM ('hp', 'mana', 'sp');

-- AlterTable
ALTER TABLE "Actor"
  ADD COLUMN "mechanicsStateVersion" INTEGER NOT NULL DEFAULT 1,
  DROP COLUMN "health",
  DROP COLUMN "maxHealth",
  DROP COLUMN "mana",
  DROP COLUMN "maxMana",
  DROP COLUMN "attributes",
  DROP COLUMN "resistances",
  DROP COLUMN "affinities",
  ADD CONSTRAINT "Actor_mechanicsStateVersion_check" CHECK ("mechanicsStateVersion" > 0),
  ADD CONSTRAINT "Actor_level_check" CHECK ("level" BETWEEN 1 AND 20),
  ADD CONSTRAINT "Actor_xp_check" CHECK ("xp" >= 0),
  ADD CONSTRAINT "Actor_gold_check" CHECK ("gold" >= 0);

-- CreateTable
CREATE TABLE "ActorAttribute" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "code" "ActorAttributeCode" NOT NULL,
  "baseValue" INTEGER NOT NULL,
  "earnedValue" INTEGER NOT NULL DEFAULT 0,
  "xp" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActorAttribute_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActorAttribute_baseValue_check" CHECK ("baseValue" BETWEEN 0 AND 30),
  CONSTRAINT "ActorAttribute_earnedValue_check" CHECK ("earnedValue" >= 0),
  CONSTRAINT "ActorAttribute_xp_check" CHECK ("xp" >= 0),
  CONSTRAINT "ActorAttribute_effective_cap_check" CHECK ("baseValue" + "earnedValue" <= 30)
);

-- CreateTable
CREATE TABLE "ActorResource" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "type" "ActorResourceType" NOT NULL,
  "current" INTEGER NOT NULL,
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActorResource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActorResource_current_check" CHECK ("current" >= 0),
  CONSTRAINT "ActorResource_stateVersion_check" CHECK ("stateVersion" >= 0)
);

-- CreateTable
CREATE TABLE "ActorDerivedSnapshot" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "rulesetVersionId" UUID NOT NULL,
  "mechanicsStateVersion" INTEGER NOT NULL,
  "maxHp" INTEGER NOT NULL,
  "maxMana" INTEGER NOT NULL,
  "maxSp" INTEGER NOT NULL,
  "actorPhysicalPower" INTEGER NOT NULL,
  "actorMagicalPower" INTEGER NOT NULL,
  "physicalDefense" INTEGER NOT NULL,
  "magicalDefense" INTEGER NOT NULL,
  "accuracy" INTEGER NOT NULL,
  "evasion" INTEGER NOT NULL,
  "baseAttackSpeedBps" INTEGER NOT NULL,
  "baseCastingSpeedBps" INTEGER NOT NULL,
  "criticalChanceBps" INTEGER NOT NULL,
  "criticalDamageBps" INTEGER NOT NULL,
  "movementSpeed" INTEGER NOT NULL,
  "carryingCapacity" INTEGER NOT NULL,
  "physicalResistanceBps" INTEGER NOT NULL,
  "magicalResistanceBps" INTEGER NOT NULL,
  "elementalResistanceSnapshot" JSONB NOT NULL DEFAULT '{}',
  "hpRegen" INTEGER NOT NULL,
  "manaRegen" INTEGER NOT NULL,
  "spRegen" INTEGER NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActorDerivedSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ActorDerivedSnapshot_mechanicsStateVersion_check" CHECK ("mechanicsStateVersion" > 0),
  CONSTRAINT "ActorDerivedSnapshot_maxHp_check" CHECK ("maxHp" > 0),
  CONSTRAINT "ActorDerivedSnapshot_maxMana_check" CHECK ("maxMana" >= 0),
  CONSTRAINT "ActorDerivedSnapshot_maxSp_check" CHECK ("maxSp" >= 0),
  CONSTRAINT "ActorDerivedSnapshot_nonnegative_values_check" CHECK (
    "actorPhysicalPower" >= 0 AND "actorMagicalPower" >= 0
    AND "physicalDefense" >= 0 AND "magicalDefense" >= 0
    AND "accuracy" >= 0 AND "evasion" >= 0
    AND "baseAttackSpeedBps" > 0 AND "baseCastingSpeedBps" > 0
    AND "criticalChanceBps" >= 0 AND "criticalDamageBps" >= 0
    AND "movementSpeed" >= 0 AND "carryingCapacity" >= 0
    AND "hpRegen" >= 0 AND "manaRegen" >= 0 AND "spRegen" >= 0
  ),
  CONSTRAINT "ActorDerivedSnapshot_resistance_range_check" CHECK (
    "physicalResistanceBps" BETWEEN -10000 AND 10000
    AND "magicalResistanceBps" BETWEEN -10000 AND 10000
  ),
  CONSTRAINT "ActorDerivedSnapshot_elemental_json_check" CHECK (jsonb_typeof("elementalResistanceSnapshot") = 'object'),
  CONSTRAINT "ActorDerivedSnapshot_inputHash_check" CHECK ("inputHash" ~ '^[0-9a-f]{64}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "ActorAttribute_actorId_code_key" ON "ActorAttribute"("actorId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ActorResource_actorId_type_key" ON "ActorResource"("actorId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ActorDerivedSnapshot_actorId_key" ON "ActorDerivedSnapshot"("actorId");

-- CreateIndex
CREATE INDEX "ActorDerivedSnapshot_rulesetVersionId_idx" ON "ActorDerivedSnapshot"("rulesetVersionId");

-- AddForeignKey
ALTER TABLE "ActorAttribute" ADD CONSTRAINT "ActorAttribute_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorResource" ADD CONSTRAINT "ActorResource_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorDerivedSnapshot" ADD CONSTRAINT "ActorDerivedSnapshot_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorDerivedSnapshot" ADD CONSTRAINT "ActorDerivedSnapshot_rulesetVersionId_fkey"
  FOREIGN KEY ("rulesetVersionId") REFERENCES "RulesetVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve the Node-owned RLS/revocation posture. The dedicated table owner is
-- intentionally the only runtime role until explicit policies are introduced.
DO $security$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ActorAttribute', 'ActorResource', 'ActorDerivedSnapshot']
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

-- Structural rollback before compatible Actor data exists: drop the four new
-- foreign keys, indexes and three tables; drop both enums and the Actor checks;
-- restore the seven legacy columns only if old application code must run. Once
-- published, rollback is a new reviewed corrective migration and never a data
-- deletion or edit of this migration.
