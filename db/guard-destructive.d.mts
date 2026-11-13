export const PRODUCTION_FLAG: string;
export const YES_FLAG: string;
export const DEFAULT_PROD_HOSTS: string[];
export class GuardError extends Error {}
export function productionHosts(env?: Record<string, string | undefined>): string[];
export function describeTarget(target: unknown): { kind: 'url' | 'path'; raw: string; host: string; port: string; database: string; label: string };
export function findProductionMatch(target: unknown, env?: Record<string, string | undefined>): string | null;
type Common = { argv?: string[]; isTTY?: boolean; ask?: (question: string) => Promise<string>; say?: (message: string) => void };
export function guardDestructive(options: Common & { target?: string; targets?: string[]; action: string; env?: Record<string, string | undefined> }): Promise<{ production: boolean; host: string | null }>;
export function confirmDestructive(options: Common & { target: string; action: string; plan?: string[]; production?: boolean }): Promise<void>;
export function exitOnGuardError(error: unknown): boolean;
