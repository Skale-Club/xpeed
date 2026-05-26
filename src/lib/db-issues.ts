import { supabase } from '@/integrations/supabase/client';

export type IssueSeverity = 'critical' | 'serious' | 'warning' | 'easy_fix';
export type IssueStatus = 'active' | 'resolved' | 'recurred' | 'ignored';

export interface VehicleIssue {
  id: string;
  car_profile_id: string;
  canonical_key: string;
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
  first_seen_at: string;
  last_seen_at: string;
  first_session_id: string | null;
  last_session_id: string | null;
  resolved_at: string | null;
  resolved_note: string | null;
  recurrence_count: number;
  created_at: string;
}

export interface IssueOccurrence {
  id: string;
  issue_id: string;
  session_id: string;
  severity: string;
  occurred_at: string;
  evidence: Record<string, unknown> | null;
}

export async function getIssuesForCar(carProfileId: string): Promise<VehicleIssue[]> {
  const { data, error } = await supabase
    .from('vehicle_issues')
    .select('*')
    .eq('car_profile_id', carProfileId)
    .order('last_seen_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch issues: ${error.message}`);
  return (data || []) as unknown as VehicleIssue[];
}

export async function getOccurrencesForIssue(issueId: string): Promise<IssueOccurrence[]> {
  const { data, error } = await supabase
    .from('vehicle_issue_occurrences')
    .select('*')
    .eq('issue_id', issueId)
    .order('occurred_at', { ascending: false });

  if (error) throw new Error(`Failed to fetch occurrences: ${error.message}`);
  return (data || []) as unknown as IssueOccurrence[];
}

export async function resolveIssue(issueId: string, note?: string): Promise<void> {
  const { error } = await supabase
    .from('vehicle_issues')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolved_note: note || null,
    } as unknown as never)
    .eq('id', issueId);

  if (error) throw new Error(`Failed to resolve issue: ${error.message}`);
}

export async function ignoreIssue(issueId: string): Promise<void> {
  const { error } = await supabase
    .from('vehicle_issues')
    .update({ status: 'ignored' } as unknown as never)
    .eq('id', issueId);

  if (error) throw new Error(`Failed to ignore issue: ${error.message}`);
}

export async function reopenIssue(issueId: string): Promise<void> {
  const { error } = await supabase
    .from('vehicle_issues')
    .update({
      status: 'active',
      resolved_at: null,
      resolved_note: null,
    } as unknown as never)
    .eq('id', issueId);

  if (error) throw new Error(`Failed to reopen issue: ${error.message}`);
}
