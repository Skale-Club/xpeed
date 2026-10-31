// Real PostgreSQL/WASM, entirely in memory. No .env, network, or remote credentials.
// Install isolated tooling: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts @electric-sql/pglite
// node scripts/verify-processing-sql.mjs [--bootstrap]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { PGlite } = await import(pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/pglite/dist/index.js')).href);
const db = new PGlite();
const migration = name => readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', ADMIN = '33333333-3333-4333-8333-333333333333';
const car = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherCar = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const trip = 'aaaaaaaa-1111-4111-8111-111111111111', recorded = 'aaaaaaaa-2222-4222-8222-222222222222';
const checks = [];
const check = async (name, test) => { await test(); checks.push(name); };
const compat = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}', raw_app_meta_data jsonb DEFAULT '{}', created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_user::text $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, owner_id text, metadata jsonb);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;
GRANT ALL ON storage.objects,storage.buckets TO anon,authenticated,service_role;
`;
const asUser = async (id, role = 'authenticated') => {
  await db.exec(`RESET ROLE; SET ROLE ${role}`);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
};
const payload = { rows: [{ t_seconds: 0, t_timestamp: null, data: { Coolant: 120 } }, { t_seconds: 20, data: { Coolant: 120 } }], flags: [{ severity: 'critical', canonical_key: 'coolant_temp', parameter_key: 'Coolant', message: 'Hot', evidence: { max: 120 } }], summary: { summaries: [], marker: 'new', faultCodes:{stored:[],pending:['P0300'],permanent:[],checked:true,complete:false,modules:['7E0']} }, report: { version: 1, marker: 'new' }, columns: ['Time','Coolant'], row_count: 2, duration_seconds: 20, active_dtcs: ['P0300'], ruleset_id: 'generic-petrol', ruleset_matched_via: 'engine', report_version: 1, processing_version: 'processing-2' };
const snapshot = async () => (await db.query(`SELECT jsonb_build_object('trip',(SELECT to_jsonb(s) FROM public.sessions s WHERE id='${trip}'), 'rows',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.session_rows r WHERE session_id='${trip}'), 'flags',(SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM public.session_flags f WHERE session_id='${trip}')) AS state`)).rows[0].state;

try {
  await db.exec(compat);
  if (process.argv.includes('--bootstrap')) {
    const applied = [];
    let failure = null;
    for (const name of readdirSync(resolve(root, 'supabase/migrations')).filter(n => n.endsWith('.sql')).sort()) {
      try { await db.exec(`BEGIN;\n${migration(name)}\nCOMMIT;`); applied.push(name); }
      catch (error) { await db.exec('ROLLBACK'); failure = { migration: name, message: error.message, code: error.code }; break; }
    }
    if (!failure) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4),($5,$6)',[A,'a@example.test',B,'b@example.test',ADMIN,'admin@example.test']);
      await asUser(A); await db.query('INSERT INTO public.car_profiles(id,user_id,name,is_admin) VALUES($1,$2,$3,true)',[car,A,'Car A']);
      assert.equal((await db.query('SELECT is_admin FROM public.car_profiles WHERE id=$1',[car])).rows[0].is_admin,false);
      await asUser(B); await db.query('INSERT INTO public.car_profiles(id,user_id,name) VALUES($1,$2,$3)',[otherCar,B,'Car B']);
      await asUser(A);
      const save = () => db.query('SELECT public.store_recorded_session($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS saved',[trip,A,car,'a'.repeat(64),'original.csv',null,null,'original',JSON.stringify(payload)]);
      await check('real migrated policies allow A to publish once and recognize retry',async () => { assert.equal((await save()).rows[0].saved,true); assert.equal((await save()).rows[0].saved,false); });
      const conversation='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const issue='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const share='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      await db.query('INSERT INTO public.chat_conversations(id,user_id,car_profile_id,title) VALUES($1,$2,$3,$4)',[conversation,A,car,'A chat']);
      await db.query("INSERT INTO public.session_photos(session_id,user_id,storage_path) VALUES($1,$2,$3)",[trip,A,`${A}/photo.png`]);
      await db.query("INSERT INTO public.maintenance_events(user_id,car_profile_id,event_type,performed_at) VALUES($1,$2,'inspection','2026-10-29')",[A,car]);
      await db.query("INSERT INTO public.vehicle_issues(id,user_id,car_profile_id,canonical_key,title,severity,first_seen_at,last_seen_at) VALUES($1,$2,$3,'coolant_temp','Hot','serious',now(),now())",[issue,A,car]);
      await db.query('INSERT INTO public.shared_reports(id,user_id,session_id) VALUES($1,$2,$3)',[share,A,trip]);
      await db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('session-csv',$1)",[`${A}/original.csv`]);
      await asUser(B);
      await check('B cannot list A trips, readings, flags, issues, chat, maintenance, photos or storage',async () => {
        for (const table of ['sessions','session_rows','session_flags','vehicle_issues','chat_conversations','maintenance_events','session_photos']) {
          assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n,0,table);
        }
        assert.equal((await db.query("SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id='session-csv'")).rows[0].n,0);
      });
      await check('cross-owner parent relationships and RPCs are rejected',async () => {
        await assert.rejects(save());
        await assert.rejects(db.query('SELECT public.reprocess_session($1,$2::jsonb)',[trip,JSON.stringify(payload)]));
        await assert.rejects(db.query("INSERT INTO public.session_photos(session_id,user_id,storage_path) VALUES($1,$2,'fake')",[trip,B]));
        await assert.rejects(db.query("INSERT INTO public.chat_conversations(user_id,car_profile_id,title) VALUES($1,$2,'fake')",[B,car]));
        await assert.rejects(db.query("INSERT INTO public.maintenance_events(user_id,car_profile_id,event_type,performed_at) VALUES($1,$2,'inspection','2026-10-29')",[B,car]));
        await assert.rejects(db.query("INSERT INTO public.vehicle_issue_occurrences(issue_id,session_id,severity,occurred_at) VALUES($1,$2,'serious',now())",[issue,trip]));
        await assert.rejects(db.query("INSERT INTO storage.objects(bucket_id,name) VALUES('session-csv',$1)",[`${A}/fake.csv`]));
      });
      // Fixture admin promotion is privileged setup, never an API operation.
      await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[ADMIN]);
      await db.exec('ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin_insert');
      await db.query("INSERT INTO public.car_profiles(user_id,name,is_admin) VALUES($1,'Admin Profile',true)",[ADMIN]);
      await db.exec('ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin_insert');
      await asUser(ADMIN);
      await check('support admin keeps SELECT but cannot reprocess or change A ownership',async () => {
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.sessions')).rows[0].n,1);
        await assert.rejects(db.query('SELECT public.reprocess_session($1,$2::jsonb)',[trip,JSON.stringify(payload)]));
        assert.equal((await db.query("UPDATE public.car_profiles SET name='corrupt' WHERE id=$1 RETURNING id",[car])).rows.length,0);
      });
      await asUser(null,'anon');
      await check('anon cannot list private data; an explicit share works until revoked',async () => {
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.sessions')).rows[0].n,0);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.shared_reports')).rows[0].n,0);
        const shared=(await db.query('SELECT public.get_shared_report($1) AS report',[share])).rows[0].report;
        assert.deepEqual(shared.session.summary.faultCodes,payload.summary.faultCodes);
        await asUser(A); await db.query('DELETE FROM public.shared_reports WHERE id=$1',[share]);
        await asUser(null,'anon');
        assert.equal((await db.query('SELECT public.get_shared_report($1) AS report',[share])).rows[0].report,null);
      });
      await asUser(A);
      await check('durable issue jobs survive retries and only the current version can be acknowledged',async()=>{
        const job=(await db.query('SELECT * FROM public.session_issue_jobs WHERE session_id=$1',[trip])).rows[0];
        assert.ok(job);
        await db.query("UPDATE public.sessions SET active_dtcs='[\"P0171\"]'::jsonb WHERE id=$1",[trip]);
        assert.equal((await db.query('DELETE FROM public.session_issue_jobs WHERE session_id=$1 AND version=$2 RETURNING session_id',[trip,job.version])).rows.length,0);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.session_issue_jobs WHERE session_id=$1',[trip])).rows[0].n,1);
        await db.query("UPDATE public.session_issue_jobs SET retry_at=now()+interval '1 minute' WHERE session_id=$1",[trip]);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.session_issue_jobs WHERE retry_at<=now()')).rows[0].n,0);
        await assert.rejects(db.query('UPDATE public.session_issue_jobs SET car_profile_id=$1 WHERE session_id=$2',[otherCar,trip]));
        await db.query("UPDATE public.sessions SET summary=summary || '{\"analysis_outdated\":true}'::jsonb WHERE id=$1",[trip]);
        await db.query("UPDATE public.sessions SET gemini_analysis='{\"summary\":\"Fresh analysis\",\"warnings\":[]}'::jsonb WHERE id=$1",[trip]);
        assert.equal((await db.query("SELECT summary ? 'analysis_outdated' AS outdated FROM public.sessions WHERE id=$1",[trip])).rows[0].outdated,false);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.session_issue_jobs WHERE retry_at<=now()')).rows[0].n,1);
        await asUser(B);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.session_issue_jobs')).rows[0].n,0);
        await asUser(A);
      });
      await check('an intentional deletion blocks recovery even after checkpoint cleanup failure',async()=>{
        await db.query('DELETE FROM public.sessions WHERE id=$1',[trip]);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.session_deletions WHERE recording_id=$1',[trip])).rows[0].n,1);
        await assert.rejects(db.query('INSERT INTO public.sessions(id,user_id,car_profile_id,source_filename) VALUES($1,$2,$3,$4)',[trip,A,car,'resurrect.csv']),/Recording intentionally deleted/);
        await asUser(B);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.session_deletions')).rows[0].n,0);
        await asUser(A);
      });
      await check('database pagination and timezone calendar handle 300 trips without transferring the entire history',async()=>{
        const pagedCar='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        await db.query('INSERT INTO public.car_profiles(id,user_id,name) VALUES($1,$2,$3)',[pagedCar,A,'Paging']);
        await db.query("INSERT INTO public.sessions(user_id,car_profile_id,source_filename,session_start) SELECT $1,$2,'Journey '||i,'2026-11-01T01:00:00Z'::timestamptz + i*interval '1 minute' FROM generate_series(0,299) i",[A,pagedCar]);
        const page=(await db.query("SELECT public.trip_page($1,15,20,NULL,'America/New_York') AS page",[pagedCar])).rows[0].page;
        assert.equal(page.total,300);assert.equal(page.items.length,20);assert.equal(page.items.at(-1).source_filename,'Journey 0');
        const days=(await db.query("SELECT public.trip_calendar($1,'2026-10','America/New_York') AS days",[pagedCar])).rows[0].days;
        assert.equal(days['2026-10-31'],180);
        const day=(await db.query("SELECT public.trip_page($1,1,20,'2026-10-31','America/New_York') AS page",[pagedCar])).rows[0].page;
        assert.equal(day.total,180);assert.equal(day.items.length,20);
        await asUser(B);
        assert.equal((await db.query('SELECT public.trip_page($1) AS page',[pagedCar])).rows[0].page.total,0);
        await asUser(A);
        await db.query('DELETE FROM public.car_profiles WHERE id=$1',[pagedCar]); // Cascades must remain valid.
      });
    }
    if(!failure) await check('photo quota is separate, bounded, refundable and service-role only',async()=>{
      await db.exec('RESET ROLE; SET ROLE service_role');
      const consume=()=>db.query("SELECT public.consume_quota($1,'fuel_receipts',2) AS remaining",[A]);
      assert.equal((await consume()).rows[0].remaining,1);
      assert.equal((await consume()).rows[0].remaining,0);
      await assert.rejects(consume,/quota_exceeded/);
      await db.query("SELECT public.refund_quota($1,'fuel_receipts')",[A]);
      assert.equal((await consume()).rows[0].remaining,0);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM public.user_quotas WHERE user_id=$1 AND kind='analysis'",[A])).rows[0].count,0);
      await asUser(A);await assert.rejects(consume,/permission denied/);
    });
    const result = { runtime: 'PGlite/PostgreSQL with synthetic auth/storage compatibility schema', applied, failure, checks, caveat: 'Real migrated SQL policies; not Supabase services, gateway, Storage server, or production migration certification.' };
    writeFileSync(resolve(root, 'docs/revisao-2026-10-29/bootstrap-sql.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ applied: applied.length, failure, checks }));
    if (failure) process.exitCode = 1;
  } else {
    await db.exec(migration('20260206193301_820f8520-db2f-4ded-a40a-5eab76b49b13.sql'));
    await db.exec(`ALTER TABLE public.car_profiles ADD COLUMN user_id uuid REFERENCES auth.users(id);
      ALTER TABLE public.sessions ADD COLUMN user_id uuid REFERENCES auth.users(id), ADD COLUMN source_file_path text, ADD COLUMN source_csv text, ADD COLUMN active_dtcs jsonb, ADD COLUMN report jsonb, ADD COLUMN ruleset_id text, ADD COLUMN ruleset_matched_via text, ADD COLUMN report_version integer, ADD COLUMN processing_version integer NOT NULL DEFAULT 1;
      ALTER TABLE public.session_flags ADD COLUMN resolved boolean DEFAULT false;
      INSERT INTO auth.users(id,email) VALUES('${A}','a@example.test'),('${B}','b@example.test'),('${ADMIN}','admin@example.test');
      INSERT INTO public.car_profiles(id,user_id,name) VALUES('${car}','${A}','A'),('${otherCar}','${B}','B');
      INSERT INTO public.sessions(id,user_id,car_profile_id,source_filename,summary) VALUES('${trip}','${A}','${car}','original.csv','{"marker":"old"}');
      INSERT INTO public.session_rows(session_id,t_seconds,data) VALUES('${trip}',0,'{"old":1}');
      INSERT INTO public.session_flags(session_id,severity,canonical_key,parameter_key,message,resolved) VALUES('${trip}','critical','coolant_temp','Coolant','Old',true);`);
    await db.exec(migration('20260528000003_vehicle_issues.sql'));
    const triggerFunction = migration('20260528100000_security_hardening.sql').match(/CREATE OR REPLACE FUNCTION public.touch_vehicle_issue_updated_at\(\)[\s\S]*?\$\$;/)?.[0];
    assert.ok(triggerFunction); await db.exec(triggerFunction);
    await db.exec(`INSERT INTO public.vehicle_issues(id,user_id,car_profile_id,canonical_key,title,severity,first_seen_at,last_seen_at) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${A}','${car}','coolant_temp','Hot','serious',now(),now());`);
    await db.exec(migration('20261028000000_vehicle_issues_rebuild.sql'));
    // Explicit owner fixtures + admin SELECT prove the new functions' contract;
    // they do not stand in for a complete replay of every historical RLS policy.
    for (const table of ['car_profiles','sessions','session_rows','session_flags']) {
      const policies = await db.query('SELECT policyname FROM pg_policies WHERE schemaname=$1 AND tablename=$2', ['public',table]);
      for (const p of policies.rows) await db.exec(`DROP POLICY "${p.policyname.replaceAll('"','""')}" ON public.${table}`);
      const predicate = table === 'car_profiles' || table === 'sessions' ? 'user_id=auth.uid()' : 'session_id IN (SELECT id FROM public.sessions WHERE user_id=auth.uid())';
      await db.exec(`CREATE POLICY owner ON public.${table} FOR ALL TO authenticated USING(${predicate}) WITH CHECK(${predicate}); CREATE POLICY support_read ON public.${table} FOR SELECT TO authenticated USING(auth.uid()='${ADMIN}');`);
    }
    const sql = migration('20261029110000_stabilize_processing.sql');
    await check('additive upgrade and repeat preserve existing issue IDs', async () => {
      await db.exec(sql); await db.exec(sql);
      assert.equal((await db.query("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='sessions' AND column_name='processing_version'")).rows[0].data_type,'text');
      assert.equal((await db.query('SELECT processing_version FROM public.sessions WHERE id=$1',[trip])).rows[0].processing_version,'1');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.vehicle_issues')).rows[0].n, 1);
      await db.exec("UPDATE public.vehicle_issues SET details='{}'");
      assert.ok((await db.query('SELECT updated_at FROM public.vehicle_issues')).rows[0].updated_at);
    });
    await asUser(A);
    const reprocess = p => db.query('SELECT public.reprocess_session($1,$2::jsonb)', [trip,JSON.stringify(p)]);
    await check('owner atomically replaces derivatives, preserves identity and resolved flag', async () => {
      await reprocess(payload);
      const state = await snapshot();
      assert.equal(state.trip.id, trip); assert.equal(state.trip.summary.marker,'new');
      assert.equal(state.rows.length,2); assert.equal(state.flags.length,1); assert.equal(state.flags[0].resolved,true);
    });
    await check('failed insert rolls back preceding update/deletes', async () => {
      const before = await snapshot();
      await assert.rejects(reprocess({ ...payload, summary: { marker:'corrupt' }, flags: [{...payload.flags[0], severity:'invalid'}] }));
      assert.deepEqual(await snapshot(), before);
    });
    const store = (id, hash = 'a'.repeat(64), p = payload) => db.query('SELECT public.store_recorded_session($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS published', [id,A,car,hash,'recorded.csv','2026-10-29T00:00:00Z',null,'Time,Coolant\n0,120\n20,120',JSON.stringify(p)]);
    await check('recording publishes once; retry keeps the same receipt and derivatives', async () => {
      assert.equal((await store(recorded)).rows[0].published,true);
      assert.equal((await store(recorded)).rows[0].published,false);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.sessions WHERE id=$1',[recorded])).rows[0].n,1);
      await db.query('SELECT public.reprocess_session($1,$2::jsonb)',[recorded,JSON.stringify(payload)]);
      assert.equal((await store(recorded)).rows[0].published,false); // re-evaluation must keep receipt
      await assert.rejects(store(recorded,'b'.repeat(64)));
    });
    await check('failed recording publishes no partial session or data', async () => {
      const id='aaaaaaaa-4444-4444-8444-444444444444';
      await assert.rejects(store(id,'a'.repeat(64),{...payload,flags:[{...payload.flags[0],severity:'invalid'}]}));
      assert.equal((await db.query('SELECT count(*)::int AS n FROM public.sessions WHERE id=$1',[id])).rows[0].n,0);
    });
    await check('other owner and support admin cannot mutate A through either RPC', async () => {
      for (const id of [B,ADMIN]) { await asUser(id); await assert.rejects(reprocess(payload)); await assert.rejects(store(recorded)); }
    });
    await check('anon cannot execute either RPC', async () => {
      await asUser(null,'anon'); await assert.rejects(reprocess(payload)); await assert.rejects(store(recorded));
    });
    const result = { runtime: 'PostgreSQL in PGlite', checks, caveat: 'Focused schema/RLS fixtures; not whole-project Supabase/RLS, gateway or real simultaneous connections.' };
    writeFileSync(resolve(root,'docs/revisao-2026-10-29/processing-sql.json'),JSON.stringify(result,null,2)+'\n');
    console.log(`${checks.length} PostgreSQL checks passed: ${checks.join('; ')}`);
  }
} catch (error) {
  console.error(JSON.stringify({ message:error.message, code:error.code, where:error.where }));
  process.exitCode = 1;
} finally { await db.close(); }
