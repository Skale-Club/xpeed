import { describe, it, expect, vi, beforeEach } from 'vitest';
import i18n from '@/lib/i18n';
import { CODE_GONE_NOTE, describeProblem, dtcSeverity, isOpenProblem, URGENCY } from './problems';

// The reconciler runs against the in-memory database of the screen-test copy.
vi.mock('@/integrations/supabase/client', () => import('@/harness/fake-supabase'));

type Row = Record<string, unknown>;
const table = (name: string) => (window as unknown as { __harnessDb: Record<string, Row[]> }).__harnessDb[name] ?? [];
const issueFor = (car: string, key: string) => table('vehicle_issues').find((i) => i.car_profile_id === car && i.canonical_key === key);

describe('describeProblem', () => {
  beforeEach(async () => { await i18n.changeLanguage('pt-BR'); });

  it('explains known problems in plain language', () => {
    const text = describeProblem({ canonical_key: 'coolant_temp', title: 'Coolant ran high' }, i18n.t);
    expect(text.title).toBe('Motor esquentando');
    expect(text.action).toMatch(/líquido de arrefecimento/);
    expect(text.code).toBe('coolant_temp');
    // Both fuel trims share one explanation
    expect(describeProblem({ canonical_key: 'ltft_b1', title: '' }, i18n.t).title).toBe('Mistura de combustível desregulada');
  });

  it('turns fault codes into an area and an action, keeping the code for the mechanic', () => {
    const text = describeProblem({ canonical_key: 'dtc:P0420', title: 'P0420' }, i18n.t);
    expect(text.title).toBe('Código de falha P0420 (motor ou câmbio)');
    expect(text.meaning).toContain('motor ou câmbio');
    expect(text.code).toBe('P0420');
    expect(text.technical).toBeTruthy();
    // Unknown chassis code: generic area, no made-up name
    const unknown = describeProblem({ canonical_key: 'dtc:C1234', title: 'C1234' }, i18n.t);
    expect(unknown.meaning).toContain('freios, suspensão ou direção');
    expect(unknown.technical).toBeNull();
  });

  it('falls back to the rule message for problems it does not know', () => {
    const text = describeProblem({ canonical_key: 'weird_sensor', title: 'Weird sensor high' }, i18n.t);
    expect(text.title).toBe('Weird sensor high');
    expect(text.meaning).toMatch(/fora do normal/);
  });

  it('maps severities to plain urgency and open states', () => {
    expect(URGENCY.critical).toBe('urgent');
    expect(URGENCY.easy_fix).toBe('later');
    expect(isOpenProblem({ status: 'recurred' })).toBe(true);
    expect(isOpenProblem({ status: 'ignored' })).toBe(false);
    expect(dtcSeverity('P0420')).toMatch(/critical|serious|warning/);
  });
});

describe('reconcileIssues', () => {
  it('records rule flags as problems and skips normal ones', async () => {
    const { reconcileIssues } = await import('./issue-reconciler');
    await reconcileIssues('s1', 'car-flags', 'u1', [
      { canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', severity: 'critical', message: 'Coolant critical', evidence: {} },
      { canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', severity: 'normal', message: 'ok', evidence: {} },
    ] as never, '2026-10-28T12:00:00Z');
    expect(issueFor('car-flags', 'coolant_temp')).toMatchObject({ severity: 'critical', status: 'active' });
    expect(issueFor('car-flags', 'engine_rpm')).toBeUndefined();
  });
});

describe('syncFaultCodes', () => {
  beforeEach(async () => { await i18n.changeLanguage('pt-BR'); });

  it('keeps fault-code problems in line with what the car reports', async () => {
    const { syncFaultCodes } = await import('./issue-reconciler');
    const car = 'car-codes';
    const at = (h: number) => `2026-10-28T${String(h).padStart(2, '0')}:00:00.000Z`;

    // Trip 1: one confirmed code, one seen only once.
    await syncFaultCodes(car, 'u1', { stored: ['P0420'], pending: ['P0171'], checked: true }, 's1', at(8));
    expect(issueFor(car, 'dtc:P0420')).toMatchObject({ status: 'active', severity: dtcSeverity('P0420'), title: 'P0420' });
    const pending = issueFor(car, 'dtc:P0171')!;
    expect(pending).toMatchObject({ status: 'active', severity: 'warning' });
    expect(describeProblem(pending as never, i18n.t).title).toMatch(/^Possível falha P0171/);

    // Trip 2: the car confirms P0171, P0420 is gone (fixed / cleared at the shop).
    const r2 = await syncFaultCodes(car, 'u1', { stored: ['P0171'], pending: [], checked: true }, 's2', at(10));
    expect(r2.resolved).toBe(1);
    expect(issueFor(car, 'dtc:P0420')).toMatchObject({ status: 'resolved', resolved_note: CODE_GONE_NOTE });
    expect(issueFor(car, 'dtc:P0171')).toMatchObject({ title: 'P0171', severity: dtcSeverity('P0171') });

    // A trip recorded earlier but saved late doesn't reopen what was already fixed.
    await syncFaultCodes(car, 'u1', { stored: ['P0420'], pending: [], checked: true }, 's1b', at(9));
    expect(issueFor(car, 'dtc:P0420')).toMatchObject({ status: 'resolved' });

    // When the read failed nothing is closed for being missing.
    await syncFaultCodes(car, 'u1', { stored: [], pending: [], checked: false }, 's3', at(11));
    expect(issueFor(car, 'dtc:P0171')).toMatchObject({ status: 'active' });

    // P0420 coming back later counts as "came back after being fixed".
    await syncFaultCodes(car, 'u1', { stored: ['P0420', 'P0171'], pending: [], checked: true }, 's4', at(12));
    expect(issueFor(car, 'dtc:P0420')).toMatchObject({ status: 'recurred', recurrence_count: 1 });
  });
});

describe('syncAiWarnings', () => {
  beforeEach(async () => { await i18n.changeLanguage('pt-BR'); });

  it('puts what the AI saw on the problem list, in its own words', async () => {
    const { syncAiWarnings } = await import('./issue-reconciler');
    const car = 'car-ai';
    const warning = {
      key: 'engine_slow_warmup',
      title: 'Motor demorando a esquentar',
      meaning: 'O motor levou mais tempo que o normal para esquentar.',
      action: 'Peça para verificarem a válvula termostática.',
      urgency: 'watch' as const,
    };
    await syncAiWarnings(car, 'u1', [warning, { ...warning, key: 'Bad Key!' }], 's1', '2026-10-27T08:00:00.000Z');

    const issue = issueFor(car, 'ai:engine_slow_warmup')!;
    expect(issue).toMatchObject({ status: 'active', severity: 'warning', title: 'Motor demorando a esquentar', first_session_id: 's1' });
    const text = describeProblem(issue as never, i18n.t);
    expect(text).toMatchObject({ title: warning.title, meaning: warning.meaning, action: warning.action });
    // Malformed keys never reach the list
    expect(table('vehicle_issues').filter((i) => i.car_profile_id === car)).toHaveLength(1);

    // Seen again, worse: same problem, later date, higher urgency, newer wording.
    await syncAiWarnings(car, 'u1', [{ ...warning, urgency: 'soon', action: 'Agende uma revisão.' }], 's2', '2026-10-28T08:00:00.000Z');
    expect(issueFor(car, 'ai:engine_slow_warmup')).toMatchObject({
      severity: 'serious', last_session_id: 's2', last_seen_at: '2026-10-28T08:00:00.000Z',
      details: { source: 'ai', meaning: warning.meaning, action: 'Agende uma revisão.' },
    });
  });

  it('never brings back a warning the owner ignored or marked as fixed', async () => {
    const { syncAiWarnings } = await import('./issue-reconciler');
    const { ignoreIssue, resolveIssue } = await import('./db-issues');
    const car = 'car-ai-dismissed';
    const base = { title: 'Algo', meaning: 'Algo nas leituras.', action: 'Fique de olho.', urgency: 'watch' as const };
    await syncAiWarnings(car, 'u1', [{ ...base, key: 'first_one' }, { ...base, key: 'second_one' }], 's1', '2026-10-27T08:00:00.000Z');
    await ignoreIssue(issueFor(car, 'ai:first_one')!.id as string);
    await resolveIssue(issueFor(car, 'ai:second_one')!.id as string);

    await syncAiWarnings(car, 'u1', [{ ...base, key: 'first_one', urgency: 'urgent' }, { ...base, key: 'second_one' }], 's2', '2026-10-28T08:00:00.000Z');
    expect(issueFor(car, 'ai:first_one')).toMatchObject({ status: 'ignored', severity: 'warning', last_session_id: 's1' });
    expect(issueFor(car, 'ai:second_one')).toMatchObject({ status: 'resolved', last_session_id: 's1' });
  });
});
