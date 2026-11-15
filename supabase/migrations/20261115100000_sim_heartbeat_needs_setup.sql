-- Xpeed Companion 0.8: the heartbeat can say a game is open but shares no data (state 'needs_setup', with the game), so the site's computer
-- card can tell the person which setting to turn on in that game. Only the allowed values of `sim_devices.last_state` change.
-- Idempotent: the old check on the column (whatever its name) is dropped and the new one added under a fixed name, so applying this again
-- drops and adds the same thing. Every row that exists already satisfies the wider check; nothing else is touched.
DO $$
DECLARE v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'public.sim_devices'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%last_state%'
  LOOP
    EXECUTE format('ALTER TABLE public.sim_devices DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

ALTER TABLE public.sim_devices
  ADD CONSTRAINT sim_devices_last_state_check CHECK (last_state IN ('idle', 'waiting', 'connected', 'needs_setup'));
