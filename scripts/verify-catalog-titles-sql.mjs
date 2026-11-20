// The catalog titles migration (supabase/migrations/20261120120000_sim_catalog_titles.sql) against a real PostgreSQL (PGlite),
// without network or the app's database: a title renames a row once, never a name already readable, and a renamed track still finds
// the layouts filed under the game's folder name.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? 'node_modules/.xpeed-audit-tools', 'package.json')));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const migration = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
const id = (n) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = id(1), laguna = id(2), brands = id(3), macan = id(4), named = id(5);
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; if (process.env.VERBOSE) console.log(name); };
const title = (game, trackName, trackTitle, carName, carTitle) =>
  db.query('SELECT public.sim_title_catalog($1,$2,$3,$4,$5)', [game, trackName, trackTitle, carName, carTitle]);
const trackName = async (trackId) => (await db.query('SELECT name FROM public.sim_track_catalog WHERE id = $1', [trackId])).rows[0].name;
const carName = async (carId) => (await db.query('SELECT name FROM public.sim_car_catalog WHERE id = $1', [carId])).rows[0].name;
const layoutOf = async (game, name) => (await db.query('SELECT public.sim_layout_id($1,$2,$3) AS id', [user, game, name])).rows[0].id;

try {
  // sim_norm exactly as the platform migration defines it; the tables with the columns these functions read.
  const norm = migration('20261113150000_sim_platform_model.sql').match(/CREATE FUNCTION public\.sim_norm[\s\S]*?\$\$;/)[0];
  await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    ${norm}
    CREATE TABLE public.sim_track_catalog(id uuid PRIMARY KEY, game text NOT NULL, slug text NOT NULL, name text NOT NULL);
    CREATE TABLE public.sim_track_alias(game text, alias_norm text, track_id uuid REFERENCES public.sim_track_catalog(id), PRIMARY KEY (game, alias_norm));
    CREATE TABLE public.sim_car_catalog(id uuid PRIMARY KEY, game text NOT NULL, slug text NOT NULL, name text NOT NULL);
    CREATE TABLE public.sim_car_alias(game text, alias_norm text, car_id uuid REFERENCES public.sim_car_catalog(id), PRIMARY KEY (game, alias_norm));
    CREATE TABLE public.sim_tracks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, game text, track_name text, variant text, title text,
      updated_at timestamptz DEFAULT now());`);
  await db.query(`INSERT INTO public.sim_track_catalog VALUES ($1,'ac','ks-laguna-seca','ks_laguna_seca'), ($2,'ac','ks-brands-hatch','ks_brands_hatch'),
    ($3,'ac','monza','Monza Circuit')`, [laguna, brands, named]);
  await db.query(`INSERT INTO public.sim_track_alias VALUES ('ac','ks laguna seca',$1), ('ac','ks brands hatch',$2), ('ac','monza',$3)`, [laguna, brands, named]);
  await db.query(`INSERT INTO public.sim_car_catalog VALUES ($1,'ac','ks-porsche-macan','ks_porsche_macan')`, [macan]);
  await db.query(`INSERT INTO public.sim_car_alias VALUES ('ac','ks porsche macan',$1)`, [macan]);
  await db.query(`INSERT INTO public.sim_tracks(user_id, game, track_name, variant, title) VALUES ($1,'ac','ks_brands_hatch','indy','Brands Hatch - Indy')`, [user]);

  const sql = migration('20261120120000_sim_catalog_titles.sql');
  await check('the migration runs twice', async () => { await db.exec(sql); await db.exec(sql); });

  await check('a row still named the game way gets the title; the alias keeps finding it', async () => {
    await title('ac', 'ks_laguna_seca', 'Laguna Seca', 'ks_porsche_macan', 'Porsche Macan Turbo');
    assert.equal(await trackName(laguna), 'Laguna Seca');
    assert.equal(await carName(macan), 'Porsche Macan Turbo');
    const alias = await db.query(`SELECT track_id FROM public.sim_track_alias WHERE game = 'ac' AND alias_norm = 'ks laguna seca'`);
    assert.equal(alias.rows[0].track_id, laguna);
  });

  await check('a title never replaces a name someone already reads, nor another title', async () => {
    await title('ac', 'monza', 'Monza', null, null);
    assert.equal(await trackName(named), 'Monza Circuit');
    await title('ac', 'ks_laguna_seca', 'Something Else', 'ks_porsche_macan', 'Other Car');
    assert.equal(await trackName(laguna), 'Laguna Seca');
    assert.equal(await carName(macan), 'Porsche Macan Turbo');
  });

  await check('an empty, blank or overlong title, an unknown name or another game change nothing', async () => {
    for (const bad of ['', '   ', 'x'.repeat(121), '---']) await title('ac', 'ks_brands_hatch', bad, null, null);
    await title('ac', 'not_uploaded', 'Ghost', 'nope', 'Ghost Car');
    await title('ams2', 'ks_brands_hatch', 'Brands Hatch', null, null);
    assert.equal(await trackName(brands), 'ks_brands_hatch');
  });

  await check('a track renamed to its title still finds the layout filed under its folder name', async () => {
    const before = await layoutOf('ac', 'ks_brands_hatch');
    assert.ok(before);
    await title('ac', 'ks_brands_hatch', 'Brands Hatch', null, null);
    assert.equal(await trackName(brands), 'Brands Hatch');
    assert.equal(await layoutOf('ac', 'Brands Hatch'), before);
    assert.equal(await layoutOf('ac', 'Laguna Seca'), null, 'no layout of its own: none borrowed');
  });

  await check('the backfill names the rows recorded under folder names, and only those', async () => {
    const raul = id(20), hb20 = id(21), mx5 = id(22), mine = id(23);
    await db.query(`INSERT INTO public.sim_track_catalog VALUES ($1,'ac','aiquenovaescala','aiquenovaescala')`, [raul]);
    await db.query(`INSERT INTO public.sim_track_alias VALUES ('ac','aiquenovaescala',$1)`, [raul]);
    await db.query(`INSERT INTO public.sim_car_catalog VALUES ($1,'ac','fsr-copa-hb20','fsr_copa_hb20'), ($2,'ams2','ks-mazda-mx5-cup','ks_mazda_mx5_cup'),
      ($3,'ac','ks-mazda-mx5-cup','My MX-5')`, [hb20, mx5, mine]);
    await db.query(`INSERT INTO public.sim_car_alias VALUES ('ac','fsr copa hb20',$1), ('ams2','ks mazda mx5 cup',$2), ('ac','ks mazda mx5 cup',$3)`, [hb20, mx5, mine]);
    const backfill = migration('20261120120100_sim_ac_catalog_titles_backfill.sql');
    const first = await db.query(backfill);
    assert.deepEqual([Number(first.rows[0].tracks_renamed), Number(first.rows[0].cars_renamed)], [1, 1]);
    assert.equal(await trackName(raul), 'Circuito Raul Boesel');
    assert.equal(await carName(hb20), 'Hyundai Copa HB20');
    assert.equal(await carName(mx5), 'ks_mazda_mx5_cup', 'another game is left alone');
    assert.equal(await carName(mine), 'My MX-5', 'a name someone already reads is kept');
    assert.equal(await trackName(laguna), 'Laguna Seca');
    const again = await db.query(backfill);
    assert.equal(Number(again.rows[0].tracks_renamed) + Number(again.rows[0].cars_renamed), 0, 'running it again changes nothing');
  });

  await check('only the service role may name the catalog', async () => {
    const grants = await db.query(`SELECT grantee FROM information_schema.routine_privileges WHERE routine_name = 'sim_title_catalog' ORDER BY grantee`);
    assert.deepEqual(grants.rows.map((r) => r.grantee).filter((g) => g !== 'postgres'), ['service_role']);
  });

  console.log(`catalog titles SQL: ${passed} checks passed`);
} finally {
  await db.close();
}
