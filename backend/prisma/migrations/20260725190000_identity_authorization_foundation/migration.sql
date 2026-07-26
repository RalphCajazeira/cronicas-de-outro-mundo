-- Phase 2B adds internal identity and authorization without linking legacy data.
-- Player.userId remains nullable and no ownership or membership is inferred.

CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE "CampaignMembershipRole" AS ENUM ('OWNER', 'GM', 'PLAYER', 'OBSERVER');
CREATE TYPE "CampaignMembershipStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "ActorControlPermission" AS ENUM ('VIEW', 'CONTROL');
CREATE TYPE "AuditDecision" AS ENUM ('ALLOW', 'DENY');

CREATE TABLE "User" (
  "id" UUID NOT NULL,
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "suspendedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "User_status_timestamps_check" CHECK (
    ("status" = 'ACTIVE' AND "suspendedAt" IS NULL AND "deletedAt" IS NULL)
    OR ("status" = 'SUSPENDED' AND "suspendedAt" IS NOT NULL AND "deletedAt" IS NULL)
    OR ("status" = 'DELETED' AND "deletedAt" IS NOT NULL)
  )
);

CREATE TABLE "ExternalIdentity" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "issuer" VARCHAR(512) NOT NULL,
  "subject" VARCHAR(512) NOT NULL,
  "email" VARCHAR(320),
  "emailVerified" BOOLEAN,
  "lastAuthenticatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CampaignMembership" (
  "id" UUID NOT NULL,
  "campaignId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "role" "CampaignMembershipRole" NOT NULL,
  "status" "CampaignMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "revokedAt" TIMESTAMP(3),
  "grantedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CampaignMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CampaignMembership_status_revokedAt_check" CHECK (
    ("status" = 'ACTIVE' AND "revokedAt" IS NULL)
    OR ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "ActorControl" (
  "id" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "permission" "ActorControlPermission" NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ActorControl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "eventType" VARCHAR(100) NOT NULL,
  "userId" UUID,
  "externalIdentityId" UUID,
  "campaignId" UUID,
  "actorId" UUID,
  "requestId" VARCHAR(128),
  "traceId" VARCHAR(128),
  "decision" "AuditDecision" NOT NULL,
  "reasonCode" VARCHAR(100),
  "source" VARCHAR(100) NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditEvent_metadata_check" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND octet_length("metadata"::text) <= 4096
  )
);

ALTER TABLE "Player" ADD COLUMN "userId" UUID;

CREATE INDEX "User_status_idx" ON "User"("status");
CREATE UNIQUE INDEX "ExternalIdentity_issuer_subject_key" ON "ExternalIdentity"("issuer", "subject");
CREATE INDEX "ExternalIdentity_userId_idx" ON "ExternalIdentity"("userId");
CREATE UNIQUE INDEX "Player_userId_key" ON "Player"("userId");
CREATE UNIQUE INDEX "CampaignMembership_campaignId_userId_key" ON "CampaignMembership"("campaignId", "userId");
CREATE INDEX "CampaignMembership_userId_status_idx" ON "CampaignMembership"("userId", "status");
CREATE INDEX "CampaignMembership_campaignId_role_status_idx" ON "CampaignMembership"("campaignId", "role", "status");
CREATE INDEX "CampaignMembership_grantedByUserId_idx" ON "CampaignMembership"("grantedByUserId");
CREATE UNIQUE INDEX "ActorControl_actorId_userId_key" ON "ActorControl"("actorId", "userId");
CREATE INDEX "ActorControl_userId_permission_idx" ON "ActorControl"("userId", "permission");
CREATE INDEX "AuditEvent_userId_occurredAt_idx" ON "AuditEvent"("userId", "occurredAt");
CREATE INDEX "AuditEvent_externalIdentityId_occurredAt_idx" ON "AuditEvent"("externalIdentityId", "occurredAt");
CREATE INDEX "AuditEvent_campaignId_occurredAt_idx" ON "AuditEvent"("campaignId", "occurredAt");
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");
CREATE INDEX "AuditEvent_eventType_occurredAt_idx" ON "AuditEvent"("eventType", "occurredAt");
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");

ALTER TABLE "Player"
  ADD CONSTRAINT "Player_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ExternalIdentity"
  ADD CONSTRAINT "ExternalIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignMembership"
  ADD CONSTRAINT "CampaignMembership_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CampaignMembership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CampaignMembership_grantedByUserId_fkey"
    FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ActorControl"
  ADD CONSTRAINT "ActorControl_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "Actor"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ActorControl_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AuditEvent_externalIdentityId_fkey"
    FOREIGN KEY ("externalIdentityId") REFERENCES "ExternalIdentity"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AuditEvent_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AuditEvent_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "Actor"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The Node backend remains the only data authority. These tables intentionally
-- have no anon/authenticated policies; the dedicated Prisma owner keeps access.
DO $security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'User', 'ExternalIdentity', 'CampaignMembership', 'ActorControl', 'AuditEvent'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM service_role', table_name);
    END IF;
  END LOOP;
END
$security$;
