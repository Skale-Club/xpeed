import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useObd } from '@/contexts/ObdScannerContext';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
export default function TripSyncStatus() {
  const { getTripSyncStatus, retryPendingTrips, savingTrip } = useObd(); const { user } = useAuth(); const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{ pending: number; latestError: string | null; cloud?: { samples: number; at: number } | null } | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { let active = true; const refresh = async () => { try { const next = await getTripSyncStatus(); if (active) { setSnapshot(next); setFailed(false); } } catch { if (active) setFailed(true); } }; void refresh(); const id = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000); return () => { active = false; clearInterval(id); }; }, [getTripSyncStatus, savingTrip]);
  const retry = async () => { setBusy(true); try { await retryPendingTrips(); setSnapshot(await getTripSyncStatus()); setFailed(false); } catch { setFailed(true); } finally { setBusy(false); } };
  return <Card><CardContent className="space-y-2 p-4"><h3 className="text-sm font-semibold">{t('sync.title', 'Trip synchronization')}</h3><p className="break-all text-xs text-muted-foreground">{user?.email}</p>
    <p className="text-sm" role="status">{snapshot ? t('sync.pending', '{{count}} pending trips found on this device', { count: snapshot.pending }) : t('sync.checking', 'Checking this device…')}</p>
    {snapshot?.cloud && <p className="text-xs text-success">{t('sync.cloudConfirmed', 'Cloud backup confirmed: {{count}} readings', { count: snapshot.cloud.samples })} · {new Date(snapshot.cloud.at).toLocaleTimeString()}</p>}
    {(failed || snapshot?.latestError) && <p role="alert" className="break-words text-xs text-warn">{snapshot?.latestError || t('sync.failed', 'Could not check trip synchronization.')}</p>}
    <p className="text-xs text-muted-foreground">{t('sync.hint', 'During recording, copies are saved on this device and sent to the cloud in chunks. Pending copies stay until the completed trip is confirmed. This checks the current account; it cannot inspect another phone.')}</p>
    <Button variant="outline" size="sm" disabled={busy || savingTrip} onClick={() => void retry()}>{busy || savingTrip ? t('sync.sending', 'Sending…') : t('sync.retry', 'Retry pending trips')}</Button>
  </CardContent></Card>;
}
