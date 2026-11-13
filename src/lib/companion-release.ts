// What the site knows about the newest Xpeed Companion: GET /api/companion/latest (server: api/companion/*, docs: docs/platform/RELEASES.md).
// Public, no sign-in. Used by the public /companion page and by the signed-in Companion screen.
import { useQuery } from '@tanstack/react-query';

export interface CompanionRelease {
  version: string;
  build: string;
  downloadUrl: string;
  sha256: string;
  size: number;
  releasedAt: string;
  minVersion: string;
  /** False while the installer is not code-signed: Windows SmartScreen may warn. */
  signed: boolean;
}

/** The one stable download link (it redirects to the current installer). */
export const COMPANION_DOWNLOAD_PATH = '/api/companion/download';
export const COMPANION_LATEST_PATH = '/api/companion/latest';

const isRelease = (data: unknown): data is CompanionRelease => {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Record<string, unknown>;
  return typeof r.version === 'string' && typeof r.sha256 === 'string' && typeof r.size === 'number'
    && typeof r.releasedAt === 'string' && typeof r.signed === 'boolean';
};

export async function fetchCompanionRelease(): Promise<CompanionRelease> {
  const response = await fetch(COMPANION_LATEST_PATH, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`companion release: ${response.status}`);
  const data: unknown = await response.json();
  if (!isRelease(data)) throw new Error('companion release: unexpected answer');
  return data;
}

/** The newest release; `data` is undefined while loading or when the server cannot say (the download link still works). */
export function useCompanionRelease() {
  return useQuery({
    queryKey: ['companion-release'],
    queryFn: fetchCompanionRelease,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

/** 3145728 -> "3.0 MB". */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
