import { supabase } from '@/integrations/supabase/client';
import type { SessionFlag } from './insight-engine';
import type { IssueSeverity } from './db-issues';

// Map session flag severities to issue severity levels.
// 'warning' and 'easy_fix' are reserved for future rule granularity.
function toIssueSeverity(flagSeverity: string): IssueSeverity {
  return flagSeverity === 'critical' ? 'critical' : 'serious';
}

/**
 * After a session's flags are saved, reconcile them with the persistent
 * vehicle_issues table. Creates new issues, updates existing ones, and
 * records occurrences — without ever deleting historical data.
 */
export async function reconcileIssues(
  sessionId: string,
  carProfileId: string,
  userId: string,
  flags: SessionFlag[],
  sessionStart: string | null
): Promise<void> {
  // Only process flags that indicate a real problem (not 'normal')
  const problemFlags = flags.filter((f) => f.severity !== 'normal');
  if (problemFlags.length === 0) return;

  const occurredAt = sessionStart ?? new Date().toISOString();

  for (const flag of problemFlags) {
    const severity = toIssueSeverity(flag.severity);

    try {
      // Look up existing issue for this vehicle + canonical key
      const { data: existing } = await supabase
        .from('vehicle_issues')
        .select('id, status, recurrence_count, severity')
        .eq('car_profile_id', carProfileId)
        .eq('canonical_key', flag.canonical_key)
        .maybeSingle();

      let issueId: string;

      if (!existing) {
        // First time this issue appears — create it
        const { data: created, error } = await supabase
          .from('vehicle_issues')
          .insert({
            car_profile_id: carProfileId,
            user_id: userId,
            canonical_key: flag.canonical_key,
            title: flag.message,
            severity,
            status: 'active',
            first_seen_at: occurredAt,
            last_seen_at: occurredAt,
            first_session_id: sessionId,
            last_session_id: sessionId,
          } as unknown as never)
          .select('id')
          .single();

        if (error || !created) {
          console.warn('Failed to create issue:', flag.canonical_key, error?.message);
          continue;
        }
        issueId = (created as { id: string }).id;
      } else {
        issueId = (existing as { id: string; status: string; recurrence_count: number; severity: string }).id;
        const existingStatus = (existing as { status: string }).status;
        const wasResolved = existingStatus === 'resolved';

        // Escalate severity if the new occurrence is more severe
        const severityRank: Record<IssueSeverity, number> = {
          critical: 4, serious: 3, warning: 2, easy_fix: 1,
        };
        const existingSev = (existing as { severity: IssueSeverity }).severity;
        const newSeverity =
          severityRank[severity] > severityRank[existingSev] ? severity : existingSev;

        const updates: Record<string, unknown> = {
          last_seen_at: occurredAt,
          last_session_id: sessionId,
          severity: newSeverity,
        };

        if (wasResolved) {
          updates.status = 'recurred';
          updates.recurrence_count =
            ((existing as { recurrence_count: number }).recurrence_count ?? 0) + 1;
        } else if (existingStatus === 'active') {
          // stays active — no status change
        }
        // 'recurred' stays 'recurred', 'ignored' stays 'ignored'

        await supabase
          .from('vehicle_issues')
          .update(updates as unknown as never)
          .eq('id', issueId);
      }

      // Record the occurrence (upsert to handle re-uploads)
      await supabase
        .from('vehicle_issue_occurrences')
        .upsert(
          {
            issue_id: issueId,
            session_id: sessionId,
            severity,
            occurred_at: occurredAt,
            evidence: flag.evidence as unknown as Record<string, unknown>,
          } as unknown as never,
          { onConflict: 'issue_id,session_id' }
        );
    } catch (err) {
      console.warn('Issue reconciliation error for', flag.canonical_key, err);
    }
  }
}
