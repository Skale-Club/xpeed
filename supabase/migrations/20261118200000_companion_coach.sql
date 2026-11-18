-- A paired recorder does not acquire paid-AI permission automatically. Only the
-- Google-authenticated owner endpoint can change this opt-in, which starts off.
ALTER TABLE public.sim_devices ADD COLUMN IF NOT EXISTS companion_coach_enabled boolean NOT NULL DEFAULT false;
GRANT SELECT(companion_coach_enabled) ON public.sim_devices TO authenticated;
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS in_reply_to uuid REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS companion_device_id uuid REFERENCES public.sim_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coach_request_status text CHECK (coach_request_status IN ('pending','completed','failed'));
CREATE UNIQUE INDEX IF NOT EXISTS chat_companion_reply_once ON public.chat_messages(in_reply_to)
  WHERE in_reply_to IS NOT NULL AND role = 'assistant';
CREATE INDEX IF NOT EXISTS chat_companion_pending ON public.chat_messages(companion_device_id,created_at)
  WHERE coach_request_status = 'pending';

CREATE OR REPLACE FUNCTION public.sim_companion_coach_allowed(p_user uuid,p_device uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS(SELECT 1 FROM public.sim_devices d WHERE d.id=p_device AND d.user_id=p_user
   AND d.revoked_at IS NULL AND d.companion_coach_enabled)
$$;
CREATE OR REPLACE FUNCTION public.sim_companion_coach_session(p_user uuid,p_device uuid,p_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT public.sim_companion_coach_allowed(p_user,p_device) AND EXISTS(
   SELECT 1 FROM public.sim_sessions s WHERE s.id=p_session AND s.user_id=p_user AND EXISTS(
     SELECT 1 FROM public.sim_laps l WHERE l.session_id=s.id AND l.user_id=p_user AND l.device_id=p_device))
$$;
CREATE OR REPLACE FUNCTION public.sim_companion_coach_sessions(p_user uuid,p_device uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'game',s.game,'track',left(s.track,120),'car',left(s.car,120),
   'kind',s.kind,'startedAt',s.started_at) ORDER BY s.started_at DESC,s.id DESC),'[]'::jsonb)
 FROM (SELECT s.id,s.game,t.name AS track,c.name AS car,s.kind,s.started_at FROM public.sim_sessions s
   JOIN public.sim_track_catalog t ON t.id=s.track_id JOIN public.sim_car_catalog c ON c.id=s.car_id
   WHERE s.user_id=p_user AND public.sim_companion_coach_allowed(p_user,p_device) AND EXISTS(
     SELECT 1 FROM public.sim_laps l WHERE l.session_id=s.id AND l.user_id=p_user AND l.device_id=p_device)
   ORDER BY s.started_at DESC,s.id DESC LIMIT 20) s
$$;
CREATE OR REPLACE FUNCTION public.sim_companion_coach_history(p_user uuid,p_device uuid,p_session uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE conversation uuid; messages jsonb; pending_id uuid; pending_text text;
BEGIN
 IF NOT public.sim_companion_coach_session(p_user,p_device,p_session) THEN RETURN NULL; END IF;
 SELECT m.id,c.id,m.parts->0->>'text' INTO pending_id,conversation,pending_text
   FROM public.chat_messages m JOIN public.chat_conversations c ON c.id=m.conversation_id
   WHERE c.user_id=p_user AND c.mode='virtual' AND c.sim_session_id=p_session AND m.role='user'
     AND m.companion_device_id=p_device AND m.coach_request_status='pending'
     AND char_length(m.parts->0->>'text') BETWEEN 1 AND 2000
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
 IF conversation IS NULL THEN
   SELECT c.id INTO conversation FROM public.chat_conversations c WHERE c.user_id=p_user
     AND c.mode='virtual' AND c.sim_session_id=p_session ORDER BY c.updated_at DESC,c.id DESC LIMIT 1;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',m.role,'content',m.content) ORDER BY m.created_at,m.id),'[]'::jsonb)
 INTO messages FROM (SELECT m.id,m.role,m.created_at,left(coalesce((
   SELECT string_agg(part->>'text',E'\n' ORDER BY ordinal) FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(m.parts)='array' THEN m.parts ELSE '[]'::jsonb END) WITH ORDINALITY AS p(part,ordinal)
   WHERE part->>'type'='text'),''),1500) AS content FROM public.chat_messages m
   WHERE m.conversation_id=conversation ORDER BY m.created_at DESC,m.id DESC LIMIT 12) m;
 RETURN jsonb_build_object('conversationId',conversation,'messages',messages,'pendingRequest',
   CASE WHEN pending_id IS NULL THEN NULL ELSE jsonb_build_object('idempotencyKey',pending_id,'conversationId',conversation,'message',pending_text) END);
END $$;

-- Full authenticated-owner Virtual export includes shared coach history, but
-- never Real-car conversations, device key hashes or provider credentials.
CREATE OR REPLACE FUNCTION public.sim_companion_export_chat(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT jsonb_build_object('conversations',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'id',c.id,'title',c.title,'sessionId',c.sim_session_id,'createdAt',c.created_at,'updatedAt',c.updated_at) ORDER BY c.created_at,c.id)
   FROM public.chat_conversations c WHERE c.user_id=p_user AND c.mode='virtual'),'[]'::jsonb),
   'messages',coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'conversationId',m.conversation_id,
     'role',m.role,'parts',m.parts,'createdAt',m.created_at,'inReplyTo',m.in_reply_to,'requestStatus',m.coach_request_status)
     ORDER BY m.created_at,m.id) FROM public.chat_messages m JOIN public.chat_conversations c ON c.id=m.conversation_id
     WHERE c.user_id=p_user AND c.mode='virtual'),'[]'::jsonb))
$$;

-- Persist the question before spending. Its client-generated UUID is an
-- idempotency key across process restarts and multiple server instances.
CREATE OR REPLACE FUNCTION public.sim_companion_coach_begin(
 p_user uuid,p_device uuid,p_session uuid,p_conversation uuid,p_message_id uuid,p_message text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE question public.chat_messages%ROWTYPE; conversation uuid; cached text;
BEGIN
 IF NOT public.sim_companion_coach_allowed(p_user,p_device) THEN
   RETURN jsonb_build_object('status','disabled'); END IF;
 IF NOT public.sim_companion_coach_session(p_user,p_device,p_session) THEN
   RETURN jsonb_build_object('status','not_found'); END IF;
 IF p_message_id IS NULL OR p_message IS NULL OR char_length(btrim(p_message))=0 OR char_length(p_message)>2000 THEN
   RETURN jsonb_build_object('status','invalid'); END IF;
 -- This lock lasts only for the metadata transaction, never the provider call.
 PERFORM pg_advisory_xact_lock(hashtextextended('companion-coach:'||p_user::text,0));
 SELECT * INTO question FROM public.chat_messages m WHERE m.id=p_message_id;
 IF FOUND THEN
   IF question.role<>'user' OR question.companion_device_id IS DISTINCT FROM p_device
     OR question.parts IS DISTINCT FROM jsonb_build_array(jsonb_build_object('type','text','text',p_message))
     OR NOT EXISTS(SELECT 1 FROM public.chat_conversations c WHERE c.id=question.conversation_id
       AND c.user_id=p_user AND c.mode='virtual' AND c.sim_session_id=p_session)
     OR (p_conversation IS NOT NULL AND p_conversation<>question.conversation_id)
   THEN RETURN jsonb_build_object('status','invalid'); END IF;
   SELECT m.parts->0->>'text' INTO cached FROM public.chat_messages m
     WHERE m.in_reply_to=question.id AND m.role='assistant' AND m.conversation_id=question.conversation_id;
   RETURN jsonb_build_object('status',CASE WHEN cached IS NOT NULL THEN 'replied'
     WHEN question.coach_request_status='failed' THEN 'failed' ELSE 'pending' END,
     'conversationId',question.conversation_id,'reply',cached);
 END IF;
 IF EXISTS(SELECT 1 FROM public.chat_messages m JOIN public.chat_conversations c ON c.id=m.conversation_id
   WHERE c.user_id=p_user AND m.companion_device_id=p_device AND m.coach_request_status='pending'
     AND m.created_at>now()-interval '2 minutes') THEN RETURN jsonb_build_object('status','busy'); END IF;
 IF p_conversation IS NOT NULL THEN
   SELECT c.id INTO conversation FROM public.chat_conversations c WHERE c.id=p_conversation AND c.user_id=p_user
     AND c.mode='virtual' AND c.sim_session_id=p_session;
   IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 ELSE
   SELECT c.id INTO conversation FROM public.chat_conversations c WHERE c.user_id=p_user
     AND c.mode='virtual' AND c.sim_session_id=p_session ORDER BY c.updated_at DESC,c.id DESC LIMIT 1;
 END IF;
 IF conversation IS NULL THEN
   INSERT INTO public.chat_conversations(user_id,title,mode,sim_session_id)
     VALUES(p_user,'Companion coach','virtual',p_session) RETURNING id INTO conversation;
 END IF;
 INSERT INTO public.chat_messages(id,conversation_id,role,parts,companion_device_id,coach_request_status)
   VALUES(p_message_id,conversation,'user',jsonb_build_array(jsonb_build_object('type','text','text',p_message)),p_device,'pending');
 UPDATE public.chat_conversations SET updated_at=now() WHERE id=conversation;
 RETURN jsonb_build_object('status','created','conversationId',conversation);
END $$;

CREATE OR REPLACE FUNCTION public.sim_companion_coach_finish(p_user uuid,p_device uuid,p_message_id uuid,p_reply text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE question public.chat_messages%ROWTYPE;
BEGIN
 SELECT m.* INTO question FROM public.chat_messages m JOIN public.chat_conversations c ON c.id=m.conversation_id
   WHERE m.id=p_message_id AND c.user_id=p_user AND c.mode='virtual' AND m.role='user'
     AND m.companion_device_id=p_device FOR UPDATE OF m;
 IF NOT FOUND THEN RETURN false; END IF;
 IF question.coach_request_status='completed' THEN RETURN true; END IF;
 IF question.coach_request_status IS DISTINCT FROM 'pending' THEN RETURN false; END IF;
 IF p_reply IS NULL THEN
   UPDATE public.chat_messages SET coach_request_status='failed' WHERE id=p_message_id;
   RETURN true;
 END IF;
 IF char_length(btrim(p_reply))=0 OR char_length(p_reply)>6000 THEN RETURN false; END IF;
 INSERT INTO public.chat_messages(conversation_id,role,parts,in_reply_to)
   VALUES(question.conversation_id,'assistant',jsonb_build_array(jsonb_build_object('type','text','text',p_reply)),p_message_id)
   ON CONFLICT (in_reply_to) WHERE in_reply_to IS NOT NULL AND role='assistant' DO NOTHING;
 UPDATE public.chat_messages SET coach_request_status='completed' WHERE id=p_message_id;
 UPDATE public.chat_conversations SET updated_at=now() WHERE id=question.conversation_id;
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.sim_companion_coach_allowed(uuid,uuid),public.sim_companion_coach_session(uuid,uuid,uuid),
 public.sim_companion_coach_sessions(uuid,uuid),public.sim_companion_coach_history(uuid,uuid,uuid),
 public.sim_companion_coach_begin(uuid,uuid,uuid,uuid,uuid,text),public.sim_companion_coach_finish(uuid,uuid,uuid,text),public.sim_companion_export_chat(uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sim_companion_coach_allowed(uuid,uuid),public.sim_companion_coach_session(uuid,uuid,uuid),
 public.sim_companion_coach_sessions(uuid,uuid),public.sim_companion_coach_history(uuid,uuid,uuid),
 public.sim_companion_coach_begin(uuid,uuid,uuid,uuid,uuid,text),public.sim_companion_coach_finish(uuid,uuid,uuid,text),public.sim_companion_export_chat(uuid) TO service_role;
