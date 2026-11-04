import type { Client } from 'pg';
export const MIGRATIONS_DIR: string;
export function versionOf(file: string): string;
export function listMigrations(dir?: string): string[];
export function migrate(client: Client, options?: { dir?: string; log?: (message: string) => void }): Promise<{ applied: string[]; adopted: string[]; compat: boolean }>;
export function ensureIdentityProject(client: Client, projectId?: string): Promise<void>;
