-- The Companion's window signs the site in as the account the Companion is connected to (api/sim/web-session): the server
-- signs a Firebase custom token for the account's existing Google identity, so the ID token says sign_in_provider 'custom'.
-- Both functions accept it from now on, with one rule more: a custom sign-in never creates or links an account, it only
-- finds the identity that is already there. Only the server can sign a custom token (with the Firebase service account).
-- Everything else in the two functions is as in 20261103140000_google_cloud_auth.sql.
BEGIN;

CREATE OR REPLACE FUNCTION public.current_app_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE claims jsonb := auth.jwt(); result uuid;
BEGIN
  IF coalesce(claims->>'iss', '') LIKE 'https://securetoken.google.com/%' THEN
    IF NOT EXISTS (SELECT 1 FROM public.google_auth_projects p
      WHERE claims->>'iss' = 'https://securetoken.google.com/' || p.project_id
        AND claims->>'aud' = p.project_id AND coalesce(claims#>>'{firebase,tenant}', '') = p.tenant_id) THEN RETURN NULL; END IF;
    IF coalesce(claims#>>'{firebase,sign_in_provider}', '') NOT IN ('google.com', 'phone', 'custom') THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION public.register_google_user() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
<<identity_request>>
DECLARE
  claims jsonb := auth.jwt(); account public.app_accounts;
  issuer text := claims->>'iss'; subject text := claims->>'sub';
  verified_email text; verified_phone text; candidates uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.google_auth_projects p
    WHERE issuer = 'https://securetoken.google.com/' || p.project_id AND claims->>'aud' = p.project_id AND coalesce(claims#>>'{firebase,tenant}', '') = p.tenant_id)
    OR coalesce(claims#>>'{firebase,sign_in_provider}', '') NOT IN ('google.com', 'phone', 'custom')
    OR coalesce(subject, '') = '' THEN RAISE EXCEPTION 'Invalid Google identity' USING ERRCODE = '28000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(issuer || '/' || subject, 0));
  SELECT a.* INTO account FROM public.app_accounts a JOIN public.google_auth_identities i ON a.id = i.account_id
    WHERE i.issuer = identity_request.issuer AND i.tenant_id = coalesce(claims#>>'{firebase,tenant}', '') AND i.subject = identity_request.subject;
  IF account.id IS NULL THEN
    -- A custom sign-in (the Companion's window, api/sim/web-session) is only ever issued for an identity that exists.
    IF claims#>>'{firebase,sign_in_provider}' = 'custom' THEN RAISE EXCEPTION 'Invalid Google identity' USING ERRCODE = '28000'; END IF;
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

COMMIT;
