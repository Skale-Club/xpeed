-- Xpeed Companion's heartbeat (docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md, section 2c): a running computer says "I am here" once
-- a minute, and when a game connects or goes away, so the site can tell a computer that is on from one that only sent its last lap a while ago.
-- Until now `last_seen_at` moved only when the computer called the server for a lap or a track layout.
-- Additive and idempotent: four new nullable columns (IF NOT EXISTS), one new function and the overview's device object with four more keys
-- (CREATE OR REPLACE; every existing key stays). Nothing existing is dropped or renamed.

-- What the computer last said about itself. All nullable: a computer that never sent a heartbeat (an older Companion) has none of it.
-- `last_state_at` is when the state or the game last CHANGED (how long it has been "connected"), not when it was last repeated.
ALTER TABLE public.sim_devices
  ADD COLUMN IF NOT EXISTS companion_version text CHECK (char_length(companion_version) BETWEEN 1 AND 32),
  ADD COLUMN IF NOT EXISTS last_state text CHECK (last_state IN ('idle', 'waiting', 'connected')),
  ADD COLUMN IF NOT EXISTS last_game text CHECK (char_length(last_game) BETWEEN 1 AND 32),
  ADD COLUMN IF NOT EXISTS last_state_at timestamptz;

-- The person may read the new columns of their own devices (the key hash is still not offered).
GRANT SELECT (companion_version, last_state, last_game, last_state_at) ON public.sim_devices TO authenticated;

-- One heartbeat, in one call: finds the device behind the key, counts the hit (p_max a minute, in the database like the upload limiter, so
-- every server instance shares it), and writes what the computer said. Answers
--   null                                    the key is unknown or revoked,
--   {status: 'rate', wait}                  too many in this minute (nothing is written: a flood does not move last_seen_at),
--   {status: 'ok', user_id, changed}        recorded; `changed` is true when the state or the game differs from the last heartbeat.
CREATE OR REPLACE FUNCTION public.sim_device_heartbeat(p_token_hash text, p_version text, p_state text, p_game text, p_max integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_user uuid; v_wait integer; v_changed boolean;
BEGIN
  SELECT id, user_id, (last_state IS DISTINCT FROM p_state OR last_game IS DISTINCT FROM p_game)
    INTO v_id, v_user, v_changed FROM public.sim_devices WHERE token_hash = p_token_hash AND revoked_at IS NULL;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  v_wait := public.sim_rate_hit('hb:' || v_id::text, p_max, 60);
  IF v_wait > 0 THEN RETURN jsonb_build_object('status', 'rate', 'wait', v_wait); END IF;
  UPDATE public.sim_devices d SET
    last_seen_at = now(),
    companion_version = p_version,
    last_state_at = CASE WHEN v_changed OR d.last_state_at IS NULL THEN now() ELSE d.last_state_at END,
    last_state = p_state,
    last_game = p_game
  WHERE d.id = v_id AND d.revoked_at IS NULL;
  RETURN jsonb_build_object('status', 'ok', 'user_id', v_user, 'changed', v_changed);
END $$;

REVOKE ALL ON FUNCTION public.sim_device_heartbeat(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_device_heartbeat(text, text, text, text, integer) TO service_role;

-- The overview's Companion status: the same as before, and each device also says what it last reported (null until its first heartbeat).
CREATE OR REPLACE FUNCTION public.sim_v1_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN jsonb_build_object(
    'latestSessions', coalesce((SELECT jsonb_agg(x.j ORDER BY x.started_at DESC, x.id DESC) FROM (
      SELECT s.id, s.started_at, public.sim_session_json(s, t.name, c.name) AS j
      FROM public.sim_sessions s JOIN public.sim_track_catalog t ON t.id = s.track_id JOIN public.sim_car_catalog c ON c.id = s.car_id
      WHERE s.user_id = v_user ORDER BY s.started_at DESC, s.id DESC LIMIT 5) x), '[]'::jsonb),
    'latestPersonalBests', coalesce((SELECT jsonb_agg(x.j ORDER BY x.achieved_at DESC, x.lap_id DESC) FROM (
      SELECT b.achieved_at, b.lap_id,
        jsonb_build_object('game', t.game, 'track', jsonb_build_object('id', t.id, 'name', t.name), 'car', jsonb_build_object('id', c.id, 'name', c.name),
          'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at),
          'previousBestMs', pv.ms, 'improvedByMs', pv.ms - b.best_ms) AS j
      FROM public.sim_personal_bests b JOIN public.sim_track_catalog t ON t.id = b.track_id JOIN public.sim_car_catalog c ON c.id = b.car_id
        LEFT JOIN LATERAL (SELECT public.sim_previous_best(v_user, b.track_id, b.car_id, b.lap_id, b.achieved_at, b.best_ms) AS ms) pv ON true
      WHERE b.user_id = v_user ORDER BY b.achieved_at DESC, b.lap_id DESC LIMIT 5) x), '[]'::jsonb),
    'lapsPerGame', coalesce((SELECT jsonb_agg(g.j ORDER BY g.laps DESC, g.game) FROM (
      SELECT l.game, count(*) AS laps,
        jsonb_build_object('game', l.game, 'laps', count(*), 'validLaps', count(*) FILTER (WHERE l.valid AND l.time_ms > 0),
          'sessions', count(DISTINCT l.session_id), 'lastDrivenAt', public.sim_iso(max(l.started_at))) AS j
      FROM public.sim_laps l WHERE l.user_id = v_user GROUP BY l.game) g), '[]'::jsonb),
    'companion', jsonb_build_object(
      'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'pairedAt', public.sim_iso(d.created_at),
          'lastSeenAt', public.sim_iso(d.last_seen_at), 'lastLapAt', public.sim_iso(d.last_lap_at),
          'version', d.companion_version, 'state', d.last_state, 'game', d.last_game, 'stateAt', public.sim_iso(d.last_state_at)) ORDER BY d.created_at DESC, d.id)
        FROM public.sim_devices d WHERE d.user_id = v_user AND d.revoked_at IS NULL), '[]'::jsonb),
      'lastLap', (SELECT public.sim_lap_json(l, t.name, c.name, d.name)
        FROM public.sim_laps l LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
          LEFT JOIN public.sim_devices d ON d.id = l.device_id
        WHERE l.user_id = v_user ORDER BY l.created_at DESC, l.id DESC LIMIT 1)),
    'storage', (SELECT jsonb_build_object('lapCount', count(*), 'usedBytes', coalesce(sum(l.size_bytes), 0)) FROM public.sim_laps l WHERE l.user_id = v_user));
END $$;
