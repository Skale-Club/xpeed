import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bluetooth, Loader2, ScanSearch } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import DTCPanel from '@/components/DTCPanel';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useObd } from '@/contexts/ObdScannerContext';
import { useAuth } from '@/contexts/AuthContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { notifyProblemsChanged } from '@/hooks/use-open-problems';
import { syncFaultCodes } from '@/lib/issue-reconciler';
import { formatAppDate } from '@/lib/app-date';
import { faultInspectionScope, loadFaultInspection, saveFaultInspection, type SavedFaultInspection } from '@/lib/obd/fault-inspection-cache';

export default function FaultCodesPage() {
  const { t, i18n } = useTranslation();
  const obd = useObd();
  const { status, readDtcs, vin: connectedVin } = obd;
  const { user } = useAuth();
  const { selectedCar, selectedCarId } = useCarsContext();
  const userId = user?.id;
  const profileVin = selectedCar?.vin || null;
  const scope = `${faultInspectionScope(userId, selectedCarId)}:${encodeURIComponent(profileVin ?? '')}`;
  const [snapshot, setSnapshot] = useState(() => ({ scope, record: loadFaultInspection(userId, selectedCarId, profileVin) }));
  const record = snapshot.scope === scope ? snapshot.record : null;
  const result = record?.inspection ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cacheFailed, setCacheFailed] = useState(false);
  const scanning = useRef(false);
  const generation = useRef(0);
  const owner = useRef(scope);
  owner.current = scope;
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot({ scope, record: loadFaultInspection(userId, selectedCarId, profileVin) });
    setError(null); setCacheFailed(false);
    return () => { generation.current = current + 1; };
  }, [scope, selectedCarId, userId, profileVin]);
  const read = useCallback(async () => {
    if (scanning.current || status !== 'live' || !selectedCarId || !userId) return;
    scanning.current = true;
    const mine = generation.current;
    const carId = selectedCarId;
    const vin = connectedVin;
    const current = () => mine === generation.current && owner.current === scope;
    const keep = (value: SavedFaultInspection) => {
      const saved = saveFaultInspection(userId, carId, value);
      if (current()) setCacheFailed(!saved);
    };
    setBusy(true); setError(null); setCacheFailed(false);
    try {
      const readout = await readDtcs();
      if (!current()) return;
      const mismatch = !!(profileVin && vin && profileVin !== vin);
      const value: SavedFaultInspection = { inspection: { readout, at: new Date().toISOString(), vin }, profileVin, syncFailed: !mismatch };
      setSnapshot({ scope, record: value });
      if (!mismatch) {
        keep(value);
        try {
          await syncFaultCodes(carId, userId, readout, null, value.inspection.at, true);
          const synced = { ...value, syncFailed: false };
          keep(synced);
          if (current()) { setSnapshot({ scope, record: synced }); notifyProblemsChanged(); }
        } catch { /* Keep the actual reading and its unsynced status, including across refreshes. */ }
      }
    } catch (err) {
      if (current()) setError(err instanceof Error ? err.message : String(err));
    } finally {
      scanning.current = false;
      setBusy(false);
    }
  }, [status, readDtcs, connectedVin, selectedCarId, profileVin, userId, scope]);
  const codes = result ? [...new Set([...result.readout.stored, ...result.readout.pending, ...result.readout.permanent])] : [];
  const complete = !!result && (result.readout.complete ?? (result.readout.checked && !!result.readout.modules?.length));
  const mismatch = !!(selectedCar?.vin && obd.vin && selectedCar.vin !== obd.vin);
  return <AppLayout refreshDisabled={busy}><div className="max-w-3xl space-y-4">
    <h2 className="text-xl font-bold">{t('codes.title', 'Read car fault codes')}</h2>
    {selectedCar && <p className="text-sm text-muted-foreground">{selectedCar.name}</p>}
    <p className="text-sm text-muted-foreground">{t('codes.hint', 'Connect the adapter and switch on the ignition. This reads codes without clearing anything in the car.')}</p>
    {mismatch && <p role="alert" className="text-sm text-warn">{t('codes.carMismatch', 'The connected VIN differs from the selected car. Results will not be saved to that car.')}</p>}
    <Card><CardContent className="space-y-3 p-4">
      {obd.status === 'live' ? <Button className="w-full" onClick={() => void read()} disabled={busy || !selectedCarId || !userId}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}{busy ? t('codes.reading', 'Reading car modules…') : result ? t('codes.readAgain', 'Read codes again') : t('codes.read', 'Read codes')}</Button>
        : <Button className="w-full" disabled={obd.status !== 'idle'} onClick={() => void obd.connect()}><Bluetooth className="mr-2 h-4 w-4" />{t('trip.connect', 'Connect to the car')}</Button>}
      {obd.status !== 'live' && <p role="status" className="text-sm text-muted-foreground">{t('codes.waiting', 'The car must be on and connected before codes can be read.')}</p>}
      {(error || obd.error) && <p role="alert" className="text-sm text-destructive">{error || obd.error}</p>}
      {busy && <p role="status" className="text-sm">{t('codes.reading', 'Reading car modules…')}</p>}
      {result && <>
        <p className="text-xs text-muted-foreground">{t('codes.checkedAt', 'Read at {{time}}', { time: formatAppDate(new Date(result.at), i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'medium' }) })}</p>
        {!complete && <p role="alert" className="text-sm text-warn">{t('codes.incomplete', 'The car did not answer all required requests. An empty result does not confirm that there are no fault codes.')}</p>}
        <div className="flex flex-wrap gap-2">{(['stored', 'pending', 'permanent'] as const).flatMap((kind) => result.readout[kind].map((code) => <Badge key={`${kind}:${code}`} variant="outline">{code} · {t(`codes.${kind}`, kind)}</Badge>))}</div>
        {(codes.length > 0 || complete) && <DTCPanel codes={codes} checked={complete} />}
        <p className="text-xs text-muted-foreground">{t('codes.modules', 'Modules that answered: {{modules}}', { modules: result.readout.modules?.join(', ') || '—' })}</p>
        <p className="text-xs text-muted-foreground">{t('scanner.codesLegend', 'Pending: the car saw it once and is still confirming. Permanent: only the car itself erases it, after confirming the fault is gone.')}</p>
        {!busy && record?.syncFailed && <p role="alert" className="text-sm text-warn">{t('codes.syncFailed', 'Codes were read, but Problems could not be updated. The saved reading is still available.')}</p>}
        {cacheFailed && <p role="alert" className="text-sm text-warn">{t('codes.cacheFailed', 'This device could not keep a copy of the reading. Reloading may lose this result.')}</p>}
      </>}
    </CardContent></Card>
    <Link to="/issues" className="text-sm text-primary hover:underline">{t('problems.title', 'Problems')}</Link>
  </div></AppLayout>;
}
