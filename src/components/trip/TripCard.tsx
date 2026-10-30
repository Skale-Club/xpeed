import { temperatureValue, temperatureLabel } from '@/lib/temperature';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play, Square, Circle, BluetoothOff, Moon, CheckCircle2, AlertCircle } from 'lucide-react';
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

/** Recording controls only. Bluetooth setup and recovery details live in the live panel. */
export function TripCard() {
  const { t } = useTranslation();
  const obd = useObd();
  const { status, recording, alwaysOn, setAlwaysOn, canStayOn, tripSave } = obd;
  const { values } = useObdLive();
  const { distanceUnit, temperatureUnit } = useSettings();
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
      <div>
        <QuickGauge value={speedShown} unit={speedUnit} label={speedUnit} max={miles ? 100 : 160} />
      </div>
      <QuickGauge
        value={rpm}
        unit="rpm"
        label={t('trip.rpm', 'engine rpm')}
        max={6000}
        tone={electric ? 'success' : rpm != null && rpm > 4500 ? 'warn' : 'primary'}
        status={electric ? t('trip.gauge.electric', 'electric') : null}
      />
      <QuickGauge value={coolant == null ? null : temperatureValue(coolant, '°C', temperatureUnit)} unit={temperatureLabel('°C', temperatureUnit)} label={t('trip.engineTemp', 'engine °C').replace('°C', temperatureLabel('°C', temperatureUnit))} min={temperatureValue(40, '°C', temperatureUnit)} max={temperatureValue(120, '°C', temperatureUnit)} tone={tempTone} status={tempWord} />
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
        <p className="text-xs text-muted-foreground">
          {!alwaysOn && !recording.manual
            ? t('trip.autoOffDuringTrip', 'Auto recording is off for future trips. Use End trip to finish this recording.')
            : recording.manual
            ? t('trip.recordingManualHint', 'Tap End trip to finish. Switching the car off also ends the recording.')
            : t('trip.recordingAutoHint', 'Ends automatically when the car is off or parked for 10 minutes.')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" className="h-11 min-w-0 px-2 text-xs sm:text-sm" asChild>
            <Link to="/live">{t('trip.openLive', 'View Dashboard')}</Link>
          </Button>
          <Button variant="destructive" className="h-11 min-w-0 px-2 text-xs sm:text-sm" onClick={obd.stopTrip}>
            <Square className="mr-1.5 h-4 w-4 shrink-0" />
            {t('trip.stop', 'End trip')}
          </Button>
        </div>
      </div>
    );
  } else if (status === 'waiting') {
    body = (
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Moon className="w-5 h-5 text-muted-foreground" />
          <div>
            <p className="font-semibold">{t('trip.standby', 'Recording on standby')}</p>
            <p className="text-sm text-muted-foreground">
              {alwaysOn
                ? t('trip.standbyAuto', 'Starts when you drive. Ends when the car is off or parked for a while.')
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
          <p className="font-semibold">{t('trip.ready', 'Ready to record')}</p>
        </div>
        {readings}
        {alwaysOn && (
          <p className="text-sm text-muted-foreground">
            {obd.autoPaused
              ? t('trip.autoPausedHint', 'Recording is paused until you switch the car off.')
              : t('trip.standbyAuto', 'Starts when you drive. Ends when the car is off or parked for a while.')}
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
            <p className="font-semibold">{t('trip.connectionRequired', 'Connect your adapter to record')}</p>
            <p className="text-sm text-muted-foreground">
              {t('trip.connectionRequiredHint', 'Recording needs Bluetooth and an OBD2 adapter. Manage the connection in the live panel.')}
            </p>
          </div>
        </div>
        <Button variant="secondary" className="h-11 w-full" asChild>
          <Link to="/live">{t('trip.connectionSettings', 'Set up connection')}</Link>
        </Button>
      </div>
    );
  }


  return (
    <Card className={recording?.active ? 'border-destructive/30' : undefined}>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10">
            <Circle className="h-3.5 w-3.5 text-primary" />
          </span>
          <h3 className="text-sm font-semibold">{t('trip.cardTitle', 'Trip recording')}</h3>
          {status !== 'unsupported' && canStayOn && (
            <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" title={t('trip.alwaysOnHint')}>
              <span>{t('trip.autoShort', 'Auto Recording')}</span>
              <Switch checked={alwaysOn} onCheckedChange={setAlwaysOn} aria-label={t('trip.alwaysOn', 'Record trips automatically')} />
            </label>
          )}

        </div>

        {body}

        {!recording?.active && tripSave && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground" role="status">
            {tripSave.status === 'saved' && <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />}
            {tripSave.status === 'saved' ? <>
              {t('trip.lastSaved', 'Last trip saved.')}
              <Link to={`/session/${tripSave.sessionId}`} className="text-primary hover:underline">{t('trip.view', 'View')}</Link>
            </> : tripSave.status === 'keeping'
              ? t('trip.keeping', 'Keeping your trip on this device…')
              : tripSave.status === 'memory'
                ? t('trip.saveFailedNoCopy', "It couldn't be kept on this device either, so leave the app open: it keeps trying while it's open.")
              : <>
                {t('trip.uploadPending', 'Trip kept on this device. Upload pending.')}
                <Link to="/settings" className="shrink-0 text-primary hover:underline">{t('trip.syncDetails', 'Sync details')}</Link>
              </>}
          </p>
        )}

      </CardContent>
    </Card>
  );
}
