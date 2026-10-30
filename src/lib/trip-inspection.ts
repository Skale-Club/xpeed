import type { FaultCodeReadout } from './obd/fault-codes';
import type { SessionSummary, Session } from '@/types/session';
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
export function savedFaultReadout(summary: SessionSummary | null | undefined): FaultCodeReadout | null {
  const value = summary?.faultCodes as Partial<FaultCodeReadout> | undefined;
  if (!value || !strings(value.stored) || !strings(value.pending) || typeof value.checked !== 'boolean') return null;
  return {stored:value.stored,pending:value.pending,permanent:strings(value.permanent)?value.permanent:[],checked:value.checked,
    complete:typeof value.complete === 'boolean' ? value.complete : undefined,modules:strings(value.modules)?value.modules:[],
    codeModules:value.codeModules && typeof value.codeModules === 'object' ? Object.fromEntries(Object.entries(value.codeModules).filter(([,modules])=>strings(modules))) : {}};
}
export function completeTripInspection(session: Pick<Session,'summary'> | null | undefined): boolean {
  const read = savedFaultReadout(session?.summary);
  return !!read && read.checked && (read.complete ?? !!read.modules?.length);
}
export function tripCodes(session: Pick<Session,'summary'> & {active_dtcs?: string[] | null}): string[] {
  const read = savedFaultReadout(session.summary);
  return [...new Set([...(session.active_dtcs ?? []),...(read?.stored ?? []),...(read?.pending ?? [])])];
}
