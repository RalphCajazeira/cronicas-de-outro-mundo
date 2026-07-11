-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('CHARACTER', 'NPC', 'CREATURE', 'COMPANION', 'SPIRIT');

-- CreateEnum
CREATE TYPE "ActorStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEFEATED', 'DEAD', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('SKILL', 'SPELL', 'WEAPON', 'ARMOR', 'SHIELD', 'ITEM', 'TALENT', 'MATERIAL', 'CLASS', 'RACE', 'LOCATION', 'FACTION', 'QUEST_TEMPLATE', 'STATUS_EFFECT', 'RECIPE', 'CREATURE_TEMPLATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ActorContentState" AS ENUM ('LOCKED', 'LEARNING', 'KNOWN', 'MASTERED');

-- CreateTable
CREATE TABLE "Player" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "World" (
    "id" UUID NOT NULL,
    "playerId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "World_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "worldId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "currentTime" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Actor" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "species" TEXT,
    "className" TEXT,
    "role" TEXT,
    "description" TEXT,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "gold" INTEGER NOT NULL DEFAULT 0,
    "health" INTEGER NOT NULL,
    "maxHealth" INTEGER NOT NULL,
    "mana" INTEGER NOT NULL,
    "maxMana" INTEGER NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "resistances" JSONB NOT NULL DEFAULT '{}',
    "affinities" JSONB NOT NULL DEFAULT '{}',
    "appearance" JSONB NOT NULL DEFAULT '{}',
    "personality" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "ActorStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Actor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentDefinition" (
    "id" UUID NOT NULL,
    "worldId" UUID NOT NULL,
    "campaignId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "description" TEXT,
    "mechanics" JSONB NOT NULL DEFAULT '{}',
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "presentation" JSONB NOT NULL DEFAULT '{}',
    "tags" JSONB NOT NULL DEFAULT '[]',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActorContent" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "contentDefinitionId" UUID NOT NULL,
    "state" "ActorContentState" NOT NULL DEFAULT 'LOCKED',
    "rank" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "mastery" INTEGER NOT NULL DEFAULT 0,
    "equipped" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActorContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameEvent" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "actorId" UUID,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_slug_key" ON "Player"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "World_playerId_code_key" ON "World"("playerId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_worldId_code_key" ON "Campaign"("worldId", "code");

-- CreateIndex
CREATE INDEX "Actor_campaignId_actorType_status_idx" ON "Actor"("campaignId", "actorType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Actor_campaignId_code_key" ON "Actor"("campaignId", "code");

-- CreateIndex
CREATE INDEX "ContentDefinition_worldId_contentType_code_idx" ON "ContentDefinition"("worldId", "contentType", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ContentDefinition_worldId_campaignId_contentType_code_key" ON "ContentDefinition"("worldId", "campaignId", "contentType", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ContentDefinition_global_scope_key" ON "ContentDefinition"("worldId", "contentType", "code") WHERE ("campaignId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ActorContent_actorId_contentDefinitionId_key" ON "ActorContent"("actorId", "contentDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "GameEvent_idempotencyKey_key" ON "GameEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GameEvent_campaignId_createdAt_idx" ON "GameEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "GameEvent_actorId_createdAt_idx" ON "GameEvent"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "World" ADD CONSTRAINT "World_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Actor" ADD CONSTRAINT "Actor_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDefinition" ADD CONSTRAINT "ContentDefinition_worldId_fkey" FOREIGN KEY ("worldId") REFERENCES "World"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentDefinition" ADD CONSTRAINT "ContentDefinition_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorContent" ADD CONSTRAINT "ActorContent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActorContent" ADD CONSTRAINT "ActorContent_contentDefinitionId_fkey" FOREIGN KEY ("contentDefinitionId") REFERENCES "ContentDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameEvent" ADD CONSTRAINT "GameEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "Actor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
