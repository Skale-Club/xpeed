import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureCredentialKey } from './ensure-ai-credential-key.mjs';

const key = 'AI_CREDENTIAL_ENCRYPTION_KEY';
const options = { base: 'https://coolify.invalid', app: 'test-app', token: 'fake-token' };
test('creates a hidden runtime-only key once and verifies its metadata', async () => {
  const calls = [];
  const result = await ensureCredentialKey({ ...options, fetcher: async (url, init) => {
    calls.push({ url, ...init });
    return Response.json(init.method === 'POST' ? { uuid: 'created' } : calls.length === 1 ? [] : [{ key, is_runtime: true, is_shown_once: true }]);
  } });
  assert.equal(result, 'created');
  const payload = JSON.parse(calls[1].body);
  assert.equal(Buffer.from(payload.value, 'base64').length, 32);
  assert.equal(payload.is_buildtime, false);
  assert.equal(payload.is_runtime, true);
  assert.equal(payload.is_shown_once, true);
  assert.equal(calls[1].redirect, 'error');
});
test('preserves an existing hidden key without generating, reading or changing its value', async () => {
  let count = 0;
  assert.equal(await ensureCredentialKey({ ...options, generate: () => { throw new Error('must not generate'); }, fetcher: async () => {
    count++;
    return Response.json([{ key, is_runtime: true }]);
  } }), 'preserved');
  assert.equal(count, 1);
});
test('preview environments do not replace the production key', async () => {
  let count = 0;
  assert.equal(await ensureCredentialKey({ ...options, fetcher: async (_, init) => {
    count++;
    return Response.json(init.method === 'POST' ? {} : count === 1 ? [{ key, is_preview: true }] : [{ key, is_runtime: true }]);
  } }), 'created');
});
test('refuses duplicate or runtime-disabled keys without a write', async () => {
  for (const items of [[{ key }, { key }], [{ key, is_runtime: false }]]) {
    await assert.rejects(ensureCredentialKey({ ...options, fetcher: async (_, init) => {
      assert.equal(init.method, 'GET');
      return Response.json(items);
    } }));
  }
});
test('refuses unreadable inventories and never includes response secrets in errors', async () => {
  for (const response of [Response.json({ secret: 'must-not-appear' }), new Response('must-not-appear', { status: 403 })]) {
    await assert.rejects(ensureCredentialKey({ ...options, fetcher: async () => response }), (error) => !error.message.includes('must-not-appear'));
  }
});
test('refuses unsafe configuration before sending a request', async () => {
  await assert.rejects(ensureCredentialKey({ ...options, base: 'http://coolify.invalid', fetcher: () => { assert.fail('must not fetch'); } }));
});
test('does not declare success when creation cannot be confirmed', async () => {
  await assert.rejects(ensureCredentialKey({ ...options, fetcher: async () => Response.json([]) }), /Could not confirm/);
});
