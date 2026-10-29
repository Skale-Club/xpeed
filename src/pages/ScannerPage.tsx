import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bluetooth, BluetoothConnected, Loader2, ScanSearch, Eraser, Fingerprint, Info,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import DTCPanel from '@/components/DTCPanel';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useCarsContext } from '@/contexts/CarsContext';
import { useAuth } from '@/contexts/AuthContext';
import { syncFaultCodes } from '@/lib/issue-reconciler';
import { notifyProblemsChanged } from '@/hooks/use-open-problems';
import { useToast } from '@/hooks/use-toast';
import type { DtcReadout, LiveChannel } from '@/hooks/use-obd-scanner';
import { useObd, useObdLive } from '@/contexts/ObdScannerContext';
import { formatValue } from '@/lib/obd/format';
import { channelLabel } from '@/lib/obd/pid-names';
import { QuickGauge, coolantTone } from '@/components/trip/QuickGauge';
import { WaitingNotice } from '@/components/trip/WaitingNotice';
import { CustomPidsCard } from '@/components/scanner/CustomPidsCard';
import { TerminalCard } from '@/components/scanner/TerminalCard';
import { EcuScanCard } from '@/components/scanner/EcuScanCard';

type Tab = 'readings' | 'codes' | 'tools';

// The three readings everyone understands get a big dial at the top.
const HEADLINE_PIDS = [0x0c, 0x0d, 0x05];

/** A reading as a dashboard tile: name, big value, and a thin bar for where it sits in its range. */
function ReadingTile({ label, channel, value }: { label: string; channel: LiveChannel; value: number | null | undefined }) {
  const pct = value == null ? 0 : ((value - channel.min) / (channel.max - channel.min)) * 100;
  return (
    <div
      className={`flex flex-col justify-between gap-2 rounded-xl border border-border bg-card p-3 ${value == null ? 'opacity-50' : ''}`}
      data-testid="reading-tile"
    >
      <p className="line-clamp-2 text-xs leading-snug text-muted-foreground" title={label}>{label}</p>
      <div>
        <p className="text-2xl font-bold leading-none tabular-nums text-foreground">
          <span>{formatValue(value, channel.unit)}</span>
          <span className="ml-1 text-xs font-normal text-muted-foreground">{channel.unit}</span>
        </p>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function ScannerPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedCar } = useCarsContext();
  const { user } = useAuth();
  const scanner = useObd();
  const { customPids, updateCustomPids } = scanner;
  const { status, connection, channels } = scanner;
  const { values, cycleMs } = useObdLive();

  const [dtcs, setDtcs] = useState<DtcReadout | null>(null);
  const [vin, setVin] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<'dtc' | 'clear' | 'vin' | null>(null);
  const [tab, setTab] = useState<Tab>('readings');

  // Reset diagnostics when the connection goes away.
  useEffect(() => {
    if (status !== 'live') {
      setDtcs(null);
      setVin(undefined);
    }
  }, [status]);

  const live = status === 'live';
  const allCodes = dtcs ? Array.from(new Set([...dtcs.stored, ...dtcs.pending, ...dtcs.permanent])) : [];
  // A clear erases stored and pending codes; permanent ones only the car itself can erase.
  const clearable = dtcs ? Array.from(new Set([...dtcs.stored, ...dtcs.pending])) : [];

  const run = async (kind: 'dtc' | 'clear' | 'vin', fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast({ title: t('scanner.error', "Couldn't talk to the car"), description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
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
      notifyProblemsChanged();
      if (resolved > 0) {
        toast({ title: t('problems.synced', 'Problems updated'), description: t('problems.syncedHint', { count: resolved }), variant: 'success' });
      }
    }
  };
  const handleReadDtcs = () => run('dtc', readAndSync);
  const handleReadVin = () => run('vin', async () => setVin(await scanner.readVin()));
  const handleClearDtcs = () => run('clear', async () => {
    await scanner.clearDtcs();
    toast({
      title: t('scanner.cleared', 'Codes cleared in the car'),
      description: t('scanner.clearedHint', "The check-engine light should go off. If the fault is still there, the car turns it on again after testing."),
      variant: 'success',
    });
    await readAndSync();
  });

  // Dashboard: the big three as dials, then every other reading as a tile,
  // the ones the car is answering first.
  const headline = HEADLINE_PIDS
    .map((pid) => channels.find((ch) => ch.def?.pid === pid))
    .filter((ch): ch is LiveChannel => !!ch);
  const others = channels
    .filter((ch) => !headline.includes(ch))
    .map((ch) => ({ ch, label: channelLabel(ch, t), value: values[ch.header] }))
    .sort((a, b) => Number(a.value == null) - Number(b.value == null));

  const tabs: { key: Tab; label: string }[] = [
    { key: 'readings', label: t('scanner.tabs.readings', 'Readings') },
    { key: 'codes', label: t('scanner.tabs.codes', 'Codes') },
    { key: 'tools', label: t('scanner.tabs.tools', 'Tools') },
  ];

  const customPidsCard = (
    <CustomPidsCard
      pids={customPids}
      onChange={updateCustomPids}
      headersUnsupported={live && connection ? !connection.isCan : false}
    />
  );

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-4">
        <div>
          <h2 className="text-xl font-bold">{t('scanner.title', 'OBD2 Scanner')}</h2>
          {selectedCar && <p className="text-sm text-muted-foreground">{selectedCar.name}</p>}
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

        {/* Connection: one line when connected, how-to and the button when not. */}
        <Card>
          <CardContent className="space-y-3 p-4">
            {live && connection ? (
              <div className="flex items-center gap-3">
                <BluetoothConnected className="h-5 w-5 shrink-0 text-success" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {t('scanner.connected', 'Connected')} · <span className="font-mono">{connection.deviceName}</span>
                  </p>
                  <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground" data-testid="connection-details">
                    <span>{connection.version}</span>
                    <span aria-hidden="true">·</span>
                    <span>{t('scanner.protocol', 'Protocol')} {connection.protocol}{connection.isCan ? ' (CAN)' : ''}</span>
                    {connection.multiPid && <><span aria-hidden="true">·</span><span>multi-PID</span></>}
                    {cycleMs !== null && channels.length > 0 && (
                      <><span aria-hidden="true">·</span><span>{t('scanner.updates', 'updates every {{seconds}} s', { seconds: (cycleMs / 1000).toFixed(1) })}</span></>
                    )}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={scanner.disconnect}>
                  {t('scanner.disconnect', 'Disconnect')}
                </Button>
              </div>
            ) : status === 'waiting' || status === 'reconnecting' ? (
              // Linked but the car isn't answering (or the link is being found again): say so, and allow disconnecting.
              <div className="flex justify-center py-2">
                <WaitingNotice status={status} alwaysOn={scanner.alwaysOn} onDisconnect={scanner.disconnect} />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Bluetooth className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <p className="text-sm font-semibold">{t('scanner.notConnectedTitle', 'Connect the adapter')}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('scanner.howTo', 'Plug a Bluetooth LE ELM327 adapter (e.g. Vgate iCar Pro BLE, OBDLink CX, Veepeak BLE+) into the OBD2 port, turn the ignition on, then connect. Classic-Bluetooth and Wi-Fi adapters cannot be used from a browser.')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('scanner.linkHintPaired', 'Bluetooth LE: keep Bluetooth on and select the adapter directly in Xpeed; no pairing in Android settings is needed. In the Android APK, Classic Bluetooth requires pairing in Android settings first, then selection in Xpeed.')}
                </p>
                <Button className="w-full sm:w-auto" onClick={() => void scanner.connect()} disabled={status !== 'idle'}>
                  {status === 'connecting'
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Bluetooth className="mr-2 h-4 w-4" />}
                  {status === 'connecting' ? t('scanner.connecting', 'Connecting…') : t('scanner.connect', 'Connect adapter')}
                </Button>
              </>
            )}
            {scanner.error && <p className="text-xs text-destructive">{scanner.error}</p>}
            {scanner.linkFailed && (
              <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                <li>{t('scanner.linkHintBusy', 'The adapter accepts one connection at a time. Disconnect it from other apps or devices before connecting in Xpeed.')}</li>
                <li>{t('scanner.linkHintPower', 'Make sure the ignition is on and the adapter light is on, then unplug and replug it to wake it up.')}</li>
                <li>{t('scanner.linkHintPaired', 'Bluetooth LE: keep Bluetooth on and select the adapter directly in Xpeed; no pairing in Android settings is needed. In the Android APK, Classic Bluetooth requires pairing in Android settings first, then selection in Xpeed.')}</li>
              </ul>
            )}
          </CardContent>
        </Card>

        {!live ? (
          // Custom PIDs can be set up before connecting.
          customPidsCard
        ) : (
          <>
            {/* Same underline tabs as the Problems page. */}
            <div className="flex gap-1 border-b border-border" role="tablist">
              {tabs.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  onClick={() => setTab(key)}
                  className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                >
                  {label}
                  {key === 'readings' && <span className="ml-1.5 text-xs text-muted-foreground">{channels.length}</span>}
                  {key === 'codes' && allCodes.length > 0 && <span className="ml-1.5 text-xs text-destructive">{allCodes.length}</span>}
                </button>
              ))}
            </div>

            {tab === 'readings' && (
              channels.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('scanner.noPids', "The car didn't report any reading this app understands.")}</p>
              ) : (
                <div className="space-y-3" data-testid="readings-dashboard">
                  {headline.length > 0 && (
                    <Card>
                      <CardContent className="grid grid-cols-3 gap-2 p-3">
                        {headline.map((ch) => {
                          const value = values[ch.header] ?? null;
                          const coolant = ch.def?.pid === 0x05;
                          return (
                            <QuickGauge
                              key={ch.header}
                              value={value}
                              unit={ch.unit}
                              label={channelLabel(ch, t)}
                              min={coolant ? 40 : ch.min}
                              max={coolant ? 120 : ch.def?.pid === 0x0c ? 6000 : ch.max}
                              tone={coolant ? coolantTone(value) : 'primary'}
                            />
                          );
                        })}
                      </CardContent>
                    </Card>
                  )}
                  {others.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {others.map(({ ch, label, value }) => <ReadingTile key={ch.header} label={label} channel={ch} value={value} />)}
                    </div>
                  )}
                </div>
              )
            )}

            {tab === 'codes' && (
              <div className="space-y-4">
                <Card>
                  <CardContent className="space-y-4 p-4">
                    <p className="text-sm text-muted-foreground">{t('scanner.codesHint', "Asks every module in the car which fault codes it has stored. Reading changes nothing in the car. What it finds also goes to Problems in the app.")}</p>
                    <Button className="w-full sm:w-auto" onClick={handleReadDtcs} disabled={busy !== null}>
                      {busy === 'dtc' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
                      {t('scanner.readDtcs', "Read the car's fault codes")}
                    </Button>
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
                        {(dtcs.pending.length > 0 || dtcs.permanent.length > 0) && (
                          <p className="text-xs text-muted-foreground">{t('scanner.codesLegend', 'Pending: the car saw it once and is still confirming. Permanent: only the car itself erases it, after confirming the fault is gone.')}</p>
                        )}
                        <DTCPanel codes={allCodes} />
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{t('scanner.vinTitle', 'Chassis number (VIN)')}</p>
                      {vin !== undefined && (
                        <p className="select-all font-mono text-sm">{vin ?? t('scanner.vinUnavailable', "this car doesn't report it")}</p>
                      )}
                    </div>
                    <Button size="sm" variant="outline" onClick={handleReadVin} disabled={busy !== null}>
                      {busy === 'vin' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="mr-2 h-3.5 w-3.5" />}
                      {t('scanner.readVin', 'Read from the car')}
                    </Button>
                  </CardContent>
                </Card>

                {/* Clearing erases what the mechanic needs, so it sits apart, with a warning. */}
                <Card className="border-destructive/30">
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <p className="text-sm font-semibold text-destructive">{t('scanner.dangerTitle', 'Clear the codes in the car')}</p>
                      <p className="text-xs text-muted-foreground">{t('scanner.dangerBody', "Erases the codes from the car's memory and turns off the check-engine light on the dashboard. It doesn't fix anything: if the fault is still there, the car stores the code again and the light comes back on. That's also how you check whether a problem is really gone.")}</p>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="outline" className="text-destructive" disabled={busy !== null}>
                          {busy === 'clear' ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Eraser className="mr-2 h-3.5 w-3.5" />}
                          {t('scanner.clearDtcs', 'Clear the codes in the car')}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t('scanner.clearTitle', 'Clear the codes in the car?')}</AlertDialogTitle>
                          <AlertDialogDescription asChild>
                            <div className="space-y-2 text-left text-sm text-muted-foreground">
                              {/* Exactly what changes in the car, what doesn't, and what the app does. */}
                              {dtcs ? (
                                clearable.length > 0 && (
                                  <p className="font-medium text-foreground">
                                    {t('scanner.clearList', 'Codes that will be erased in the car: {{codes}}', { codes: clearable.join(', ') })}
                                  </p>
                                )
                              ) : (
                                <p className="font-medium text-foreground">{t('scanner.clearReadFirst', "Read the car's codes first to see what will be erased.")}</p>
                              )}
                              {dtcs && dtcs.permanent.length > 0 && (
                                <p>{t('scanner.clearPermanent', 'Permanent codes ({{codes}}) are not erased: the car erases them itself once it confirms the fault is gone.', { codes: dtcs.permanent.join(', ') })}</p>
                              )}
                              <ul className="list-disc space-y-1.5 pl-4">
                                <li>{t('scanner.clearInCar', 'In the car: the fault codes, the check-engine light, the snapshot of when the fault happened (freeze frame) and the readiness tests are erased.')}</li>
                                <li>{t('scanner.clearNotFixed', 'Nothing is repaired: if the fault is still there, the car stores the code and turns the light on again when it tests that system — this can take a few days of driving.')}</li>
                                <li>{t('scanner.clearInspection', 'Until the car finishes its tests, it can fail a vehicle inspection.')}</li>
                                <li>{t('scanner.clearInApp', 'In the app: these problems are marked as solved; if a code comes back, the problem reappears as "came back".')}</li>
                              </ul>
                              <p>{t('scanner.clearHow', 'Do it with the engine off and the ignition on.')}</p>
                            </div>
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t('common.cancel', 'Cancel')}</AlertDialogCancel>
                          <AlertDialogAction onClick={handleClearDtcs}>{t('scanner.clearConfirm', 'Clear in the car')}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </CardContent>
                </Card>
              </div>
            )}

            {tab === 'tools' && (
              <div className="space-y-4">
                {customPidsCard}
                <TerminalCard onSend={scanner.sendRaw} />
                {connection?.isCan && <EcuScanCard findEcus={scanner.findEcus} sweepMode21={scanner.sweepMode21} />}
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
