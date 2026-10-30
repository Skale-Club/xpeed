-- Add a separate bounded allowance for photo extraction. Existing uses keep their kind.
ALTER TABLE public.user_quotas DROP CONSTRAINT IF EXISTS user_quotas_kind_check;
ALTER TABLE public.user_quotas ADD CONSTRAINT user_quotas_kind_check
  CHECK (kind IN ('chat_messages', 'analysis', 'fuel_receipts'));
