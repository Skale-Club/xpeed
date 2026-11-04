// Copies production data into the development database, anonymized.
// Production is only ever read (a READ ONLY transaction); everything is written to `dev`.
import { SKIPPED_TABLES, createAnonymizer } from './anonymize.mjs';

const BATCH = 500;
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function publicTables(client) {
  const { rows } = await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return rows.map((r) => r.table_name);
}
async function columnsOf(client, table, { writable = false } = {}) {
  const { rows } = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1 ${writable ? "AND is_generated = 'NEVER'" : ''}
    ORDER BY ordinal_position`, [table]);
  return rows.map((r) => r.column_name);
}

/** Refuses to write to anything that does not look like a development database. */
export function assertSafeTarget(devUrl, prodUrl, env = process.env) {
  if (!devUrl) throw new Error('DATABASE_URL (the development database) is not set');
  const host = (url) => { try { return new URL(url).host; } catch { return url; } };
  if (prodUrl && host(devUrl) === host(prodUrl)) throw new Error('DATABASE_URL and PROD_DATABASE_URL point at the same server; refusing to overwrite production');
  const dev = host(devUrl);
  const allowed = /(^|\.)supabase\.(co|com)(:\d+)?$/.test(dev) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(dev);
  if (!allowed && env.DEV_SYNC_ALLOW_TARGET !== dev) {
    throw new Error(`Refusing to overwrite ${dev}: it is not a Supabase or local database. Set DEV_SYNC_ALLOW_TARGET=${dev} if it really is the development database.`);
  }
}

/**
 * @param {import('pg').Client} prod  connected to production (only read)
 * @param {import('pg').Client} dev   connected to the development database, already migrated
 */
export async function pullAnonymized(prod, dev, { keepEmails = [], keepPhones = [], log = () => {} } = {}) {
  const anonymizer = createAnonymizer({ keepEmails, keepPhones });
  const summary = { tables: {}, skipped: [] };
  await prod.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const prodTables = new Set(await publicTables(prod));
    const devTables = await publicTables(dev);
    const copy = anonymizer.order(devTables.filter((t) => prodTables.has(t) && !SKIPPED_TABLES.has(t)));
    summary.skipped = devTables.filter((t) => SKIPPED_TABLES.has(t) || !prodTables.has(t));

    await dev.query('BEGIN');
    try {
      // Triggers and foreign keys would reject rows that are only valid as a whole.
      await dev.query("SET LOCAL session_replication_role = 'replica'");
      await dev.query(`TRUNCATE ${copy.map((t) => `public.${quote(t)}`).join(', ')} RESTART IDENTITY CASCADE`);
      for (const table of copy) {
        const inProd = new Set(await columnsOf(prod, table));
        const columns = (await columnsOf(dev, table, { writable: true })).filter((c) => inProd.has(c));
        const list = columns.map(quote).join(', ');
        const insert = `INSERT INTO public.${quote(table)} (${list}) OVERRIDING SYSTEM VALUE
          SELECT ${list} FROM jsonb_populate_recordset(NULL::public.${quote(table)}, $1::jsonb)`;
        await prod.query(`DECLARE sync_cursor NO SCROLL CURSOR FOR SELECT to_jsonb(t) AS r FROM public.${quote(table)} t`);
        let count = 0;
        for (;;) {
          const { rows } = await prod.query(`FETCH ${BATCH} FROM sync_cursor`);
          if (!rows.length) break;
          await dev.query(insert, [JSON.stringify(rows.map((r) => anonymizer.row(table, r.r)))]);
          count += rows.length;
        }
        await prod.query('CLOSE sync_cursor');
        summary.tables[table] = count;
        log(`${table}: ${count} rows`);
      }
      // Rows arrived with their original ids, so the counters must continue after them.
      const { rows: serials } = await dev.query(`SELECT c.table_name AS t, c.column_name AS c
        FROM information_schema.columns c WHERE c.table_schema = 'public'
        AND pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) IS NOT NULL`);
      for (const { t, c } of serials) {
        if (!copy.includes(t)) continue;
        await dev.query(`SELECT setval(pg_get_serial_sequence(format('public.%I', $1::text), $2::text),
          GREATEST((SELECT COALESCE(MAX(${quote(c)}), 0) FROM public.${quote(t)}), 1))`, [t, c]);
      }
      await dev.query('COMMIT');
    } catch (error) {
      await dev.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    await prod.query('ROLLBACK').catch(() => {});
  }
  summary.keptAccounts = anonymizer.keptAccounts.size;
  return summary;
}
