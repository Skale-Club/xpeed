// The server's own stand-in for the Supabase client: tables, database functions and files, against
// this app's PostgreSQL and file store. The handlers in api/* were written against supabase-js;
// this keeps their code as it is (db.from(...).select().eq(), db.storage.from(bucket).download()).
import type pg from 'pg';
import { execute, type Caller, type DbRequest } from './db-query';
import { QueryBuilder, RpcBuilder, type Runner } from '../src/lib/query-builder';
import { FileError, checkPath, signLink, type FileStore } from './files';
import { createStore } from './storage-driver';
import { getPool } from './db';

export interface ServiceClientOptions {
  pool?: pg.Pool;
  store?: FileStore;
  /** Who the database sees: 'service' (owner, no RLS) or a verified person (RLS applies). */
  caller?: Caller | PromiseLike<Caller>;
  /** Signs links returned by createSignedUrl. */
  secret?: string;
  /** Public address of the app, for createSignedUrl. */
  origin?: string;
}

interface StorageFailure { message: string; statusCode: string }
const failure = (error: unknown): StorageFailure => error instanceof FileError
  ? { message: error.message, statusCode: String(error.status) }
  : { message: error instanceof Error ? error.message : 'Storage is unavailable', statusCode: '500' };

type Body = string | Blob | ArrayBuffer | Uint8Array;
async function bytesOf(body: Body): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await body.arrayBuffer());
}

class ServerBucket {
  constructor(private store: FileStore, private bucket: string, private secret: string, private origin: string) {}

  async upload(path: string, body: Body, options?: { contentType?: string; upsert?: boolean }) {
    try {
      await this.store.put(this.bucket, path, await bytesOf(body), { upsert: options?.upsert === true });
      return { data: { path }, error: null };
    } catch (error) { return { data: null, error: failure(error) }; }
  }
  /** The extra arguments of the Supabase signature (`{}`, `{ cache }`) do not apply: nothing here is cached. */
  async download(path: string, _transform?: unknown, _fetch?: unknown) {
    try {
      const bytes = await this.store.get(this.bucket, path);
      return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    } catch (error) { return { data: null, error: failure(error) }; }
  }
  /** Renames an object in this bucket, replacing the target (the staging name of an upload becomes its final name). */
  async move(from: string, to: string) {
    try {
      await this.store.move(this.bucket, from, to);
      return { data: { message: 'Successfully moved' }, error: null };
    } catch (error) { return { data: null, error: failure(error) }; }
  }
  async list(prefix = '', options?: { limit?: number; offset?: number; search?: string }) {
    try {
      const files = await this.store.list(this.bucket, prefix.replace(/\/+$/, ''), options);
      // Like Supabase: folders come back with no id and no metadata.
      return { data: files.map((f) => ({ name: f.name, id: f.folder ? null : f.name, updated_at: f.updatedAt, metadata: f.folder ? null : { size: f.size } })), error: null };
    } catch (error) { return { data: null, error: failure(error) }; }
  }
  async remove(paths: string[]) {
    try {
      await this.store.remove(this.bucket, paths);
      return { data: paths.map((name) => ({ name })), error: null };
    } catch (error) { return { data: null, error: failure(error) }; }
  }
  async createSignedUrl(path: string, expiresIn: number) {
    try {
      checkPath(path);
      if (!this.secret) throw new FileError(503, 'signing_unavailable', 'Signing is not configured');
      if (!(await this.store.get(this.bucket, path))) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
      const token = signLink(this.secret, { bucket: this.bucket, path, expires: Date.now() + Math.max(expiresIn, 1) * 1000 });
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      return { data: { signedUrl: `${this.origin}/api/storage/object/${this.bucket}/${encoded}?token=${token}` }, error: null };
    } catch (error) { return { data: null, error: failure(error) }; }
  }
}

export function createServiceClient(options: ServiceClientOptions = {}) {
  const pool = options.pool ?? getPool();
  // A promise lets the edge-function shim hand over a token that still has to be verified.
  const caller: Caller | PromiseLike<Caller> = options.caller === undefined ? 'service' : options.caller;
  const store = options.store ?? createStore();
  const secret = options.secret ?? process.env.STORAGE_SECRET ?? '';
  const origin = (options.origin ?? process.env.PUBLIC_APP_URL ?? 'https://xpeed.skale.club').replace(/\/$/, '');
  const run: Runner = async (payload) => execute(pool, await caller, payload as unknown as DbRequest);
  return {
    from: (table: string) => new QueryBuilder(table, run),
    rpc: (name: string, args?: unknown) => new RpcBuilder(name, args, run),
    storage: { from: (bucket: string) => new ServerBucket(store, bucket, secret, origin) },
  };
}
export type ServiceClient = ReturnType<typeof createServiceClient>;
