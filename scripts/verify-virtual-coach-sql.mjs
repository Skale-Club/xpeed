// Targeted migration/RLS checks in an isolated in-memory PostgreSQL. No server,
// credentials, production connection or full schema migration is involved.
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
const realThread = '30000000-0000-4000-8000-000000000002';
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
    CREATE TABLE public.chat_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid REFERENCES public.chat_conversations(id) ON DELETE CASCADE);
    ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_chat_read ON public.chat_conversations FOR SELECT TO authenticated
      USING (user_id = public.current_app_user_id());
    CREATE POLICY own_message_read ON public.chat_messages FOR SELECT TO authenticated USING (
      conversation_id IN (SELECT id FROM public.chat_conversations WHERE user_id = public.current_app_user_id()));
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT SELECT ON public.car_profiles, public.sim_sessions TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.chat_conversations TO authenticated;
    GRANT SELECT ON public.chat_messages TO authenticated;
  `);
  await db.query('INSERT INTO car_profiles VALUES ($1,$2),($3,$4)', [ids.car, ids.user, ids.track, ids.other]);
  await db.query('INSERT INTO sim_sessions VALUES ($1,$2),($3,$4)', [ids.session, ids.user, otherSession, ids.other]);
  await db.query('INSERT INTO chat_conversations(id,user_id,car_profile_id) VALUES ($1,$2,$3)', [realThread, ids.user, ids.car]);
  await db.query('INSERT INTO chat_messages(conversation_id) VALUES ($1)', [realThread]);
  const sql = readFileSync(new URL('../supabase/migrations/20261118160000_virtual_coach_chat.sql', import.meta.url), 'utf8');
  await db.exec(sql); await db.exec(sql);
  const legacy = (await db.query('SELECT mode, sim_session_id, car_profile_id FROM chat_conversations WHERE id=$1', [realThread])).rows[0];
  assert.deepEqual(legacy, { mode: 'real', sim_session_id: null, car_profile_id: ids.car }); passed++;

  const asUser = async (user, fn) => {
    await db.exec('BEGIN; SET LOCAL ROLE authenticated');
    try { await db.query("SELECT set_config('test.user_id',$1,true)", [user]); return await fn(); }
    finally { await db.exec('ROLLBACK'); }
  };
  const insert = (user, mode, session, car = null) => asUser(user, () => db.query(
    'INSERT INTO chat_conversations(user_id,mode,sim_session_id,car_profile_id) VALUES($1,$2,$3,$4) RETURNING id', [user, mode, session, car]));
  assert.equal((await insert(ids.user, 'real', null, ids.car)).rows.length, 1); passed++;
  assert.equal((await insert(ids.user, 'virtual', ids.session)).rows.length, 1); passed++;
  for (const [mode, session, car] of [['virtual', otherSession, null], ['real', null, ids.track],
    ['virtual', null, null], ['real', ids.session, null], ['virtual', ids.session, ids.car], ['other', null, null]]) {
    await assert.rejects(insert(ids.user, mode, session, car)); passed++;
  }

  await db.query('INSERT INTO chat_conversations(id,user_id,mode,sim_session_id) VALUES ($1,$2,$3,$4)', [ids.thread, ids.user, 'virtual', ids.session]);
  await db.query('INSERT INTO chat_messages(conversation_id) VALUES ($1)', [ids.thread]);
  assert.equal((await asUser(ids.other, () => db.query('SELECT id FROM chat_conversations WHERE id=$1', [ids.thread]))).rows.length, 0); passed++;
  assert.equal((await asUser(ids.other, () => db.query('SELECT id FROM chat_messages WHERE conversation_id=$1', [ids.thread]))).rows.length, 0); passed++;
  await assert.rejects(asUser(ids.user, () => db.query('UPDATE chat_conversations SET sim_session_id=$1 WHERE id=$2', [otherSession, ids.thread]))); passed++;
  await assert.rejects(asUser(ids.user, () => db.query("UPDATE chat_conversations SET mode='real',sim_session_id=NULL WHERE id=$1", [ids.thread]))); passed++;
  assert.equal((await asUser(ids.user, () => db.query("UPDATE chat_conversations SET title='Renamed' WHERE id=$1 RETURNING id", [ids.thread]))).rows.length, 1); passed++;
  await db.query('DELETE FROM sim_sessions WHERE id=$1', [ids.session]);
  assert.equal((await db.query('SELECT id FROM chat_conversations WHERE id=$1', [ids.thread])).rows.length, 0);
  assert.equal((await db.query('SELECT id FROM chat_messages WHERE conversation_id=$1', [ids.thread])).rows.length, 0);
  assert.equal((await db.query('SELECT id FROM chat_conversations WHERE id=$1', [realThread])).rows.length, 1); passed++;
  console.log(`Virtual coach SQL: ${passed} checks passed (repeatability, legacy preservation, ownership, immutable scope and session erasure).`);
} finally { await db.close(); }
