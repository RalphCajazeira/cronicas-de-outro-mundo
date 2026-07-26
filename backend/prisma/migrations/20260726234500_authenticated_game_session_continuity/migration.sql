-- Phase 2E persists only the authenticated user's selected campaign and actor.
-- It does not mutate campaign, actor, encounter, world time, or narrative state.

CREATE TYPE "GameSessionStatus" AS ENUM ('ACTIVE', 'CLOSED');

CREATE TABLE "GameSession" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "campaignId" UUID NOT NULL,
  "actorId" UUID NOT NULL,
  "status" "GameSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "stateVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "GameSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GameSession_stateVersion_check" CHECK ("stateVersion" >= 1),
  CONSTRAINT "GameSession_status_closedAt_check" CHECK (
    ("status" = 'ACTIVE' AND "closedAt" IS NULL)
    OR ("status" = 'CLOSED' AND "closedAt" IS NOT NULL)
  )
);

ALTER TABLE "AuditEvent" ADD COLUMN "gameSessionId" UUID;

CREATE UNIQUE INDEX "GameSession_userId_campaignId_key"
  ON "GameSession"("userId", "campaignId");
CREATE INDEX "GameSession_userId_status_lastActiveAt_idx"
  ON "GameSession"("userId", "status", "lastActiveAt");
CREATE INDEX "GameSession_campaignId_status_idx"
  ON "GameSession"("campaignId", "status");
CREATE INDEX "GameSession_actorId_status_idx"
  ON "GameSession"("actorId", "status");
CREATE INDEX "AuditEvent_gameSessionId_occurredAt_idx"
  ON "AuditEvent"("gameSessionId", "occurredAt");

ALTER TABLE "GameSession"
  ADD CONSTRAINT "GameSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "GameSession_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GameSession_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "Actor"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_gameSessionId_fkey"
    FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE public."GameSession" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."GameSession" FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public."GameSession" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public."GameSession" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL PRIVILEGES ON TABLE public."GameSession" FROM service_role;
  END IF;
END
$roles$;
