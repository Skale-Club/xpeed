import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const keyName = 'AI_CREDENTIAL_ENCRYPTION_KEY';

// Provision once in Coolify. Never rotate a key that may encrypt saved credentials.
// API response bodies and credentials must never reach CI logs or error messages.
export async function ensureCredentialKey({ base, app, token, fetcher = fetch, generate = () => randomBytes(32).toString('base64') }) {
  if (!token || !app || !base?.startsWith('https://')) throw new Error('Coolify credential provisioning is not configured.');
  const url = `${base.replace(/\/$/, '')}/api/v1/applications/${encodeURIComponent(app)}/envs`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function request(method, body) {
    let response;
    try {
      response = await fetcher(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error('Coolify credential provisioning request failed; no secret details logged.');
    }
    if (!response.ok) throw new Error(`Coolify credential provisioning refused (${response.status}); check API permissions.`);
    return response;
  }
  async function list() {
    try {
      const body = await (await request('GET')).json();
      if (!Array.isArray(body)) throw new Error();
      return body;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Coolify credential provisioning')) throw error;
      throw new Error('Coolify credential provisioning received an invalid environment inventory.');
    }
  }
  const matches = (items) => items.filter((item) => item.key === keyName && !item.is_preview);
  const existing = matches(await list());
  if (existing.length > 1) throw new Error('Duplicate AI credential encryption environments; refusing to rotate or overwrite.');
  if (existing.length) {
    if (existing[0].is_runtime === false) throw new Error('AI credential encryption environment exists but is not enabled at runtime.');
    return 'preserved';
  }
  const value = generate();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32) throw new Error('Invalid generated encryption key.');
  await request('POST', JSON.stringify({ key: keyName, value, is_preview: false, is_buildtime: false, is_runtime: true, is_literal: true, is_multiline: false, is_shown_once: true }));
  const verified = matches(await list());
  if (verified.length !== 1 || verified[0].is_runtime === false) throw new Error('Could not confirm the AI credential encryption environment; refusing deployment.');
  return 'created';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureCredentialKey({ base: process.env.COOLIFY_BASE, app: process.env.APP_UUID, token: process.env.COOLIFY_TOKEN });
    console.log(`AI credential encryption environment ${result}; secret value withheld.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'AI credential encryption provisioning failed.');
    process.exitCode = 1;
  }
}
