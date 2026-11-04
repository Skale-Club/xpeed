import pg from 'pg';

// One pool per process. DATABASE_URL points at the Coolify database in
// production and at the Supabase project in development.
let pool: pg.Pool | undefined;

export function databaseConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.DATABASE_URL);
}

export function getPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  if (pool) return pool;
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: Number(env.DATABASE_POOL_SIZE ?? 10),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Managed databases (Supabase) need TLS; the Coolify one is on a private network.
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (error) => console.error(JSON.stringify({ event: 'database_pool_error', message: error.message })));
  return pool;
}

export async function closePool() {
  const current = pool; pool = undefined;
  await current?.end();
}

/** Claims of a token whose signature, issuer and audience were already verified. */
export type VerifiedClaims = Record<string, unknown> & { sub: string };

/**
 * Runs `work` the way PostgREST does: inside a transaction, as the `authenticated`
 * role, with the verified claims visible to auth.jwt(). Row level security in the
 * migrations then decides what the caller can see. Only pass claims that came out
 * of verifyIdentity(); never data from the request body.
 */
export async function asIdentity<T>(claims: VerifiedClaims, work: (client: pg.PoolClient) => Promise<T>, source: pg.Pool = getPool()): Promise<T> {
  const client = await source.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims), claims.sub]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


/** Public pages (shared reports) call the database with no signed-in person: the `anon` role, no claims. */
export async function asAnonymous<T>(work: (client: pg.PoolClient) => Promise<T>, source: pg.Pool = getPool()): Promise<T> {
  const client = await source.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE anon');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** For trusted server work that is not on behalf of a user (health checks, jobs). */
export async function asService<T>(work: (client: pg.PoolClient) => Promise<T>, source: pg.Pool = getPool()): Promise<T> {
  const client = await source.connect();
  try { return await work(client); } finally { client.release(); }
}
