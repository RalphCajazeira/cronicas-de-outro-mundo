-- Phase 2C-B adds a generic, client-bound resource audience policy and
-- a fail-closed Supabase Custom Access Token Hook. It creates no policy data.

CREATE TABLE "OAuthClientResourcePolicy" (
  "id" UUID NOT NULL,
  "clientId" VARCHAR(512) NOT NULL,
  "audience" VARCHAR(2048) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthClientResourcePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OAuthClientResourcePolicy_clientId_check" CHECK (
    "clientId" = btrim("clientId")
    AND octet_length("clientId") BETWEEN 1 AND 512
    AND "clientId" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "OAuthClientResourcePolicy_audience_check" CHECK (
    "audience" = btrim("audience")
    AND octet_length("audience") BETWEEN 1 AND 2048
    AND "audience" !~ '[[:cntrl:]]'
    AND "audience" ~ '^https://'
  )
);

CREATE UNIQUE INDEX "OAuthClientResourcePolicy_clientId_key"
  ON "OAuthClientResourcePolicy"("clientId");
CREATE INDEX "OAuthClientResourcePolicy_enabled_idx"
  ON "OAuthClientResourcePolicy"("enabled");

ALTER TABLE public."OAuthClientResourcePolicy" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."OAuthClientResourcePolicy" FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public."OAuthClientResourcePolicy" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public."OAuthClientResourcePolicy" FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL PRIVILEGES ON TABLE public."OAuthClientResourcePolicy" FROM service_role;
  END IF;
END
$roles$;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $hook$
DECLARE
  claims jsonb;
  oauth_client_id text;
  resource_audience text;
BEGIN
  IF jsonb_typeof(event) IS DISTINCT FROM 'object'
    OR jsonb_typeof(event->'claims') IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 403, 'message', 'OAuth client is not authorized')
    );
  END IF;

  claims := event->'claims';
  oauth_client_id := claims->>'client_id';

  -- Ordinary Supabase sessions must keep their standard audience unchanged.
  IF oauth_client_id IS NULL THEN
    RETURN jsonb_build_object('claims', claims);
  END IF;

  IF oauth_client_id <> btrim(oauth_client_id)
    OR octet_length(oauth_client_id) NOT BETWEEN 1 AND 512
    OR oauth_client_id ~ '[[:cntrl:]]' THEN
    RETURN jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 403, 'message', 'OAuth client is not authorized')
    );
  END IF;

  SELECT policy."audience"
    INTO resource_audience
    FROM public."OAuthClientResourcePolicy" AS policy
   WHERE policy."clientId" = oauth_client_id
     AND policy."enabled" = true;

  IF resource_audience IS NULL THEN
    RETURN jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 403, 'message', 'OAuth client is not authorized')
    );
  END IF;

  claims := jsonb_set(claims, '{aud}', to_jsonb(resource_audience), true);
  RETURN jsonb_build_object('claims', claims);
END
$hook$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;

DO $roles$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
  END IF;
END
$roles$;
