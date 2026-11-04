-- One person can sign in with more than one method (Google, SMS). The first design allowed a single
-- sign-in identity per account, so a second method could never be attached to the account that
-- holds the person's data: signing in with it created a second, empty account.
ALTER TABLE public.google_auth_identities DROP CONSTRAINT IF EXISTS google_auth_identities_account_id_key;
CREATE INDEX IF NOT EXISTS google_auth_identities_account_id_idx ON public.google_auth_identities (account_id);
