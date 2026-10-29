// Reproducoes de diagnostico: executa o codigo atual com dados sinteticos.
// Nao usa credenciais reais, nao acessa rede e nao altera o aplicativo/banco.
// Uso: node docs/revisao-2026-10-29/reproducoes.mjs [--save]
// evidencias.json preserva o baseline; --save grava separadamente evidencias-atuais.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
function compile(path, replacements = {}) {
  let js = ts.transpileModule(read(path), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: path,
  }).outputText;
  for (const [from, to] of Object.entries(replacements)) js = js.replaceAll(from, to);
  return dataUrl(js);
}

const canonical = compile('src/lib/canonical-params.ts');
const codes = compile('src/lib/dtc-codes.ts');
const units = compile('src/lib/csv-units.ts');
const times = compile('src/lib/session-time.ts');
const { parseCSV } = await import(compile('src/lib/csv-parser.ts', {
  './canonical-params': canonical, './dtc-codes': codes, './csv-units': units,
}));
const { evaluateRules, computeParameterSummaries } = await import(compile('src/lib/insight-engine.ts', { './session-time': times }));
const rule = {
  canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', label: 'Coolant',
  normal_min: 80, normal_max: 105, warn_min: null, warn_max: 110,
  critical_min: null, critical_max: 118, min_duration_seconds: 30,
  notes: 'Attention: hot. Critical: stop.',
};
const results = [];
function record(id, observed, expectedAfterFix, reproduced) {
  results.push({ id, reproduced, observed, expectedAfterFix });
}

const seconds = parseCSV('Time (s),Engine coolant temperature (C)\n0,120\n5,120\n10,120\n15,120');
const recomputed = { ...seconds, rows: seconds.rows.map(({ 'Time (s)': _t, ...values }) => values) };
const before = evaluateRules(seconds, [rule]);
const after = evaluateRules(recomputed, [rule]);
const rawReprocessing = read('src/pages/SessionDetail.tsx').includes('reprocessStoredSession(session)') && read('src/lib/reprocess-session.ts').includes('parseCSV(await originalSessionCsv(session))');
record('A01', { flagsBefore: before.length, flagsAfterDiscardingTimes: after.length, currentPathReadsOriginal: rawReprocessing },
  'O caminho atual deve reavaliar o CSV original; a transacao SQL ainda exige homologacao.', !rawReprocessing && before.length === 1 && after.length === 0);

const imperial = parseCSV('Time (s),Coolant (F),Vehicle speed (mph)\n' +
  Array.from({ length: 40 }, (_, i) => `${i},194,60`).join('\n'));
const summaries = computeParameterSummaries(imperial);
record('A02', { summaries, flags: evaluateRules(imperial, [rule]).map((f) => f.severity) },
  '194 F deve virar 90 C sem alerta de superaquecimento; 60 mph deve virar ~96.56 km/h.',
  summaries.find((s) => s.canonical_key === 'coolant_temp')?.avg === 194 && evaluateRules(imperial, [rule]).length === 1);

const timestamps = parseCSV('Timestamp,Engine coolant temperature (C)\n2026-10-28T00:00:00Z,120\n2026-10-28T00:00:10Z,120\n2026-10-28T00:00:20Z,120');
record('A05', { timeColumn: timestamps.timeColumn, flags: evaluateRules(timestamps, [rule]).length },
  'A janela critica de 20 segundos deve ser avaliada pelo tempo real.', evaluateRules(timestamps, [rule]).length === 0);

const queries = [];
const chain = {
  select(columns) { queries.push({ operation: 'select', columns }); return this; },
  eq() { return this; }, order() { return this; }, limit() { return this; }, maybeSingle() { return this; },
  then(ok, fail) { return Promise.resolve({ data: null, error: { message: 'synthetic network failure' } }).then(ok, fail); },
};
const mockDbUrl = dataUrl('export const supabase = globalThis.__xpeedReviewDb;');
globalThis.__xpeedReviewDb = { from(table) { queries.push({ table }); return chain; } };
const db = await import(compile('src/lib/db.ts', { '@/integrations/supabase/client': mockDbUrl }));
async function capture(read) { try { return await read(); } catch (error) { return { threw: true, message: error.message }; } }
const swallowed = { flags: await capture(() => db.getSessionFlags('synthetic-trip')), sessions: await capture(() => db.getSessions('synthetic-car')), session: await capture(() => db.getSession('synthetic-trip')) };
record('A03', swallowed, 'Falhas devem ser lancadas e tratadas como erro recuperavel pela interface.',
  Array.isArray(swallowed.flags) && swallowed.flags.length === 0 && swallowed.session === null);
const listSelect = queries.filter((q) => q.operation === 'select').find((q) => q.columns?.includes('source_filename'))?.columns ?? '';
record('A06', { listIncludesActiveDtcs: listSelect.split(',').map((s) => s.trim()).includes('active_dtcs') },
  'O contrato de listagem deve trazer os codigos usados para mostrar os problemas.', !listSelect.includes('active_dtcs'));
delete globalThis.__xpeedReviewDb;

const previousFetch = globalThis.fetch;
const oldUrl = process.env.VITE_SUPABASE_URL;
try {
  process.env.VITE_SUPABASE_URL = 'https://example.supabase.co';
  globalThis.fetch = async () => new Response('{}', { status: 401, headers: {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource"',
  } });
  const { default: proxy } = await import(compile('api/mcp.ts'));
  const response = await proxy(new Request('https://example.test/api/mcp', { method: 'POST', body: '{}' }));
  record('A09', { status: response.status, authChallenge: response.headers.get('WWW-Authenticate') },
    'Preservar WWW-Authenticate e expor o cabecalho via CORS.', response.status === 401 && !response.headers.has('WWW-Authenticate'));
} finally {
  globalThis.fetch = previousFetch;
  if (oldUrl === undefined) delete process.env.VITE_SUPABASE_URL;
  else process.env.VITE_SUPABASE_URL = oldUrl;
}

const oldWindow = globalThis.window;
const oldSessionStorage = globalThis.sessionStorage;
try {
  let reloads = 0;
  const fakeWindow = new EventTarget();
  fakeWindow.location = { reload: () => { reloads++; } };
  fakeWindow.__xpeedRecording = true;
  globalThis.window = fakeWindow;
  const saved = new Map();
  globalThis.sessionStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) };
  const { installPreloadErrorReload } = await import(compile('src/lib/pwa-update.ts'));
  installPreloadErrorReload();
  fakeWindow.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  record('A11', { recording: true, reloads },
    'Durante gravacao, uma falha de chunk nao pode recarregar antes de persistir e encerrar com seguranca.', reloads === 1);
} finally {
  if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
  if (oldSessionStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = oldSessionStorage;
}

const oldSchema = read('supabase/migrations/20260528000003_vehicle_issues.sql');
const upgrade = read('supabase/migrations/20261028000000_vehicle_issues_rebuild.sql');
const schemaCheck = {
  additiveUpgradePrepared: /ADD COLUMN IF NOT EXISTS details jsonb/i.test(read('supabase/migrations/20261029110000_stabilize_processing.sql')),
  previousHasFirstSessionId: /first_session_id\s+UUID/i.test(oldSchema),
  previousHasDetails: /\bdetails\s+JSONB/i.test(oldSchema),
  previousHasUpdatedAt: /\bupdated_at\s+/i.test(oldSchema),
  upgradeAddsDetailsWithAlter: /ALTER TABLE[\s\S]*?ADD COLUMN[^;]*\bdetails\b/i.test(upgrade),
};
record('A04-static', schemaCheck, 'Uma migracao incremental deve completar o esquema anterior sem apagar linhas.',
  schemaCheck.previousHasFirstSessionId && !schemaCheck.previousHasDetails && !schemaCheck.upgradeAddsDetailsWithAlter && !schemaCheck.additiveUpgradePrepared);

assert.equal(results.length, 8);
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  scope: 'Dados sinteticos, funcoes atuais e analise estatica de uma migracao. Sem banco ou rede reais.',
  meaning: 'reproduced=true confirma o defeito nesta verificacao. false nao homologa banco, RLS, hardware ou fluxo completo. Ver testes permanentes e EXECUCAO.md.',
  results,
};
if (process.argv.includes('--save')) writeFileSync(resolve(here, 'evidencias-atuais.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
