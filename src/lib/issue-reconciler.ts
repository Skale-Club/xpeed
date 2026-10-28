import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as typedClient } from '@/integrations/supabase/client';
import type { SessionFlag } from './insight-engine';
import type { IssueSeverity } from './db-issues';
import { CODE_GONE_NOTE, DTC_PREFIX, PENDING_SUFFIX, dtcSeverity } from './problems';

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
}

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
    const { data: existing } = await supabase
      .from('vehicle_issues')
      .select('id, status, recurrence_count, severity, title, last_seen_at, resolved_at')
      .eq('car_profile_id', carProfileId)
      .eq('canonical_key', item.canonical_key)
      .maybeSingle();

    let issueId: string;
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
        } as unknown as never)
        .select('id')
        .single();
      if (error || !created) {
        console.warn('Failed to create issue:', item.canonical_key, error?.message);
        return;
      }
      issueId = (created as { id: string }).id;
    } else {
      const prev = existing as {
        id: string; status: string; recurrence_count: number; severity: IssueSeverity; title: string; last_seen_at: string; resolved_at: string | null;
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
      };
      if (prev.status === 'resolved') {
        updates.status = 'recurred';
        updates.recurrence_count = (prev.recurrence_count ?? 0) + 1;
      }
      // 'active' and 'recurred' stay as they are; 'ignored' stays ignored.
      if (!stale) await supabase.from('vehicle_issues').update(updates as unknown as never).eq('id', issueId);
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

export interface FaultCodeSync {
  stored: string[];
  pending: string[];
  /** The car answered the read; only then are missing codes taken as gone. */
  checked: boolean;
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
    await upsertProblem({ canonical_key: `${DTC_PREFIX}${code}`, title: code, severity: dtcSeverity(code), evidence: { code } }, seen);
  }
  for (const code of codes.pending) {
    await upsertProblem({ canonical_key: `${DTC_PREFIX}${code}`, title: `${code}${PENDING_SUFFIX}`, severity: 'warning', evidence: { code, pending: true } }, seen);
  }

  if (!codes.checked) return { resolved: 0 };
  const present = new Set([...codes.stored, ...codes.pending].map((c) => `${DTC_PREFIX}${c}`));
  try {
    const { data: open } = await supabase
      .from('vehicle_issues')
      .select('id, canonical_key, last_seen_at')
      .eq('car_profile_id', carProfileId)
      .in('status', ['active', 'recurred']);
    const at = new Date(occurredAt).getTime();
    const gone = ((open ?? []) as { id: string; canonical_key: string; last_seen_at: string }[])
      .filter((i) => i.canonical_key.startsWith(DTC_PREFIX) && !present.has(i.canonical_key))
      // Only a reading newer than the last time the code was seen can say it's gone.
      .filter((i) => at >= new Date(i.last_seen_at).getTime());
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
