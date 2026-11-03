-- Google Cloud Identity Platform owns authentication. Existing application UUIDs
-- are retained; Firebase UIDs are never cast to UUID or used as storage paths.
BEGIN;

CREATE TABLE public.app_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_auth_id uuid UNIQUE,
  email text,
  phone text,
  email_verified boolean NOT NULL DEFAULT false,
  phone_verified boolean NOT NULL DEFAULT false,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.app_accounts(id, legacy_auth_id, email, phone, email_verified, phone_verified, full_name, created_at)
SELECT id, id, email, to_jsonb(u)->>'phone',
  (to_jsonb(u)->>'email_confirmed_at') IS NOT NULL,
  (to_jsonb(u)->>'phone_confirmed_at') IS NOT NULL,
  raw_user_meta_data->>'full_name', coalesce(created_at, now())
FROM auth.users u;
ALTER TABLE public.app_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_accounts FROM anon, authenticated;
GRANT ALL ON public.app_accounts TO service_role;

CREATE TABLE public.google_auth_projects (
  project_id text PRIMARY KEY,
  tenant_id text NOT NULL DEFAULT '',
  allow_legacy boolean NOT NULL DEFAULT false
);
CREATE TABLE public.google_auth_identities (
  issuer text NOT NULL,
  tenant_id text NOT NULL DEFAULT '',
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  PRIMARY KEY(issuer, tenant_id, subject),
  UNIQUE(account_id)
);
ALTER TABLE public.google_auth_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_auth_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.google_auth_projects, public.google_auth_identities FROM anon, authenticated;
GRANT ALL ON public.google_auth_projects, public.google_auth_identities TO service_role;

-- The previous release can still create/verify accounts during the rollout.
-- Keep those UUIDs usable until the administrator ends the legacy window.
CREATE FUNCTION public.sync_legacy_app_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.google_auth_projects)
    OR EXISTS (SELECT 1 FROM public.google_auth_projects WHERE allow_legacy) THEN
    INSERT INTO public.app_accounts(id, legacy_auth_id, email, phone, email_verified, phone_verified, full_name, created_at)
    VALUES(NEW.id, NEW.id, NEW.email, NEW.phone, NEW.email_confirmed_at IS NOT NULL,
      NEW.phone_confirmed_at IS NOT NULL, NEW.raw_user_meta_data->>'full_name', coalesce(NEW.created_at, now()))
    ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email, phone=EXCLUDED.phone,
      email_verified=EXCLUDED.email_verified, phone_verified=EXCLUDED.phone_verified;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_legacy_app_account() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER sync_legacy_app_account AFTER INSERT OR UPDATE OF email,phone,email_confirmed_at,phone_confirmed_at ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_app_account();

-- The gateway verifies the JWT signature, expiration and registered issuer.
-- This second allowlist protects local/self-hosted deployments as well.
CREATE FUNCTION public.current_app_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE claims jsonb := auth.jwt(); result uuid;
BEGIN
  IF coalesce(claims->>'iss', '') LIKE 'https://securetoken.google.com/%' THEN
    IF NOT EXISTS (SELECT 1 FROM public.google_auth_projects p
      WHERE claims->>'iss' = 'https://securetoken.google.com/' || p.project_id
        AND claims->>'aud' = p.project_id AND coalesce(claims#>>'{firebase,tenant}', '') = p.tenant_id) THEN RETURN NULL; END IF;
    IF coalesce(claims#>>'{firebase,sign_in_provider}', '') NOT IN ('google.com', 'phone') THEN RETURN NULL; END IF;
    SELECT account_id INTO result FROM public.google_auth_identities
      WHERE issuer = claims->>'iss' AND tenant_id = coalesce(claims#>>'{firebase,tenant}', '') AND subject = claims->>'sub';
    RETURN result;
  END IF;
  -- Keep the previous release working until the Google project is configured.
  -- Once configured, old Supabase sessions are disabled by default.
  IF NOT EXISTS (SELECT 1 FROM public.google_auth_projects)
    OR EXISTS (SELECT 1 FROM public.google_auth_projects WHERE allow_legacy) THEN
    RETURN auth.uid();
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.current_app_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO anon, authenticated, service_role;

-- No client-supplied email, phone, UID or account ID is accepted. All identity
-- attributes come from the gateway-verified Google JWT.
CREATE FUNCTION public.register_google_user() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
<<identity_request>>
DECLARE
  claims jsonb := auth.jwt(); account public.app_accounts;
  issuer text := claims->>'iss'; subject text := claims->>'sub';
  verified_email text; verified_phone text; candidates uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.google_auth_projects p
    WHERE issuer = 'https://securetoken.google.com/' || p.project_id AND claims->>'aud' = p.project_id AND coalesce(claims#>>'{firebase,tenant}', '') = p.tenant_id)
    OR coalesce(claims#>>'{firebase,sign_in_provider}', '') NOT IN ('google.com', 'phone')
    OR coalesce(subject, '') = '' THEN RAISE EXCEPTION 'Invalid Google identity' USING ERRCODE = '28000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(issuer || '/' || subject, 0));
  SELECT a.* INTO account FROM public.app_accounts a JOIN public.google_auth_identities i ON a.id = i.account_id
    WHERE i.issuer = identity_request.issuer AND i.tenant_id = coalesce(claims#>>'{firebase,tenant}', '') AND i.subject = identity_request.subject;
  IF account.id IS NULL THEN
    IF claims->>'email_verified' = 'true' THEN verified_email := lower(nullif(claims->>'email', '')); END IF;
    verified_phone := nullif(claims->>'phone_number', '');
    -- Lock verified contact values to serialize first login on legacy accounts.
    IF verified_email IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(verified_email, 1)); END IF;
    IF verified_phone IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(verified_phone, 2)); END IF;
    SELECT array_agg(id) INTO candidates FROM public.app_accounts a WHERE a.legacy_auth_id IS NOT NULL AND (
      (verified_email IS NOT NULL AND a.email_verified AND lower(a.email) = verified_email)
      OR (verified_phone IS NOT NULL AND a.phone_verified AND a.phone = verified_phone));
    IF cardinality(candidates) > 1 THEN RAISE EXCEPTION 'Account migration needs review'; END IF;
    IF cardinality(candidates) = 1 THEN
      SELECT * INTO account FROM public.app_accounts WHERE id = candidates[1] FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public.google_auth_identities WHERE account_id = account.id) THEN
        RAISE EXCEPTION 'Use the original sign-in method to link this account';
      END IF;
    ELSE
      INSERT INTO public.app_accounts(email, phone, email_verified, phone_verified, full_name)
        VALUES(verified_email, verified_phone, verified_email IS NOT NULL, verified_phone IS NOT NULL, nullif(claims->>'name', ''))
        RETURNING * INTO account;
    END IF;
    INSERT INTO public.google_auth_identities VALUES(issuer, coalesce(claims#>>'{firebase,tenant}', ''), subject, account.id);
  END IF;
  RETURN jsonb_build_object('id', account.id, 'email', account.email, 'phone', account.phone,
    'user_metadata', jsonb_build_object('full_name', coalesce(account.full_name, claims->>'name'), 'avatar_url', claims->>'picture'));
END;
$$;
REVOKE ALL ON FUNCTION public.register_google_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_google_user() TO authenticated;

CREATE FUNCTION public.update_account_name(p_name text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF public.current_app_user_id() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF length(btrim(p_name)) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'Invalid name'; END IF;
  UPDATE public.app_accounts SET full_name = btrim(p_name) WHERE id = public.current_app_user_id();
END;
$$;
REVOKE ALL ON FUNCTION public.update_account_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_account_name(text) TO authenticated;

-- Move application FKs away from the old login service without moving data.
DO $$ DECLARE r record; definition text; BEGIN
  FOR r IN SELECT c.conname, c.conrelid::regclass AS tbl, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND c.confrelid = 'auth.users'::regclass AND n.nspname = 'public'
  LOOP
    definition := replace(r.def, 'REFERENCES auth.users', 'REFERENCES public.app_accounts');
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', r.tbl, r.conname, definition);
  END LOOP;
  -- Rewrite application functions, row policies (including private storage),
  -- and owner-column defaults. Do not alter Supabase's managed auth functions.
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname <> 'current_app_user_id' AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%auth.uid()%'
  LOOP EXECUTE replace(pg_get_functiondef(r.oid), 'auth.uid()', 'public.current_app_user_id()'); END LOOP;
  FOR r IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
    WHERE schemaname IN ('public', 'storage') AND (qual LIKE '%auth.uid()%' OR with_check LIKE '%auth.uid()%')
  LOOP
    EXECUTE format('ALTER POLICY %I ON %I.%I%s%s', r.policyname, r.schemaname, r.tablename,
      CASE WHEN r.qual IS NULL THEN '' ELSE ' USING (' || replace(r.qual, 'auth.uid()', 'public.current_app_user_id()') || ')' END,
      CASE WHEN r.with_check IS NULL THEN '' ELSE ' WITH CHECK (' || replace(r.with_check, 'auth.uid()', 'public.current_app_user_id()') || ')' END);
  END LOOP;
  FOR r IN SELECT table_schema, table_name, column_name, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND column_default LIKE '%auth.uid()%'
  LOOP EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET DEFAULT %s', r.table_schema, r.table_name, r.column_name,
    replace(r.column_default, 'auth.uid()', 'public.current_app_user_id()')); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.get_user_auth_info()
RETURNS TABLE(provider text, email text, confirmed_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(auth.jwt()#>>'{firebase,sign_in_provider}', 'legacy'), a.email, a.created_at
  FROM public.app_accounts a WHERE a.id = public.current_app_user_id();
$$;
REVOKE ALL ON FUNCTION public.get_user_auth_info() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_auth_info() TO authenticated;
COMMIT;
