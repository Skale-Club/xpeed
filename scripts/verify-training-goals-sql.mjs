// Isolated PostgreSQL contracts: no server, app database, provider or credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? 'node_modules/.xpeed-audit-tools', 'package.json')));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = id(1), other = id(2), source = id(3), track = id(4), car = id(5), foreign = id(6);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; if (process.env.VERBOSE) console.log(name); };
const asUser = async (who, fn, commit = false, role = 'authenticated') => {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role}`);
  try {
    await db.query("SELECT set_config('test.user_id',$1,true)", [who ?? '']);
    const result = await fn(); await db.exec(commit ? 'COMMIT' : 'ROLLBACK'); return result;
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
};
const rpc = async (name, args = [], who = user, commit = false) => asUser(who, async () =>
  (await db.query(`SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, args)).rows[0].value, commit);
const session = async (sessionId, options = {}) => {
  const { owner = user, game = 'ac', circuit = track, vehicle = car, kind = 'practice', at = '2026-11-18T14:00:00Z', weather = null, laps = 0 } = options;
  await db.query('INSERT INTO sim_sessions(id,user_id,game,track_id,car_id,kind,started_at,lap_count,weather) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [sessionId, owner, game, circuit, vehicle, kind, at, laps, weather]);
};
const lap = async (sessionId, number, time, options = {}) => {
  const { owner = user, valid = true, plausible = true, pit = false } = options;
  const result = await db.query('INSERT INTO sim_laps(user_id,session_id,lap_number,time_ms,valid,plausible,in_lap,out_lap,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8) RETURNING id',
    [owner, sessionId, number, time, valid, plausible, pit, `2026-11-18T12:${String(number % 60).padStart(2, '0')}:00Z`]);
  await db.query('UPDATE sim_sessions SET lap_count=lap_count+1 WHERE id=$1', [sessionId]);
  return result.rows[0].id;
};
const goals = (sessionId = source, who = user) => rpc('sim_coach_goals', [sessionId], who);
const create = (metric, target, title = 'Train deliberately', sessionId = source, who = user) =>
  rpc('sim_coach_goal_create', [sessionId, title, metric, target, 'One controlled exercise'], who, true);
try {
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO authenticated,anon,service_role;
    CREATE FUNCTION public.current_app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;
    CREATE TABLE app_accounts(id uuid PRIMARY KEY);
    CREATE TABLE sim_sessions(id uuid PRIMARY KEY,user_id uuid NOT NULL,game text NOT NULL,track_id uuid NOT NULL,car_id uuid NOT NULL,
      kind text NOT NULL,started_at timestamptz NOT NULL,weather text,air_temp_c numeric,track_temp_c numeric,lap_count integer DEFAULT 0);
    CREATE TABLE sim_laps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,
      session_id uuid REFERENCES sim_sessions(id) ON DELETE CASCADE,lap_number integer,time_ms integer,valid boolean,plausible boolean,
      in_lap boolean,out_lap boolean,started_at timestamptz);
  `);
  await db.query('INSERT INTO app_accounts VALUES($1),($2)', [user, other]);
  const sql = readFileSync(new URL('../supabase/migrations/20261118180000_virtual_training_goals.sql', import.meta.url), 'utf8');
  await check('migration is repeatable', async () => { await db.exec(sql); await db.exec(sql); });
  await session(source, { at: '2026-11-18T12:00:00Z' });
  await session(foreign, { owner: other });
  for (const [i, time] of [90000, 90600, 90300].entries()) await lap(source, i + 1, time);
  await lap(source, 4, 60000, { valid: false });
  await lap(source, 5, 50000, { plausible: null });
  await lap(source, 6, 40000, { pit: true });
  await lap(foreign, 1, 1000, { owner: other });
  await check('goals are empty until the user creates one', async () => assert.deepEqual(await goals(), { goals: [], limit: 20, truncated: false }));
  const bestId = await create('best_lap_ms', 88500), spreadId = await create('consistency_ms', 250), validId = await create('valid_lap_pct', 90);
  await check('baseline excludes invalid, unverified and pit laps and uses sample SD', async () => {
    const list = (await goals()).goals;
    const best = list.find((g) => g.id === bestId), spread = list.find((g) => g.id === spreadId), valid = list.find((g) => g.id === validId);
    assert.equal(best.baseline.value, 90000); assert.equal(spread.baseline.value, 300); assert.equal(valid.baseline.value, 60);
    assert.equal(best.baseline.lapsUsed, 3); assert.equal(best.baseline.totalLaps, 6);
    assert.equal(best.latest, null); assert.equal(best.reached, null); assert.equal(best.delta, null);
    assert.equal(best.baseline.weather, null); assert.equal(best.status, 'active');
  });
  await check('foreign sessions cannot be listed or used to create goals', async () => {
    await assert.rejects(goals(foreign), /session_not_found/);
    await assert.rejects(create('best_lap_ms', 5000, 'Foreign', foreign), /session_not_found/);
    await assert.rejects(goals(source, other), /session_not_found/);
  });
  await check('ordinary database callers cannot read or mutate the underlying table or private helpers', async () => {
    for (const who of [user, other]) {
      for (const query of ['SELECT * FROM sim_coach_goals', "UPDATE sim_coach_goals SET created_at='2000-01-01'", 'DELETE FROM sim_coach_goals',
        `SELECT sim_coach_context('${user}','${source}')`, `SELECT sim_coach_measurement('${user}','${source}','best_lap_ms')`]) {
        await assert.rejects(asUser(who, () => db.query(query)), /permission denied/);
      }
    }
  });
  await check('anonymous and empty authenticated identities fail closed', async () => {
    await assert.rejects(asUser(user, () => db.query('SELECT sim_coach_goals($1)', [source]), false, 'anon'), /permission denied/);
    await assert.rejects(goals(source, null), /unauthorized/);
  });
  await check('another user cannot change or delete a known goal id', async () => {
    assert.equal(await rpc('sim_coach_goal_status', [bestId, 'completed'], other, true), false);
    assert.equal(await rpc('sim_coach_goal_delete', [bestId], other, true), false);
    assert.equal((await goals()).goals.find((g) => g.id === bestId).status, 'active');
  });
  await check('validates all target bounds, metrics, title and notes', async () => {
    for (const [metric, target, title] of [['best_lap_ms', 0, 'Goal'], ['best_lap_ms', 1000.5, 'Goal'], ['consistency_ms', -1, 'Goal'],
      ['consistency_ms', 3600001, 'Goal'], ['valid_lap_pct', 101, 'Goal'], ['unknown', 1, 'Goal'], ['best_lap_ms', 90000, '  ']]) {
      await assert.rejects(create(metric, target, title), /invalid_goal/);
    }
    await assert.rejects(rpc('sim_coach_goal_create', [source, 'Goal', 'best_lap_ms', 80000, 'x'.repeat(1001)], user, true), /invalid_goal/);
    await assert.rejects(rpc('sim_coach_goal_status', [bestId, 'invented'], user, true), /invalid_goal/);
  });
  const short = id(7); await session(short); await lap(short, 1, 80000); await lap(short, 2, 80500);
  await check('a consistency goal needs three eligible baseline laps', async () => await assert.rejects(create('consistency_ms', 200, 'Not enough laps', short), /insufficient_laps/));
  await db.query("UPDATE sim_coach_goals SET created_at='2026-11-18T12:15:00Z'");
  const latest = id(8); await session(latest, { at: '2026-11-18T13:00:00Z', weather: 'dry' });
  const latestBest = await lap(latest, 1, 88000); await lap(latest, 2, 88400); await lap(latest, 3, 88800);
  for (const [n, options] of [[10, { owner: other }], [11, { game: 'lmu' }], [12, { circuit: id(30) }],
    [13, { vehicle: id(31) }], [14, { kind: 'race' }], [15, { at: '2026-11-18T12:10:00Z' }]]) {
    await session(id(n), options); await lap(id(n), 1, 1000, { owner: options.owner ?? user });
  }
  // A later session without enough clean laps is not an eligible consistency measurement.
  await db.query("UPDATE sim_sessions SET started_at='2026-11-18T12:10:00Z' WHERE id=$1", [short]);
  await check('evaluates only subsequent same game, car, track and session kind', async () => {
    const list = (await goals()).goals, best = list.find((g) => g.id === bestId), spread = list.find((g) => g.id === spreadId);
    assert.equal(best.latest.sessionId, latest); assert.equal(best.latest.value, 88000);
    assert.equal(best.delta, -2000); assert.equal(best.reached, true); assert.equal(best.status, 'active');
    assert.equal(best.latest.weather, 'dry'); assert.equal(spread.latest.value, 400); assert.equal(spread.reached, false);
    assert.equal(list.find((g) => g.id === validId).latest.value, 100);
  });
  await check('manual completion, archive and reopening preserve metrics and ownership', async () => {
    for (const status of ['completed', 'archived', 'active']) {
      assert.equal(await rpc('sim_coach_goal_status', [bestId, status], user, true), true);
      const goal = (await goals()).goals.find((g) => g.id === bestId);
      assert.equal(goal.status, status); assert.equal(goal.latest.value, 88000);
    }
  });
  await check('deleted source data is recomputed rather than keeping stale improvements', async () => {
    await db.query('DELETE FROM sim_laps WHERE id=$1', [latestBest]);
    const goal = (await goals()).goals.find((g) => g.id === bestId);
    assert.equal(goal.latest.value, 88400); assert.equal(goal.delta, -1600);
    assert.equal((await goals()).goals.find((g) => g.id === spreadId).latest, null);
  });
  const bounded = id(40); await session(bounded, { circuit: id(41) });
  for (let i = 1; i <= 201; i++) await lap(bounded, i, i === 201 ? 1000 : 80000 + i);
  // started_at drives source order, not insertion/lap-number alone: make it deterministic.
  await db.query("UPDATE sim_laps SET started_at='2026-11-18T12:00:00Z' WHERE session_id=$1", [bounded]);
  const boundedId = await create('best_lap_ms', 79000, 'Bounded evidence', bounded);
  await check('partial coverage excludes samples outside the first 200 metadata rows', async () => {
    const goal = (await goals(bounded)).goals.find((g) => g.id === boundedId);
    assert.equal(goal.baseline.value, 80001); assert.equal(goal.baseline.partial, true);
    assert.equal(goal.baseline.totalLaps, 201); assert.equal(goal.baseline.lapsUsed, 200);
  });
  await check('a future-dated baseline cannot count itself as subsequent progress', async () => {
    const future = id(50); await session(future, { circuit: id(51), at: '2100-01-01T12:00:00Z' }); await lap(future, 1, 80000);
    const goalId = await create('best_lap_ms', 80000, 'Future recorder clock', future);
    const goal = (await goals(future)).goals.find((g) => g.id === goalId);
    assert.equal(goal.latest, null); assert.equal(goal.reached, null);
  });
  await check('the search for follow-up evidence stays within twenty most recent matching sessions', async () => {
    const baseline = id(60), circuit = id(61); await session(baseline, { circuit, at: '2026-11-18T10:00:00Z' }); await lap(baseline, 1, 80000);
    const goalId = await create('best_lap_ms', 79000, 'Bounded follow-ups', baseline);
    await db.query("UPDATE sim_coach_goals SET created_at='2026-11-18T11:00:00Z' WHERE id=$1", [goalId]);
    for (let i = 0; i < 21; i++) {
      await session(id(100 + i), { circuit, at: `2026-11-18T13:${String(i).padStart(2, '0')}:00Z` });
      await lap(id(100 + i), 1, 78000, { valid: i === 0 });
    }
    const goal = (await goals(baseline)).goals.find((g) => g.id === goalId);
    assert.equal(goal.latest, null);
  });
  await check('context goal limits include archived goals and reject the 21st', async () => {
    for (let i = 0; i < 17; i++) await create('best_lap_ms', 85000, 'Practice ' + i);
    assert.equal((await goals()).goals.length, 20);
    await assert.rejects(create('best_lap_ms', 85000), /goal_limit/);
    await rpc('sim_coach_goal_delete', [bestId], user, true);
    const replacement = await create('best_lap_ms', 85000); assert.equal(typeof replacement, 'string');
  });
  await check('deleting a source session erases linked goals while other contexts survive', async () => {
    await db.query('DELETE FROM sim_sessions WHERE id=$1', [source]);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM sim_coach_goals WHERE source_session_id=$1', [source])).rows[0].n, 0);
    assert.equal((await goals(bounded)).goals.length, 1);
  });
  await check('account deletion erases its remaining training goals', async () => {
    await db.query('DELETE FROM app_accounts WHERE id=$1', [user]);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM sim_coach_goals')).rows[0].n, 0);
  });
  console.log(`Virtual training SQL: ${passed} contracts passed (ownership, bounds, metrics, subsequent-session evolution and erasure).`);
} finally { await db.close(); }
