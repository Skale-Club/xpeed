// Stands in for https://esm.sh/@supabase/supabase-js@2 inside the edge functions. They only use
// createClient() for tables and database functions, in two ways: with the service key (the server's
// own work) or with the caller's Authorization header (row level security applies). Both are
// answered by the app's own database through the service client.
import { identityFromRequest } from '../../identity';
import { createServiceClient } from '../../service-client';
import { SERVICE_KEY } from './deno-global';

interface Options { global?: { headers?: Record<string, string> } }

export function createClient(_url: string, key: string, options?: Options) {
  const headers = options?.global?.headers ?? {};
  const authorization = headers.Authorization ?? headers.authorization ?? '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (bearer) {
    // The person the token proves, or nobody: an invalid token never gets more than the public role.
    const caller = identityFromRequest(new Request('http://internal', { headers: { authorization: `Bearer ${bearer}` } }));
    return createServiceClient({ caller });
  }
  return createServiceClient({ caller: key === SERVICE_KEY ? 'service' : null });
}
