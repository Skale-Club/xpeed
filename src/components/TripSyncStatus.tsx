import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useObd } from '@/contexts/ObdScannerContext';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { formatAppDate } from '@/lib/app-date';
export default function TripSyncStatus() {
  const { getTripSyncStatus, retryPendingTrips, savingTrip } = useObd(); const { user } = useAuth(); const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{ pending: number; latestError: string | null; local?: {samples: number; at: number} | null; cloud?: { samples: number; at: number } | null } | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { let active = true; const refresh = async () => { try { const next = await getTripSyncStatus(); if (active) { setSnapshot(next); setFailed(false); } } catch { if (active) setFailed(true); } }; void refresh(); const id = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000); return () => { active = false; clearInterval(id); }; }, [getTripSyncStatus, savingTrip]);
  const retry = async () => { setBusy(true); try { await retryPendingTrips(); setSnapshot(await getTripSyncStatus()); setFailed(false); } catch { setFailed(true); } finally { setBusy(false); } };
  return <Card><CardContent className="space-y-2 p-4"><h3 className="text-sm font-semibold">{t('sync.title', 'Trips waiting to be saved')}</h3><p className="break-all text-xs text-muted-foreground">{user?.email}</p>
    <p className="text-sm" role="status">{snapshot ? t('sync.pending', '{{count}} trips waiting to be saved', { count: snapshot.pending }) : t('sync.checking', 'Checking…')}</p>
    {snapshot?.local && <p className="text-xs">{t('sync.localConfirmed', 'Saved on this phone: {{count}} readings', {count: snapshot.local.samples})} · {formatAppDate(new Date(snapshot.local.at), undefined, {timeStyle:'short'})}</p>}
    {snapshot?.cloud && <p className="text-xs text-success">{t('sync.cloudConfirmed', 'Backed up: {{count}} readings', { count: snapshot.cloud.samples })}  ·  {formatAppDate(new Date(snapshot.cloud.at), undefined, {timeStyle:'short'})}</p>}
    {(failed || snapshot?.latestError) && <p role="alert" className="break-words text-xs text-warn">{snapshot?.latestError || t('sync.failed', 'Couldn\'t check your trips.')}</p>}
    <p className="text-xs text-muted-foreground">{t('sync.hint', 'Trips are saved to your account as you drive. Any that couldn\'t be saved yet are sent when you\'re back online.')}</p>
    <Button variant="outline" size="sm" disabled={busy || savingTrip} onClick={() => void retry()}>{busy || savingTrip ? t('sync.sending', 'Sending…') : t('sync.retry', 'Save waiting trips now')}</Button>
  </CardContent></Card>;
}
