// The general Virtual assistant's conversations (mode virtual, no session):
// migration and RLS checks in an isolated in-memory PostgreSQL. No server,
// credentials or production connection is involved.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ids } from './lib/virtual-coach-fixture.mjs';

const tools = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? 'node_modules/.xpeed-audit-tools', 'package.json')));
const { PGlite } = tools('@electric-sql/pglite');
const db = await PGlite.create();
const otherSession = '20000000-0000-4000-8000-000000000002';
const coachThread = '30000000-0000-4000-8000-000000000003';
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
let passed = 0;
try {
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE FUNCTION public.current_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('test.user_id', true), '')::uuid $$;
    CREATE TABLE public.car_profiles(id uuid PRIMARY KEY, user_id uuid NOT NULL);
    CREATE TABLE public.sim_sessions(id uuid PRIMARY KEY, user_id uuid NOT NULL);
    CREATE TABLE public.chat_conversations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text DEFAULT 'Chat',
      user_id uuid NOT NULL, car_profile_id uuid REFERENCES public.car_profiles(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_chat_read ON public.chat_conversations FOR SELECT TO authenticated
      USING (user_id = public.current_app_user_id());
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT ON public.car_profiles, public.sim_sessions TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversations TO authenticated;
  `);
  await db.query('INSERT INTO car_profiles VALUES ($1,$2)', [ids.car, ids.user]);
  await db.query('INSERT INTO sim_sessions VALUES ($1,$2),($3,$4)', [ids.session, ids.user, otherSession, ids.other]);
  await db.exec(migration('20261118160000_virtual_coach_chat.sql'));
  await db.query("INSERT INTO chat_conversations(id,user_id,mode,sim_session_id) VALUES ($1,$2,'virtual',$3)", [coachThread, ids.user, ids.session]);
  const sql = migration('20261120150000_virtual_assistant_chat.sql');
  await db.exec(sql); await db.exec(sql);
  assert.equal((await db.query('SELECT id FROM chat_conversations WHERE id=$1', [coachThread])).rows.length, 1); passed++;

  const asUser = async (user, fn) => {
    await db.exec('BEGIN; SET LOCAL ROLE authenticated');
    try { await db.query("SELECT set_config('test.user_id',$1,true)", [user]); return await fn(); }
    finally { await db.exec('ROLLBACK'); }
  };
  const insert = (user, mode, session, car = null) => asUser(user, () => db.query(
    'INSERT INTO chat_conversations(user_id,mode,sim_session_id,car_profile_id) VALUES($1,$2,$3,$4) RETURNING id', [user, mode, session, car]));
  // The general Virtual thread, plus the two kinds that already existed.
  for (const [mode, session, car] of [['virtual', null, null], ['virtual', ids.session, null], ['real', null, ids.car], ['real', null, null]]) {
    assert.equal((await insert(ids.user, mode, session, car)).rows.length, 1); passed++;
  }
  for (const [user, mode, session, car] of [
    [ids.user, 'virtual', otherSession, null], [ids.user, 'virtual', null, ids.car], [ids.user, 'real', ids.session, null],
    [ids.user, 'other', null, null], [ids.other, 'virtual', ids.session, null],
  ]) {
    await assert.rejects(insert(user, mode, session, car)); passed++;
  }
  // Someone else's user id cannot be written, even for a general thread.
  await assert.rejects(asUser(ids.user, () => db.query("INSERT INTO chat_conversations(user_id,mode) VALUES($1,'virtual')", [ids.other]))); passed++;

  const general = (await db.query("INSERT INTO chat_conversations(user_id,mode) VALUES($1,'virtual') RETURNING id", [ids.user])).rows[0].id;
  assert.equal((await asUser(ids.other, () => db.query('SELECT id FROM chat_conversations WHERE id=$1', [general]))).rows.length, 0); passed++;
  assert.equal((await asUser(ids.user, () => db.query("UPDATE chat_conversations SET title='Renamed' WHERE id=$1 RETURNING id", [general]))).rows.length, 1); passed++;
  // A thread keeps its context: the general one cannot become a session coach or Real, and back.
  await assert.rejects(asUser(ids.user, () => db.query('UPDATE chat_conversations SET sim_session_id=$1 WHERE id=$2', [ids.session, general]))); passed++;
  await assert.rejects(asUser(ids.user, () => db.query("UPDATE chat_conversations SET mode='real' WHERE id=$1", [general]))); passed++;
  await assert.rejects(asUser(ids.user, () => db.query('UPDATE chat_conversations SET sim_session_id=NULL WHERE id=$1', [coachThread]))); passed++;
  // Deleting a session takes its coach threads only.
  await db.query('DELETE FROM sim_sessions WHERE id=$1', [ids.session]);
  assert.equal((await db.query('SELECT id FROM chat_conversations WHERE id=$1', [coachThread])).rows.length, 0);
  assert.equal((await db.query('SELECT id FROM chat_conversations WHERE id=$1', [general])).rows.length, 1); passed++;
  console.log(`virtual assistant SQL: ${passed} checks passed`);
} finally {
  await db.close();
}
