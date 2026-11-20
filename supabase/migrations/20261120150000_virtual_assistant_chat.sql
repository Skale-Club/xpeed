-- The Virtual side gets the same general assistant the Real side has (the chat
-- bubble on every screen). Its conversations are Virtual but tied to no single
-- session: mode = 'virtual' with sim_session_id NULL. Session coaching threads
-- keep their session; Real threads are unchanged. Idempotent.

ALTER TABLE public.chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_scope_check;
ALTER TABLE public.chat_conversations ADD CONSTRAINT chat_conversations_scope_check CHECK (
  (mode = 'real' AND sim_session_id IS NULL)
  OR (mode = 'virtual' AND car_profile_id IS NULL)
);

-- The general Virtual list: the caller's threads with no session, newest first.
CREATE INDEX IF NOT EXISTS chat_conversations_virtual_general_updated
  ON public.chat_conversations(user_id, updated_at DESC)
  WHERE mode = 'virtual' AND sim_session_id IS NULL;

DROP POLICY IF EXISTS "Users can create own conversations" ON public.chat_conversations;
CREATE POLICY "Users can create own conversations" ON public.chat_conversations
  FOR INSERT TO authenticated WITH CHECK (
    user_id = (SELECT public.current_app_user_id())
    AND (car_profile_id IS NULL OR car_profile_id IN (
      SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT public.current_app_user_id())
    ))
    AND (mode = 'real' OR sim_session_id IS NULL OR sim_session_id IN (
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
    AND (mode = 'real' OR sim_session_id IS NULL OR sim_session_id IN (
      SELECT s.id FROM public.sim_sessions s WHERE s.user_id = (SELECT public.current_app_user_id())
    ))
  );
