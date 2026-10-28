import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as typedClient } from '@/integrations/supabase/client';
import type { SessionFlag } from './insight-engine';
import type { CodeIssueDetails, IssueDetails, IssueSeverity } from './db-issues';
import type { AiWarning } from './ai-client';
import { AI_PREFIX, CODE_GONE_NOTE, DTC_PREFIX, PENDING_SUFFIX, URGENCY_SEVERITY, dtcSeverity } from './problems';

// Map session flag severities to issue severity levels.
// 'warning' and 'easy_fix' are reserved for future rule granularity.
function toIssueSeverity(flagSeverity: string): IssueSeverity {
  return flagSeverity === 'critical' ? 'critical' : 'serious';
}

// vehicle_issues and its occurrences aren't in the generated database types yet.
const supabase = typedClient as unknown as SupabaseClient;

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 4, serious: 3, warning: 2, easy_fix: 1 };

interface ProblemItem {
  canonical_key: string;
  title: string;
  severity: IssueSeverity;
  evidence: unknown;
  /** Plain-language text for AI warnings; kept up to date with the latest wording. */
  details?: IssueDetails;
  /**
   * Fault codes: the modules (ECU addresses) that reported it. Kept on the
   * problem so a later read only closes it when the module that reported it
   * answered and no longer lists it.
   */
  modules?: string[];
}

/** What a fault-code problem remembers in `details` (the column is shared with AI warnings). */
type CodeDetails = CodeIssueDetails;

const UNIQUE_VIOLATION = '23505';

interface Seen {
  carProfileId: string;
  userId: string;
  /** The trip it was seen in; null for a reading taken outside a trip (Scanner). */
  sessionId: string | null;
  occurredAt: string;
}

/** Create the problem, or update it (last seen, worse severity, came back after being fixed). */
async function upsertProblem(item: ProblemItem, seen: Seen): Promise<void> {
  const { carProfileId, userId, sessionId, occurredAt } = seen;
  try {
    // Two saves of the same car can create the same problem at once: when the
    // insert loses that race (unique key), look again and update the winner's row.
    let issueId: string | null = null;
    for (let attempt = 0; attempt < 2 && !issueId; attempt++) {
      const { data: existing } = await supabase
        .from('vehicle_issues')
        .select('id, status, recurrence_count, severity, title, last_seen_at, resolved_at, details')
        .eq('car_profile_id', carProfileId)
        .eq('canonical_key', item.canonical_key)
        .maybeSingle();

      if (!existing) {
        const { data: created, error } = await supabase
          .from('vehicle_issues')
          .insert({
            car_profile_id: carProfileId,
            user_id: userId,
            canonical_key: item.canonical_key,
            title: item.title,
            severity: item.severity,
            status: 'active',
            first_seen_at: occurredAt,
            last_seen_at: occurredAt,
            first_session_id: sessionId,
            last_session_id: sessionId,
            ...(item.details ? { details: item.details } : {}),
            ...(item.modules?.length ? { details: { source: 'dtc', modules: item.modules } as CodeDetails } : {}),
          } as unknown as never)
          .select('id')
          .single();
        if (error?.code === UNIQUE_VIOLATION) continue;
        if (error || !created) {
          console.warn('Failed to create issue:', item.canonical_key, error?.message);
          return;
        }
        issueId = (created as { id: string }).id;
        break;
      }
      const prev = existing as {
        id: string; status: string; recurrence_count: number; severity: IssueSeverity; title: string; last_seen_at: string; resolved_at: string | null;
        details?: Partial<CodeDetails> | null;
      };
      issueId = prev.id;
      // A trip saved late (recorded offline) is older than what the problem already
      // knows: it only adds its occurrence, it doesn't reopen or change the problem.
      const known = Math.max(new Date(prev.last_seen_at).getTime(), prev.resolved_at ? new Date(prev.resolved_at).getTime() : 0);
      const stale = new Date(occurredAt).getTime() < known;
      const escalates = SEVERITY_RANK[item.severity] > SEVERITY_RANK[prev.severity];
      const updates: Record<string, unknown> = {
        last_seen_at: occurredAt,
        severity: escalates ? item.severity : prev.severity,
        // A pending code that gets confirmed takes the confirmed wording; never the other way round.
        ...(escalates ? { title: item.title } : {}),
        ...(sessionId ? { last_session_id: sessionId } : {}),
        ...(item.details ? { details: item.details } : {}),
      };
      if (item.modules?.length) {
        const modules = Array.from(new Set([...(prev.details?.modules ?? []), ...item.modules])).sort();
        updates.details = { ...(prev.details ?? {}), source: 'dtc', modules };
      }
      if (prev.status === 'resolved') {
        updates.status = 'recurred';
        updates.recurrence_count = (prev.recurrence_count ?? 0) + 1;
      }
      // 'active' and 'recurred' stay as they are; 'ignored' stays ignored.
      if (!stale) await supabase.from('vehicle_issues').update(updates as unknown as never).eq('id', issueId);
    }
    if (!issueId) {
      console.warn('Could not create or find the issue:', item.canonical_key);
      return;
    }

    if (sessionId) {
      // Record the occurrence (upsert to handle re-uploads)
      await supabase
        .from('vehicle_issue_occurrences')
        .upsert(
          {
            issue_id: issueId,
            session_id: sessionId,
            severity: item.severity,
            occurred_at: occurredAt,
            evidence: item.evidence as unknown as Record<string, unknown>,
          } as unknown as never,
          { onConflict: 'issue_id,session_id' },
        );
    }
  } catch (err) {
    console.warn('Issue reconciliation error for', item.canonical_key, err);
  }
}

/**
 * After a session's flags are saved, reconcile them with the persistent
 * vehicle_issues table: create new problems, update existing ones and record
 * occurrences — without ever deleting historical data. Fault codes go through
 * syncFaultCodes().
 */
export async function reconcileIssues(
  sessionId: string,
  carProfileId: string,
  userId: string,
  flags: SessionFlag[],
  sessionStart: string | null,
): Promise<void> {
  const seen: Seen = { carProfileId, userId, sessionId, occurredAt: sessionStart ?? new Date().toISOString() };
  for (const f of flags) {
    if (f.severity === 'normal') continue;
    await upsertProblem({ canonical_key: f.canonical_key, title: f.message, severity: toIssueSeverity(f.severity), evidence: f.evidence }, seen);
  }
}

/**
 * Put the concerns the AI saw in a trip on the car's problem list, next to
 * the ones from fault codes and rules. The same concern seen again (same key)
 * updates its problem; AI warnings never close by themselves.
 */
export async function syncAiWarnings(
  carProfileId: string,
  userId: string,
  warnings: AiWarning[],
  sessionId: string,
  occurredAt: string = new Date().toISOString(),
): Promise<void> {
  const seen: Seen = { carProfileId, userId, sessionId, occurredAt };
  // A warning the owner ignored or marked as fixed never comes back, even if the AI raises it again.
  let dismissed = new Set<string>();
  try {
    const { data, error } = await supabase
      .from('vehicle_issues')
      .select('canonical_key')
      .eq('car_profile_id', carProfileId)
      .like('canonical_key', `${AI_PREFIX}%`)
      .in('status', ['ignored', 'resolved']);
    // A failed read looks like "nothing was dismissed" and would reopen what the owner closed.
    if (error) {
      console.warn('Could not read dismissed AI warnings:', error.message);
      return;
    }
    dismissed = new Set(((data ?? []) as { canonical_key: string }[]).map((i) => i.canonical_key));
  } catch (err) {
    console.warn('Could not read dismissed AI warnings:', err);
    return;
  }
  for (const w of warnings) {
    if (!/^[a-z0-9_]{3,40}$/.test(w.key) || !URGENCY_SEVERITY[w.urgency]) continue;
    if (dismissed.has(`${AI_PREFIX}${w.key}`)) continue;
    await upsertProblem({
      canonical_key: `${AI_PREFIX}${w.key}`,
      title: w.title,
      severity: URGENCY_SEVERITY[w.urgency],
      evidence: { source: 'ai', title: w.title, meaning: w.meaning },
      details: { source: 'ai', meaning: w.meaning, action: w.action },
    }, seen);
  }
}

export interface FaultCodeSync {
  stored: string[];
  pending: string[];
  /** The car answered the read; only then are missing codes taken as gone. */
  checked: boolean;
  /** Modules that fully answered this read. A code only counts as gone if the module that reported it is here. */
  modules?: string[];
  /** Which modules reported each code. */
  codeModules?: Record<string, string[]>;
}

/**
 * Bring the car's fault-code problems in line with one reading of the car,
 * from a trip or from the Scanner:
 * - confirmed codes are problems with their catalog severity;
 * - pending codes (seen once) are milder "keep an eye on it" problems, and
 *   take the confirmed severity if the car later confirms them;
 * - when the read worked, open code problems the car no longer reports are
 *   resolved by themselves (after a repair, or codes cleared in a shop).
 */
export async function syncFaultCodes(
  carProfileId: string,
  userId: string,
  codes: FaultCodeSync,
  sessionId: string | null,
  occurredAt: string = new Date().toISOString(),
): Promise<{ resolved: number }> {
  const seen: Seen = { carProfileId, userId, sessionId, occurredAt };
  for (const code of codes.stored) {
    await upsertProblem({ canonical_key: `${DTC_PREFIX}${code}`, title: code, severity: dtcSeverity(code), evidence: { code, modules: codes.codeModules?.[code] }, modules: codes.codeModules?.[code] }, seen);
  }
  for (const code of codes.pending) {
    await upsertProblem({ canonical_key: `${DTC_PREFIX}${code}`, title: `${code}${PENDING_SUFFIX}`, severity: 'warning', evidence: { code, pending: true, modules: codes.codeModules?.[code] }, modules: codes.codeModules?.[code] }, seen);
  }

  if (!codes.checked) return { resolved: 0 };
  const present = new Set([...codes.stored, ...codes.pending].map((c) => `${DTC_PREFIX}${c}`));
  const answeredModules = new Set(codes.modules ?? []);
  try {
    const { data: open } = await supabase
      .from('vehicle_issues')
      .select('id, canonical_key, last_seen_at, details')
      .eq('car_profile_id', carProfileId)
      .in('status', ['active', 'recurred']);
    const at = new Date(occurredAt).getTime();
    const gone = ((open ?? []) as { id: string; canonical_key: string; last_seen_at: string; details?: Partial<CodeDetails> | null }[])
      .filter((i) => i.canonical_key.startsWith(DTC_PREFIX) && !present.has(i.canonical_key))
      // Only a reading newer than the last time the code was seen can say it's gone.
      .filter((i) => at >= new Date(i.last_seen_at).getTime())
      // ...and only the modules that reported the code can say so: if one of them
      // didn't answer this time (timeout), its codes may well still be there.
      .filter((i) => {
        const reportedBy = i.details?.modules;
        return !reportedBy?.length || reportedBy.every((m) => answeredModules.has(m));
      });
    for (const issue of gone) {
      await supabase
        .from('vehicle_issues')
        .update({ status: 'resolved', resolved_at: occurredAt, resolved_note: CODE_GONE_NOTE } as unknown as never)
        .eq('id', issue.id);
    }
    return { resolved: gone.length };
  } catch (err) {
    console.warn('Could not close fault codes the car no longer reports:', err);
    return { resolved: 0 };
  }
}
