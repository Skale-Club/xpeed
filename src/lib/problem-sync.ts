import { supabase } from '@/integrations/supabase/client';
import { publicAppUrl } from './trips';
import { notifyProblemsChanged } from '@/hooks/use-open-problems';
export async function syncSavedProblems(sessionId?: string): Promise<{synced:number;pending:number}> {
  const {data}=await supabase.auth.getSession();
  if(!data.session) return {synced:0,pending:0};
  const response=await fetch(`${publicAppUrl()}/api/sync-problems`,{method:'POST',headers:{Authorization:`Bearer ${data.session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({sessionId}),signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw Error('Problem synchronization pending');
  const result=await response.json();
  if(result.synced) notifyProblemsChanged();
  return result;
}
