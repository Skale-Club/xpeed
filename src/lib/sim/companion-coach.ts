import { getCurrentUser } from '@/lib/auth/session';
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';
import { isDemoMode } from './demo/mode';

/** Device capability only. Credentials and billing selection remain admin-only. */
export async function setCompanionCoachPermission(accountId: string, deviceId: string, enabled: boolean, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 15_000);
  const unavailable = () => new Error('companion_permission_unavailable');
  const wait = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const aborted = () => { controller.signal.removeEventListener('abort', aborted); reject(unavailable()); };
    if (controller.signal.aborted) { reject(unavailable()); return; }
    controller.signal.addEventListener('abort', aborted, { once: true });
    work.then((value) => { controller.signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { controller.signal.removeEventListener('abort', aborted); reject(error); });
  });
  const assertAccount = async () => {
    if (controller.signal.aborted || signal?.aborted || isDemoMode() || !accountId) throw unavailable();
    const { data: { user } } = await wait(getCurrentUser());
    if (controller.signal.aborted || signal?.aborted || isDemoMode() || !accountId || user?.id !== accountId) throw unavailable();
  };
  try {
    await assertAccount();
    const token = await wait(getAccessToken());
    await assertAccount();
    if (!token) throw unavailable();
    const response = await fetch(`${publicAppUrl()}/api/sim/devices?id=${encodeURIComponent(deviceId)}`, {
      method: 'PATCH', cache: 'no-store', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, enabled }),
    });
    await assertAccount();
    if (!response.ok) throw unavailable();
    const body: unknown = await response.json();
    await assertAccount();
    if (!body || typeof body !== 'object' || (body as { enabled?: unknown }).enabled !== enabled) throw unavailable();
    return enabled;
  } catch { throw unavailable(); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
