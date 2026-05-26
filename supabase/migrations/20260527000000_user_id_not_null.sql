-- Defesa em profundidade: impede que user_id volte a ser NULL em qualquer tabela de dados de usuário.
-- A migration 20260526000006 corrigiu os dados existentes; esta fecha a causa raiz.

DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'car_profiles','sessions','shared_reports','chat_conversations',
    'chat_messages','user_quotas','maintenance_events','session_photos'
  ];
  t TEXT;
  v_nulls INT;
  v_exists BOOLEAN;
  v_has_user_id BOOLEAN;
BEGIN
  -- Pre-flight: garante que nenhuma tabela tem NULLs sobrando
  FOREACH t IN ARRAY v_tables LOOP
    v_exists := to_regclass('public.' || t) IS NOT NULL;
    IF NOT v_exists THEN
      RAISE NOTICE 'Skipping (table % does not exist)', t;
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id'
    ) INTO v_has_user_id;
    IF NOT v_has_user_id THEN
      RAISE NOTICE 'Skipping (table % has no user_id column)', t;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id IS NULL', t) INTO v_nulls;
    IF v_nulls > 0 THEN
      RAISE EXCEPTION 'Cannot apply NOT NULL: % has % rows with user_id IS NULL', t, v_nulls;
    END IF;
  END LOOP;
END $$;

-- Aplicar NOT NULL + DEFAULT auth.uid() (skip se tabela/coluna não existir)
DO $$
DECLARE
  v_tables TEXT[] := ARRAY[
    'car_profiles','sessions','shared_reports','chat_conversations',
    'chat_messages','user_quotas','maintenance_events','session_photos'
  ];
  t TEXT;
  v_exists BOOLEAN;
  v_has_user_id BOOLEAN;
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    v_exists := to_regclass('public.' || t) IS NOT NULL;
    IF NOT v_exists THEN CONTINUE; END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id'
    ) INTO v_has_user_id;
    IF NOT v_has_user_id THEN CONTINUE; END IF;

    -- user_quotas não usa auth.uid() como default (é escrito por edge functions com service_role)
    IF t = 'user_quotas' THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET NOT NULL', t);
    ELSE
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET NOT NULL, ALTER COLUMN user_id SET DEFAULT auth.uid()', t);
    END IF;
    RAISE NOTICE 'NOT NULL applied to %', t;
  END LOOP;
END $$;
