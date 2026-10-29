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
import type { FaultInspection } from '@/hooks/use-obd-scanner';

export default function FaultCodesPage() {
  const { t, i18n } = useTranslation();
  const obd = useObd();
  const { status, readDtcs, vin: connectedVin } = obd;
  const { user } = useAuth();
  const { selectedCar, selectedCarId } = useCarsContext();
  const [result, setResult] = useState<FaultInspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const requested = useRef(true);
  const scanning = useRef(false);
  const generation = useRef(0);
  const owner = useRef({ carId: selectedCarId, userId: user?.id });
  owner.current = { carId: selectedCarId, userId: user?.id };
  useEffect(() => {
    const current = ++generation.current;
    requested.current = true;
    setResult(null); setError(null); setSyncFailed(false);
    return () => { generation.current = current + 1; };
  }, [selectedCarId, user?.id]);
  const read = useCallback(async () => {
    if (scanning.current || status !== 'live') return;
    scanning.current = true;
    requested.current = false;
    const mine = generation.current;
    const carId = selectedCarId;
    const userId = user?.id;
    const vin = connectedVin;
    setBusy(true); setError(null); setResult(null); setSyncFailed(false);
    try {
      const readout = await readDtcs();
      if (mine !== generation.current || owner.current.carId !== carId || owner.current.userId !== userId) return;
      setResult({ readout, at: new Date().toISOString(), vin });
      if (carId && userId && !(selectedCar?.vin && vin && selectedCar.vin !== vin)) {
        try { await syncFaultCodes(carId, userId, readout, null, new Date().toISOString(), true); notifyProblemsChanged(); }
        catch { if (mine === generation.current) setSyncFailed(true); }
      }
    } catch (err) {
      if (mine === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      scanning.current = false;
      setBusy(false);
    }
  }, [status, readDtcs, connectedVin, selectedCarId, selectedCar?.vin, user?.id]);
  useEffect(() => { if (requested.current && obd.status === 'live' && !busy) void read(); }, [obd.status, read, busy]);
  const codes = result ? [...new Set([...result.readout.stored, ...result.readout.pending, ...result.readout.permanent])] : [];
  const complete = !!result && (result.readout.complete ?? (result.readout.checked && !!result.readout.modules?.length));
  const mismatch = !!(selectedCar?.vin && obd.vin && selectedCar.vin !== obd.vin);
  return <AppLayout refreshDisabled={busy}><div className="max-w-3xl space-y-4">
    <h2 className="text-xl font-bold">{t('codes.title', 'Read car fault codes')}</h2>
    {selectedCar && <p className="text-sm text-muted-foreground">{selectedCar.name}</p>}
    <p className="text-sm text-muted-foreground">{t('codes.hint', 'Connect the adapter and switch on the ignition. This reads codes without clearing anything in the car.')}</p>
    {mismatch && <p role="alert" className="text-sm text-warn">{t('codes.carMismatch', 'The connected VIN differs from the selected car. Results will not be saved to that car.')}</p>}
    <Card><CardContent className="space-y-3 p-4">
      {obd.status === 'live' ? <Button onClick={() => void read()} disabled={busy}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}{busy ? t('codes.reading', 'Reading car modules…') : t('codes.readAgain', 'Read codes again')}</Button>
        : <Button disabled={obd.status !== 'idle'} onClick={() => { requested.current = true; void obd.connect(); }}><Bluetooth className="mr-2 h-4 w-4" />{t('trip.connect', 'Connect to the car')}</Button>}
      {obd.status !== 'live' && <p role="status" className="text-sm text-muted-foreground">{t('codes.waiting', 'The car must be on and connected before codes can be read.')}</p>}
      {(error || obd.error) && <p role="alert" className="text-sm text-destructive">{error || obd.error}</p>}
      {busy && <p role="status" className="text-sm">{t('codes.reading', 'Reading car modules…')}</p>}
      {result && <>
        <p className="text-xs text-muted-foreground">{t('codes.checkedAt', 'Read at {{time}}', { time: formatAppDate(new Date(result.at), i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'medium' }) })}</p>
        {!complete && <p role="alert" className="text-sm text-warn">{t('codes.incomplete', 'The car did not answer all required requests. An empty result does not confirm that there are no fault codes.')}</p>}
        <div className="flex flex-wrap gap-2">{(['stored', 'pending', 'permanent'] as const).flatMap((kind) => result.readout[kind].map((code) => <Badge key={`${kind}:${code}`} variant="outline">{code} · {t(`codes.${kind}`, kind)}</Badge>))}</div>
        {(codes.length > 0 || complete) && <DTCPanel codes={codes} />}
        <p className="text-xs text-muted-foreground">{t('codes.modules', 'Modules that answered: {{modules}}', { modules: result.readout.modules?.join(', ') || '—' })}</p>
        <p className="text-xs text-muted-foreground">{t('scanner.codesLegend', 'Pending: the car saw it once and is still confirming. Permanent: only the car itself erases it, after confirming the fault is gone.')}</p>
        {syncFailed && <p role="alert" className="text-sm text-warn">{t('codes.syncFailed', 'Codes were read, but Problems could not be updated. Try reading again when online.')}</p>}
      </>}
    </CardContent></Card>
    <Link to="/issues" className="text-sm text-primary hover:underline">{t('problems.title', 'Problems')}</Link>
  </div></AppLayout>;
}
