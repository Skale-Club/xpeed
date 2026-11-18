-- Optional Virtual session coaching shares the chat infrastructure, with a
-- separate immutable context. Existing conversations remain Real.
ALTER TABLE public.chat_conversations
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'real',
  ADD COLUMN IF NOT EXISTS sim_session_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_conversations_scope_check' AND conrelid = 'public.chat_conversations'::regclass) THEN
    ALTER TABLE public.chat_conversations ADD CONSTRAINT chat_conversations_scope_check CHECK (
      (mode = 'real' AND sim_session_id IS NULL)
      OR (mode = 'virtual' AND sim_session_id IS NOT NULL AND car_profile_id IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_conversations_sim_session_id_fkey' AND conrelid = 'public.chat_conversations'::regclass) THEN
    ALTER TABLE public.chat_conversations ADD CONSTRAINT chat_conversations_sim_session_id_fkey
      FOREIGN KEY (sim_session_id) REFERENCES public.sim_sessions(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_conversations_mode_session_updated
  ON public.chat_conversations(user_id, mode, sim_session_id, updated_at DESC);

CREATE OR REPLACE FUNCTION public.keep_chat_context() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.mode IS DISTINCT FROM OLD.mode OR NEW.sim_session_id IS DISTINCT FROM OLD.sim_session_id THEN
    RAISE EXCEPTION 'A conversation context cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS keep_chat_context ON public.chat_conversations;
CREATE TRIGGER keep_chat_context BEFORE UPDATE ON public.chat_conversations
  FOR EACH ROW EXECUTE FUNCTION public.keep_chat_context();
REVOKE ALL ON FUNCTION public.keep_chat_context() FROM PUBLIC;

DROP POLICY IF EXISTS "Users can create own conversations" ON public.chat_conversations;
CREATE POLICY "Users can create own conversations" ON public.chat_conversations
  FOR INSERT TO authenticated WITH CHECK (
    user_id = (SELECT public.current_app_user_id())
    AND (car_profile_id IS NULL OR car_profile_id IN (
      SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT public.current_app_user_id())
    ))
    AND (mode = 'real' OR sim_session_id IN (
      SELECT s.id FROM public.sim_sessions s WHERE s.user_id = (SELECT public.current_app_user_id())
    ))
  );

DROP POLICY IF EXISTS "Users can update own conversations" ON public.chat_conversations;
CREATE POLICY "Users can update own conversations" ON public.chat_conversations
  FOR UPDATE TO authenticated USING (user_id = (SELECT public.current_app_user_id()))
  WITH CHECK (
    user_id = (SELECT public.current_app_user_id())
    AND (car_profile_id IS NULL OR car_profile_id IN (
      SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT public.current_app_user_id())
    ))
    AND (mode = 'real' OR sim_session_id IN (
      SELECT s.id FROM public.sim_sessions s WHERE s.user_id = (SELECT public.current_app_user_id())
    ))
  );
