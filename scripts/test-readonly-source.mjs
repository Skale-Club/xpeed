// Real PostgreSQL privilege checks in the isolated CI runtime. No network or .env.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '../node_modules/.xpeed-audit-tools/node_modules/@electric-sql/pglite/dist/index.js';
import { assertReadOnlySource } from '../db/readonly-source.mjs';

test('PostgreSQL rejects admin/write roles and accepts a dedicated read-only role', async () => {
  const db = new PGlite();
  try {
    await assert.rejects(assertReadOnlySource(db), /dedicated read-only/);
    await db.exec(`CREATE TABLE public.source_example(id int);
      INSERT INTO public.source_example VALUES (1);
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE ROLE sync_reader NOINHERIT;
      GRANT USAGE ON SCHEMA public TO sync_reader;
      GRANT SELECT ON public.source_example TO sync_reader;
      SET ROLE sync_reader;
      SET default_transaction_read_only = on;`);
    await assertReadOnlySource(db);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.source_example')).rows[0].n, 1);
    await assert.rejects(db.query('INSERT INTO public.source_example VALUES (2)'));
    await db.exec('SET default_transaction_read_only = off');
    await db.exec(`RESET ROLE;
      GRANT UPDATE ON public.source_example TO sync_reader;
      SET ROLE sync_reader; SET default_transaction_read_only = on;`);
    await assert.rejects(assertReadOnlySource(db), /dedicated read-only/);
    await db.exec('SET default_transaction_read_only = off');
    await db.exec(`RESET ROLE;
      REVOKE UPDATE ON public.source_example FROM sync_reader;
      GRANT UPDATE (id) ON public.source_example TO sync_reader;
      SET ROLE sync_reader; SET default_transaction_read_only = on;`);
    await assert.rejects(assertReadOnlySource(db), /dedicated read-only/);
  } finally { await db.close(); }
});
