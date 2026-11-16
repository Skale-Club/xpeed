#!/usr/bin/env node
// SimHub MCP: controls a local SimHub without the mouse. No dependencies (Node 18+).
// Talks to SimHub's built-in web server (undocumented /api/*, may change between versions)
// and reads/edits the JSON settings in PluginsData. Local only: never leaves this machine.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIMHUB_DIR = process.env.SIMHUB_DIR || 'C:\\Program Files (x86)\\SimHub';
const BASE = process.env.SIMHUB_URL || 'http://127.0.0.1:8888';
const DATA = resolve(SIMHUB_DIR, 'PluginsData');
const BACKUPS = join(HERE, '.backups');

// Only these prefixes may be called, so a bad call cannot reach anything else.
// Full route list (75) was extracted from SimHub.Plugins.Web.dll on SimHub 9.13.3.
const READ_API = ['api/getgamedata', 'api/GetGameDataSimple', 'api/GetGameDataUpdates', 'api/GetProperty/', 'api/EvaluateStringFormula',
  'api/Dashboards/GetDashboards', 'api/GetSessionLapsHistory', 'api/GetLeaderboarddata', 'api/GetPlayerLeaderboarddata', 'api/Getaheadbehinddata',
  'api/GetLedsData', 'api/ControlMapper/GetRoles', 'api/Devices/List', 'api/Devices/Details/',
  'api/Motion/ApiIndex', 'api/Motion/GetMotionDevice', 'api/Motion/CurrentDeviceState', 'api/Motion/GetLastPose', 'api/Motion/GetLicencesStatus', 'api/Motion/ProfileDetails'];
const ACTION_API = ['api/ControlMapper/', 'api/Motion/', 'api/Devices/EnableDevice/', 'api/Devices/DisableDevice/', 'api/TriggerAction/', 'api/TriggerInput/', 'api/ExternalInput/'];
const ALLOWED_API = [...READ_API, ...ACTION_API];
const isRead = (p) => READ_API.some((a) => p.toLowerCase().startsWith(a.toLowerCase()));

const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (m) => ({ isError: true, content: [{ type: 'text', text: m }] });

function simhubRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq SimHubWPF.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return out.includes('SimHubWPF.exe');
  } catch { return false; }
}

function safePath(rel) {
  const p = resolve(DATA, rel);
  if (p !== DATA && !p.startsWith(DATA + sep)) throw new Error('path outside PluginsData');
  if (!p.toLowerCase().endsWith('.json')) throw new Error('only .json files');
  if (p.toLowerCase().includes(`${sep}_backups${sep}`)) throw new Error('use the SimHub _Backups folder only by hand');
  return p;
}

function listJson(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '_Backups') listJson(p, out); }
    else if (n.toLowerCase().endsWith('.json')) out.push(relative(DATA, p));
  }
  return out;
}

async function api(method, path, form) {
  const clean = path.replace(/^\/+/, '');
  if (!ALLOWED_API.some((a) => clean.toLowerCase().startsWith(a.toLowerCase()))) throw new Error(`endpoint not allowed: ${clean}`);
  const init = { method, signal: AbortSignal.timeout(5000) };
  if (form) { init.body = new URLSearchParams(form); init.headers = { 'content-type': 'application/x-www-form-urlencoded' }; }
  const r = await fetch(`${BASE}/${clean}`, init);
  let body = await r.text();
  if (/^\s*<!doctype html/i.test(body)) { // SimHub error page: keep only the message
    const m = body.match(/class="titleerror">([^<]*)</i);
    body = `(SimHub error page) ${m ? m[1].replace(/&#x27;/g, "'") : 'no message'}`;
  }
  return { status: r.status, body: body.length > 4000 ? body.slice(0, 4000) + '…' : body };
}

const TOOLS = [
  { name: 'simhub_status', description: 'Is SimHub running, which web port answers, and a short game-data sample.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const running = simhubRunning();
      let web = null;
      try { const r = await api('GET', 'api/getgamedata'); web = { status: r.status, sample: r.body.slice(0, 400) }; } catch (e) { web = { error: String(e.message || e) }; }
      return text({ running, baseUrl: BASE, settingsDir: DATA, web });
    } },
  { name: 'simhub_api_get', description: 'Read-only GET on SimHub\'s built-in web API. E.g. api/GetGameDataSimple, api/GetProperty/DataCorePlugin.CurrentGame, api/EvaluateStringFormula?formula=..., api/Dashboards/GetDashboards, api/ControlMapper/GetRoles2 (needs Control Mapper plugin on), api/Motion/ProfileDetails (needs Motion plugin on AND ApiEnabled=true in Common/MotionPlugin.GeneralSettingsV2.json).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. api/getgamedata' } }, required: ['path'] },
    run: async ({ path }) => { if (!isRead(path.replace(/^\/+/, ''))) return fail('not a read endpoint; use simhub_api_action'); return text(await api('GET', path)); } },
  { name: 'simhub_api_action', description: 'State-changing call that SimHub exposes as GET (Motion and Devices). E.g. api/Motion/SetCurrentProfileGain/MotionGlobal/60, api/Motion/SetCurrentProfileGlobalSmoothing/10, api/Motion/ActivateProfile/{id}, api/Motion/EnableMotion, api/Devices/DisableDevice/{id}, api/TriggerAction/{name}. Read the current value first so it can be put back.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path }) => text(await api('GET', path)) },
  { name: 'simhub_api_post', description: 'Action on SimHub\'s web API (changes state). Examples: api/ControlMapper/StartRole {roleName, ownerId}; api/Motion/EnableMotion. Endpoints are undocumented and may vary by SimHub version.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, form: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['path'] },
    run: async ({ path, form }) => text(await api('POST', path, form)) },
  { name: 'simhub_list_settings', description: 'List the JSON settings files under SimHub\'s PluginsData folder.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => text(listJson(DATA)) },
  { name: 'simhub_read_setting', description: 'Read one JSON settings file (path relative to PluginsData).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path }) => { const s = readFileSync(safePath(path), 'utf8'); return text(s.length > 30000 ? s.slice(0, 30000) + '\n…(truncated)' : s); } },
  { name: 'simhub_write_setting', description: 'Replace one JSON settings file. Refuses while SimHub is running (it would overwrite the change). Validates JSON and saves a timestamped backup first.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, json: { type: 'string', description: 'full new file content, must be valid JSON' } }, required: ['path', 'json'] },
    run: async ({ path, json }) => {
      if (simhubRunning()) return fail('SimHub is running. Close it first, then write, then reopen it.');
      JSON.parse(json);
      const p = safePath(path);
      if (!existsSync(p)) return fail('file does not exist; this tool only edits existing settings');
      mkdirSync(BACKUPS, { recursive: true });
      const bak = join(BACKUPS, `${new Date().toISOString().replace(/[:.]/g, '-')}__${relative(DATA, p).split(sep).join('__')}`);
      copyFileSync(p, bak);
      writeFileSync(p, json, 'utf8');
      return text({ written: relative(DATA, p), backup: bak });
    } },
];

// --- minimal MCP over stdio (newline-delimited JSON-RPC) ---
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'simhub', version: '0.1.0' } } });
  if (method === 'notifications/initialized' || id === undefined) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  if (method === 'tools/call') {
    const t = TOOLS.find((x) => x.name === params?.name);
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
    try { return send({ jsonrpc: '2.0', id, result: await t.run(params.arguments || {}) }); }
    catch (e) { return send({ jsonrpc: '2.0', id, result: fail(String(e.message || e)) }); }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { let m; try { m = JSON.parse(l); } catch { continue; } queue = queue.then(() => handle(m)).catch(() => {}); } } });
// One request at a time, in order: an action and the read after it must not race.
let queue = Promise.resolve();
