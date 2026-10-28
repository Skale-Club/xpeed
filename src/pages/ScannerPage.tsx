import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bluetooth, BluetoothConnected, Loader2, ScanSearch, Eraser, Fingerprint, Info,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import DTCPanel from '@/components/DTCPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useCarsContext } from '@/contexts/CarsContext';
import { useAuth } from '@/contexts/AuthContext';
import { syncFaultCodes } from '@/lib/issue-reconciler';
import { useToast } from '@/hooks/use-toast';
import type { DtcReadout, LiveChannel } from '@/hooks/use-obd-scanner';
import { useObd } from '@/contexts/ObdScannerContext';
import { formatValue } from '@/lib/obd/format';
import { CustomPidsCard } from '@/components/scanner/CustomPidsCard';
import { TerminalCard } from '@/components/scanner/TerminalCard';
import { EcuScanCard } from '@/components/scanner/EcuScanCard';

function LiveTile({ channel, value }: { channel: LiveChannel; value: number | null | undefined }) {
  const pct = value == null ? 0 : ((value - channel.min) / (channel.max - channel.min)) * 100;
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-3 space-y-2">
        <p className="text-[11px] text-muted-foreground leading-tight truncate" title={channel.name}>{channel.name}</p>
        <p className="text-xl font-bold text-foreground tabular-nums">
          {formatValue(value, channel.unit)}
          <span className="text-xs font-normal text-muted-foreground ml-1">{channel.unit}</span>
        </p>
        <Progress value={Math.max(0, Math.min(100, pct))} className="h-1" />
      </CardContent>
    </Card>
  );
}

export default function ScannerPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedCar } = useCarsContext();
  const { user } = useAuth();
  const scanner = useObd();
  const { customPids, updateCustomPids } = scanner;
  const { status, connection, channels, values, cycleMs } = scanner;

  const [dtcs, setDtcs] = useState<DtcReadout | null>(null);
  const [vin, setVin] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<'dtc' | 'clear' | 'vin' | null>(null);

  // Reset diagnostics when the connection goes away.
  useEffect(() => {
    if (status !== 'live') {
      setDtcs(null);
      setVin(undefined);
    }
  }, [status]);

  const live = status === 'live';
  const allCodes = dtcs ? Array.from(new Set([...dtcs.stored, ...dtcs.pending, ...dtcs.permanent])) : [];

  const run = async (kind: 'dtc' | 'clear' | 'vin', fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast({ title: t('scanner.error', 'Scanner error'), description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  // Every read here also updates the car's Problems, the same way a trip does.
  const readAndSync = async () => {
    const readout = await scanner.readDtcs();
    setDtcs(readout);
    if (selectedCar && user) {
      const { resolved } = await syncFaultCodes(selectedCar.id, user.id, readout, null);
      if (resolved > 0) {
        toast({ title: t('problems.synced', 'Problems updated'), description: t('problems.syncedHint', { count: resolved }) });
      }
    }
  };
  const handleReadDtcs = () => run('dtc', readAndSync);
  const handleReadVin = () => run('vin', async () => setVin(await scanner.readVin()));
  const handleClearDtcs = () => run('clear', async () => {
    await scanner.clearDtcs();
    toast({ title: t('scanner.cleared', 'Trouble codes cleared') });
    await readAndSync();
  });

  return (
    <AppLayout>
      <div className="space-y-6 max-w-5xl">
        <div className="flex items-center gap-2">
          <Bluetooth className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-bold text-foreground">
            {t('scanner.title', 'OBD2 Scanner')}
            {selectedCar && <span className="text-muted-foreground font-normal"> — {selectedCar.name}</span>}
          </h2>
        </div>

        {status === 'unsupported' && (
          <Alert variant="destructive">
            <Info className="h-4 w-4" />
            <AlertTitle>{t('scanner.unsupportedTitle', 'Bluetooth is not available in this browser')}</AlertTitle>
            <AlertDescription>
              {t('scanner.unsupportedBody', 'The live scanner needs Web Bluetooth: use Chrome or Edge on Android, Windows, macOS or ChromeOS. Safari and iPhone/iPad are not supported.')}
            </AlertDescription>
          </Alert>
        )}

        {/* Connection */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              {live ? <BluetoothConnected className="w-4 h-4 text-success" /> : <Bluetooth className="w-4 h-4" />}
              {t('scanner.adapter', 'Adapter')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {live && connection ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="outline" className="font-mono">{connection.deviceName}</Badge>
                <Badge variant="outline" className="font-mono">{connection.version}</Badge>
                <Badge variant="outline" className="font-mono">
                  {t('scanner.protocol', 'Protocol')} {connection.protocol}{connection.isCan ? ' (CAN)' : ''}
                </Badge>
                {connection.multiPid && (
                  <Badge variant="outline" className="font-mono">multi-PID</Badge>
                )}
                {cycleMs !== null && channels.length > 0 && (
                  <Badge variant="secondary" className="font-mono">
                    {t('scanner.refresh', 'Refresh')} {(cycleMs / 1000).toFixed(1)} s
                  </Badge>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('scanner.howTo', 'Plug a Bluetooth LE ELM327 adapter (e.g. Vgate iCar Pro BLE, OBDLink CX, Veepeak BLE+) into the OBD2 port, turn the ignition on, then connect. Classic-Bluetooth and Wi-Fi adapters cannot be used from a browser.')}
              </p>
            )}
            {scanner.error && <p className="text-xs text-destructive">{scanner.error}</p>}
            {scanner.linkFailed && (
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-1">
                <li>{t('scanner.linkHintBusy', "The adapter accepts only one connection: close Car Scanner/Torque on your phone or turn the phone's Bluetooth off.")}</li>
                <li>{t('scanner.linkHintPower', 'Make sure the ignition is on and the adapter light is on, then unplug and replug it to wake it up.')}</li>
                <li>{t('scanner.linkHintPaired', 'If you paired it in the system Bluetooth settings before, remove it there and try again.')}</li>
              </ul>
            )}
            <div className="flex gap-2">
              {live ? (
                <Button size="sm" variant="outline" onClick={scanner.disconnect}>
                  {t('scanner.disconnect', 'Disconnect')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => void scanner.connect()} disabled={status !== 'idle'}>
                  {status === 'connecting'
                    ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                    : <Bluetooth className="w-3.5 h-3.5 mr-2" />}
                  {status === 'connecting' ? t('scanner.connecting', 'Connecting…') : t('scanner.connect', 'Connect adapter')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Live data */}
        {live && (
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-foreground">{t('scanner.liveData', 'Live data')}</h3>
            {channels.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('scanner.noPids', 'The ECU did not report any supported parameters.')}</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {channels.map((ch) => <LiveTile key={ch.header} channel={ch} value={values[ch.header]} />)}
              </div>
            )}
          </div>
        )}

        {/* Diagnostics */}
        {live && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <ScanSearch className="w-4 h-4" />
                {t('scanner.diagnostics', 'Diagnostics')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={handleReadDtcs} disabled={busy !== null}>
                  {busy === 'dtc' ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5 mr-2" />}
                  {t('scanner.readDtcs', 'Read trouble codes')}
                </Button>
                <Button size="sm" variant="outline" onClick={handleReadVin} disabled={busy !== null}>
                  {busy === 'vin' ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Fingerprint className="w-3.5 h-3.5 mr-2" />}
                  {t('scanner.readVin', 'Read VIN')}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="outline" className="text-destructive" disabled={busy !== null}>
                      {busy === 'clear' ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Eraser className="w-3.5 h-3.5 mr-2" />}
                      {t('scanner.clearDtcs', 'Clear codes')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('scanner.clearTitle', 'Clear trouble codes?')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('scanner.clearBody', 'This turns off the check-engine light and erases stored codes, freeze-frame data and readiness monitors. The fault itself is not fixed and the code will come back if it persists. Do this with the engine off and the ignition on.')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
                      <AlertDialogAction onClick={handleClearDtcs}>{t('scanner.clearConfirm', 'Clear codes')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              {vin !== undefined && (
                <p className="text-xs">
                  <span className="text-muted-foreground">VIN: </span>
                  <span className="font-mono font-bold select-all">{vin ?? t('scanner.vinUnavailable', 'not reported by this vehicle')}</span>
                </p>
              )}

              {dtcs && (
                <div className="space-y-2">
                  {(dtcs.pending.length > 0 || dtcs.permanent.length > 0) && (
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      {dtcs.pending.map((c) => (
                        <Badge key={`p-${c}`} variant="outline" className="font-mono">{c} · {t('scanner.pending', 'pending')}</Badge>
                      ))}
                      {dtcs.permanent.map((c) => (
                        <Badge key={`x-${c}`} variant="outline" className="font-mono">{c} · {t('scanner.permanent', 'permanent')}</Badge>
                      ))}
                    </div>
                  )}
                  <DTCPanel codes={allCodes} />
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <CustomPidsCard
          pids={customPids}
          onChange={updateCustomPids}
          headersUnsupported={live && connection ? !connection.isCan : false}
        />

        {live && <TerminalCard onSend={scanner.sendRaw} />}

        {live && connection?.isCan && (
          <EcuScanCard findEcus={scanner.findEcus} sweepMode21={scanner.sweepMode21} />
        )}
      </div>
    </AppLayout>
  );
}
