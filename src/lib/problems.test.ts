import { describe, it, expect, vi, beforeEach } from 'vitest';
import i18n from '@/lib/i18n';
import { describeProblem, dtcSeverity, isOpenProblem, URGENCY } from './problems';

// Capture what the reconciler writes to Supabase.
const db = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[], upserts: [] as Record<string, unknown>[] }));
vi.mock('@/integrations/supabase/client', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    Object.assign(q, {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: null }),
      single: async () => ({ data: { id: `issue-${db.inserts.length}` } }),
      insert: (row: Record<string, unknown>) => { db.inserts.push({ table, ...row }); return q; },
      update: () => q,
      upsert: async (row: Record<string, unknown>) => { db.upserts.push({ table, ...row }); return {}; },
    });
    return q;
  };
  return { supabase: { from: chain } };
});

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
  it('records fault codes as problems next to rule flags', async () => {
    const { reconcileIssues } = await import('./issue-reconciler');
    db.inserts.length = 0;
    await reconcileIssues('s1', 'car-1', 'u1', [
      { canonical_key: 'coolant_temp', parameter_key: 'coolant_temp', severity: 'critical', message: 'Coolant critical', evidence: {} },
      { canonical_key: 'engine_rpm', parameter_key: 'engine_rpm', severity: 'normal', message: 'ok', evidence: {} },
    ] as never, '2026-10-28T12:00:00Z', ['P0420']);

    expect(db.inserts.map((r) => [r.canonical_key, r.severity, r.status])).toEqual([
      ['coolant_temp', 'critical', 'active'],
      ['dtc:P0420', dtcSeverity('P0420'), 'active'],
    ]);
  });
});
