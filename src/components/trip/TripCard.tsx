import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2, Bluetooth, BluetoothOff, Moon, CheckCircle2, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useObd, useObdLive } from '@/contexts/ObdScannerContext';
import { useSettings } from '@/contexts/SettingsContext';
import { QuickGauge, coolantTone } from '@/components/trip/QuickGauge';
import { AndroidAppDownload, IphoneNoBluetooth } from '@/components/InstallApp';
import { installKind } from '@/lib/device';

const SPEED = 'Vehicle speed (km/h)';
const RPM = 'Engine RPM (rpm)';
const COOLANT = 'Engine coolant temperature (°C)';

function elapsed(from: Date, now: number) {
  const s = Math.max(0, Math.floor((now - from.getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * The one control a driver needs: start a trip (connecting the adapter on the
 * way), see that it's recording, stop it. Everything else is automatic.
 */
export function TripCard() {
  const { t } = useTranslation();
  const obd = useObd();
  const { status, recording, alwaysOn, setAlwaysOn, canStayOn, savingTrip, lastTrip, linkFailed, error } = obd;
  const { values } = useObdLive();
  const { distanceUnit } = useSettings();
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!recording?.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording?.active]);

  const speed = values[SPEED] ?? null;
  const rpm = values[RPM] ?? null;
  const coolant = values[COOLANT] ?? null;
  const tempTone = coolantTone(coolant);
  const tempWord = {
    primary: null,
    cold: t('trip.gauge.warming', 'warming up'),
    success: t('trip.gauge.normal', 'normal'),
    warn: t('trip.gauge.hot', 'hot'),
    danger: t('trip.gauge.tooHot', 'too hot'),
  }[tempTone];
  // The car reports km/h; show the unit chosen in Settings.
  const miles = distanceUnit === 'mi';
  const speedShown = speed != null && miles ? speed * 0.621371 : speed;
  const speedUnit = miles ? 'mph' : 'km/h';
  // Moving with the engine stopped: a hybrid on electric power.
  const electric = speed != null && speed >= 3 && rpm === 0;

  const readings = status === 'live' && (
    <div className="grid grid-cols-3 gap-2">
      <Link to={`/live?sensor=${encodeURIComponent(SPEED)}`} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <QuickGauge value={speedShown} unit={speedUnit} label={speedUnit} max={miles ? 100 : 160} />
      </Link>
      <Link to={`/live?sensor=${encodeURIComponent(RPM)}`} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <QuickGauge
        value={rpm}
        unit="rpm"
        label={t('trip.rpm', 'engine rpm')}
        max={6000}
        tone={electric ? 'success' : rpm != null && rpm > 4500 ? 'warn' : 'primary'}
        status={electric ? t('trip.gauge.electric', 'electric') : null}
      />
      </Link>
      <QuickGauge value={coolant} unit="°C" label={t('trip.engineTemp', 'engine °C')} min={40} max={120} tone={tempTone} status={tempWord} />
    </div>
  );

  let body: JSX.Element;
  if (status === 'unsupported') {
    // No Bluetooth here: on iPhone say so plainly; on Android offer the app, which always has it.
    const kind = installKind();
    body = kind === 'ios' ? (
      <IphoneNoBluetooth />
    ) : (
      <div className="space-y-3">
        <div className="flex gap-3 items-start">
          <AlertCircle className="w-5 h-5 text-warn shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            {kind === 'android'
              ? t('trip.unsupportedAndroid', "This browser can't connect to the car. Get the Android app:")
              : t('trip.unsupported', "This browser can't connect to the car. Open Xpeed in Chrome on Android or on a computer.")}
          </p>
        </div>
        {kind === 'android' && <AndroidAppDownload />}
      </div>
    );
  } else if (recording?.active) {
    body = (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
          <p className="font-semibold">{t('trip.recording', 'Recording your trip')}</p>
          <span className="ml-auto rounded-full bg-destructive/10 px-2.5 py-0.5 font-mono text-sm tabular-nums text-destructive">{elapsed(recording.startedAt, now)}</span>
        </div>
        {readings || (
          <p className="text-sm text-muted-foreground">{t('trip.paused', 'Waiting for the car… the trip continues when it answers again.')}</p>
        )}
        <Button size="lg" variant="secondary" className="w-full" asChild>
          <Link to="/live">{t('trip.openLive', 'View all live sensors')}</Link>
        </Button>
        <Button size="lg" variant="outline" className="w-full" onClick={obd.stopTrip}>
          <Square className="w-4 h-4 mr-2" />
          {t('trip.stop', 'End trip')}
        </Button>
      </div>
    );
  } else if (status === 'connecting' || status === 'reconnecting') {
    body = (
      <div className="flex items-center gap-3">
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
        <div>
          <p className="font-semibold">{status === 'connecting' ? t('trip.connecting', 'Connecting to the adapter…') : t('trip.reconnecting', 'Looking for the adapter…')}</p>
          {status === 'reconnecting' && (
            <p className="text-sm text-muted-foreground">{t('trip.reconnectingHint', "It reconnects by itself when the car is switched on.")}</p>
          )}
        </div>
      </div>
    );
  } else if (status === 'waiting') {
    body = (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Moon className="w-5 h-5 text-muted-foreground" />
          <div>
            <p className="font-semibold">{t('trip.waiting', 'Adapter connected — waiting for the car')}</p>
            <p className="text-sm text-muted-foreground">
              {alwaysOn
                ? t('trip.waitingAuto', 'Turn the car on. The trip starts recording by itself when you drive off.')
                : t('trip.waitingManual', 'Turn the car on to start recording.')}
            </p>
          </div>
        </div>
      </div>
    );
  } else if (status === 'live') {
    body = (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-success" />
          <p className="font-semibold">{t('trip.carOn', 'Car connected')}</p>
        </div>
        {readings}
        {alwaysOn && (
          <p className="text-sm text-muted-foreground">
            {obd.autoPaused
              ? t('trip.autoPausedHint', 'Recording is paused until you switch the car off.')
              : t('trip.autoHint', 'Recording starts by itself when you drive off.')}
          </p>
        )}
        <Button size="lg" className="h-14 w-full text-base shadow-[0_8px_30px_-10px_hsl(var(--primary)/0.6)]" onClick={() => void obd.startTrip()}>
          <Play className="mr-2 h-5 w-5" />
          {t('trip.start', 'Start trip')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        {/* Not linked: connect first; "Start trip" shows once the adapter answers. */}
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-background/40 p-3" data-testid="not-connected">
          <BluetoothOff className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-semibold">{t('trip.notConnected', 'Adapter not connected')}</p>
            <p className="text-sm text-muted-foreground">
              {t('trip.notConnectedHint', 'Plug the adapter in under the steering wheel, turn the car on and connect. Then you can start your trip.')}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('scanner.linkHintPaired', 'Bluetooth LE: keep Bluetooth on and select the adapter directly in Xpeed; no pairing in Android settings is needed. In the Android APK, Classic Bluetooth requires pairing in Android settings first, then selection in Xpeed.')}
        </p>
        <Button size="lg" className="h-14 w-full text-base" onClick={() => void obd.connect()}>
          <Bluetooth className="mr-2 h-5 w-5" />
          {t('trip.connect', 'Connect to the car')}
        </Button>
        {error && (
          <div className="space-y-1 text-sm text-destructive" role="alert">
            <p>
              {linkFailed
                ? t('trip.linkFailed', 'The adapter did not answer. Disconnect it from other apps or devices, keep Bluetooth on, and try again in Xpeed.')
                : t('trip.connectFailed', 'Could not connect. Check that the adapter is plugged in and try again.')}
            </p>
            <p className="text-xs break-words">{error}</p>
          </div>
        )}
        <button type="button" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground" onClick={() => setHelp((h) => !h)}>
          {help ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {t('trip.howTo', 'How does it work?')}
        </button>
        {help && (
          <ol className="text-sm text-muted-foreground list-decimal pl-5 space-y-1">
            <li>{t('trip.step1', 'Plug the Bluetooth adapter into the port under the steering wheel.')}</li>
            <li>{t('trip.step2', 'Turn the car on.')}</li>
            <li>{t('trip.step3connect', 'Tap "Connect to the car" and pick the adapter in the list (only the first time).')}</li>
            <li className="list-none -ml-5 pt-1">
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => void obd.connect({ showAll: true })}>
                {t('trip.showAll', "Adapter not in the list? Show all Bluetooth devices")}
              </button>
            </li>
          </ol>
        )}
      </div>
    );
  }

  const connected = status === 'live' || status === 'waiting' || status === 'reconnecting';

  return (
    <Card className={recording?.active ? 'border-destructive/30' : undefined}>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
            <Bluetooth className="h-3.5 w-3.5 text-primary" />
          </span>
          <h3 className="text-sm font-semibold">{t('trip.title', 'Your car')}</h3>
          {connected && !recording?.active && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={obd.disconnect}>
              {t('trip.disconnect', 'Disconnect')}
            </Button>
          )}
        </div>

        {body}

        {savingTrip && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('trip.saving', 'Saving your last trip…')}
          </p>
        )}
        {!savingTrip && lastTrip && (
          <p className="text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-success" />
            {t('trip.lastSaved', 'Last trip saved.')}
            <Link to={`/session/${lastTrip.sessionId}`} className="text-primary hover:underline">{t('trip.view', 'View')}</Link>
          </p>
        )}

        {status !== 'unsupported' && canStayOn && (
          <label className="flex cursor-pointer items-start gap-3 border-t border-border/60 pt-4">
            <Switch checked={alwaysOn} onCheckedChange={setAlwaysOn} aria-label={t('trip.alwaysOn', 'Record trips automatically')} />
            <span className="text-xs">
              <span className="font-medium block">{t('trip.alwaysOn', 'Record trips automatically')}</span>
              <span className="text-muted-foreground">
                {t('trip.alwaysOnHint', 'Keep the app open in the car: it reconnects by itself, records every trip and rests while the car is off.')}
              </span>
            </span>
          </label>
        )}
      </CardContent>
    </Card>
  );
}
