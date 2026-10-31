import { supabase } from '@/integrations/supabase/client';
import { createIssueReconciler } from './issue-reconciler-core';
export type { FaultCodeSync } from './issue-reconciler-core';
export const { reconcileIssues, syncFaultCodes, syncAiWarnings } = createIssueReconciler(supabase);
