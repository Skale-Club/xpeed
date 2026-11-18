// First-party Companion bridge. Device permission is distinct from pairing;
// persisted session chat, owner data and the existing billing resolver are shared.
import { z } from 'zod';
import { openBackend } from '../_backend';
import { authenticateDevice } from './_upload';
import { bearer, browserHeaders, reply } from './_shared';
import { createChatHandler } from '../../supabase/functions/_shared/chat-handler.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schema = z.object({ sessionId: z.string().uuid(), conversationId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(), message: z.string().min(1).max(2000).refine((text) => !!text.trim()),
  language: z.enum(['en', 'pt-BR', 'es-ES']).optional() }).strict();

export default async function coach(req: Request): Promise<Response> {
  const send = (body: unknown, status = 200) => reply(body, status, { ...browserHeaders(req), 'Cache-Control': 'private, no-store' });
  const problem = (error: string, status: number) => send({ error, retryable: status === 429 || status >= 500 }, status);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  if (!['GET', 'POST'].includes(req.method)) return problem('method_not_allowed', 405);
  const backend = openBackend(), token = bearer(req);
  if (!backend) return problem('unavailable', 503);
  if (!token) return problem('unauthorized', 401);
  let admitted: { userId: string; deviceId: string; messageId: string } | null = null;
  try {
    const device = await authenticateDevice(backend, token);
    if (!device) return problem('unauthorized', 401);
    const args = { p_user: device.userId, p_device: device.deviceId };
    const rpc = async <T>(name: string, values: Record<string, unknown> = {}): Promise<T> => {
      const result = await backend.service.rpc(name, { ...args, ...values });
      if (result.error) throw new Error('companion_coach_storage');
      return result.data as T;
    };
    if (!await rpc<boolean>('sim_companion_coach_allowed')) return problem('assistant_disabled', 403);
    if (req.method === 'POST' && process.env.NODE_ENV !== 'production') return problem('development_disabled', 503);
    const rate = await backend.service.rpc('sim_rate_hit', { p_key: `coach:${device.deviceId}:${req.method}`, p_max: req.method === 'POST' ? 6 : 60, p_window_seconds: 60 });
    const wait = Number(rate.data);
    if (rate.error || rate.data == null || !Number.isFinite(wait) || wait < 0) throw new Error('companion_coach_rate');
    if (wait > 0) return problem('too_many_requests', 429);
    if (req.method === 'GET') {
      const sessionId = new URL(req.url).searchParams.get('sessionId');
      if (!sessionId) return send({ sessions: await rpc<unknown[]>('sim_companion_coach_sessions') });
      if (!UUID.test(sessionId)) return problem('invalid_request', 400);
      const history = await rpc<unknown>('sim_companion_coach_history', { p_session: sessionId });
      return history ? send(history) : problem('session_not_found', 404);
    }
    const text = await req.text();
    if (text.length > 16_384) return problem('invalid_request', 400);
    let input: unknown;
    try { input = JSON.parse(text); } catch { return problem('invalid_request', 400); }
    const parsed = schema.safeParse(input);
    if (!parsed.success) return problem('invalid_request', 400);
    const body = parsed.data;
    const begun = await rpc<{ status: string; conversationId?: string; reply?: string }>('sim_companion_coach_begin', {
      p_session: body.sessionId, p_conversation: body.conversationId ?? null, p_message_id: body.idempotencyKey, p_message: body.message,
    });
    if (begun.status === 'disabled') return problem('assistant_disabled', 403);
    if (begun.status === 'not_found') return problem('session_not_found', 404);
    if (begun.status === 'invalid') return problem('invalid_request', 400);
    if (begun.status === 'failed') return problem('request_failed', 409);
    if (begun.status === 'pending') return problem('request_pending', 409);
    if (begun.status === 'busy') return problem('device_busy', 409);
    if (begun.status === 'replied' && begun.conversationId && typeof begun.reply === 'string') {
      return send({ conversationId: begun.conversationId, reply: begun.reply });
    }
    if (begun.status !== 'created' || !begun.conversationId) throw new Error('companion_coach_admission');
    admitted = { ...device, messageId: body.idempotencyKey };
    const answer = await createChatHandler(async () => device.userId)(new Request('https://internal.xpeed.invalid/functions/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'virtual', accountId: device.userId,
        sessionId: body.sessionId, conversationId: begun.conversationId, messageId: body.idempotencyKey, message: body.message, language: body.language }),
    }));
    if (!answer.ok) {
      await rpc<boolean>('sim_companion_coach_finish', { p_message_id: body.idempotencyKey, p_reply: null });
      admitted = null;
      return problem(answer.status === 429 ? 'limit_reached' : answer.status === 404 ? 'session_not_found' : 'unavailable', answer.status === 429 ? 429 : answer.status === 404 ? 404 : 503);
    }
    const result = await answer.json() as { reply?: unknown };
    if (typeof result.reply !== 'string' || !result.reply.trim()) throw new Error('companion_coach_empty');
    const response = result.reply.slice(0, 6000);
    if (!await rpc<boolean>('sim_companion_coach_finish', { p_message_id: body.idempotencyKey, p_reply: response })) throw new Error('companion_coach_finish');
    admitted = null;
    return send({ conversationId: begun.conversationId, reply: response });
  } catch {
    if (admitted) {
      try { await backend.service.rpc('sim_companion_coach_finish', { p_user: admitted.userId, p_device: admitted.deviceId, p_message_id: admitted.messageId, p_reply: null }); }
      catch { /* Persisted pending admission still prevents duplicate paid dispatch. */ }
    }
    // Device tokens, provider credentials, request text and database values stay out of logs.
    console.error(JSON.stringify({ event: 'companion_coach_failed' }));
    return problem('unavailable', 503);
  }
}
