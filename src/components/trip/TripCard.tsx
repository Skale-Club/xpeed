import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2, Bluetooth, Moon, CheckCircle2, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useObd } from '@/contexts/ObdScannerContext';
import { formatValue } from '@/lib/obd/format';

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
  const { status, recording, values, alwaysOn, setAlwaysOn, savingTrip, lastTrip, linkFailed, error } = obd;
  const [help, setHelp] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!recording?.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [recording?.active]);

  const quick = (header: string, label: string, unit: string) => (
    <div className="text-center">
      <p className="font-mono text-2xl font-bold tabular-nums">{formatValue(values[header], unit)}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );

  const readings = status === 'live' && (
    <div className="grid grid-cols-3 gap-2 py-2">
      {quick(SPEED, 'km/h', 'km/h')}
      {quick(RPM, t('trip.rpm', 'engine rpm'), 'rpm')}
      {quick(COOLANT, t('trip.engineTemp', 'engine °C'), '°C')}
    </div>
  );

  let body: JSX.Element;
  if (status === 'unsupported') {
    body = (
      <div className="flex gap-3 items-start">
        <AlertCircle className="w-5 h-5 text-warn shrink-0 mt-0.5" />
        <p className="text-sm text-muted-foreground">
          {t('trip.unsupported', "This browser can't connect to the car. Open Xpeed in Chrome on Android or on a computer.")}
        </p>
      </div>
    );
  } else if (recording?.active) {
    body = (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-destructive animate-pulse" />
          <p className="font-semibold">{t('trip.recording', 'Recording your trip')}</p>
          <span className="ml-auto font-mono tabular-nums">{elapsed(recording.startedAt, now)}</span>
        </div>
        {readings || (
          <p className="text-sm text-muted-foreground">{t('trip.paused', 'Waiting for the car… the trip continues when it answers again.')}</p>
        )}
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
        {alwaysOn && <p className="text-sm text-muted-foreground">{t('trip.autoHint', 'Recording starts by itself when you drive off.')}</p>}
        <Button size="lg" className="w-full" onClick={() => void obd.startTrip()}>
          <Play className="w-4 h-4 mr-2" />
          {t('trip.startNow', 'Record now')}
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <Button size="lg" className="w-full h-14 text-base" onClick={() => void obd.startTrip()}>
          <Play className="w-5 h-5 mr-2" />
          {t('trip.start', 'Start trip')}
        </Button>
        {error && (
          <p className="text-sm text-destructive">
            {linkFailed
              ? t('trip.linkFailed', "The adapter didn't answer. Close other apps that use it (like Car Scanner) or turn off your phone's Bluetooth, then try again.")
              : t('trip.connectFailed', 'Could not connect. Check that the adapter is plugged in and try again.')}
          </p>
        )}
        <button type="button" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:text-foreground" onClick={() => setHelp((h) => !h)}>
          {help ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {t('trip.howTo', 'How does it work?')}
        </button>
        {help && (
          <ol className="text-sm text-muted-foreground list-decimal pl-5 space-y-1">
            <li>{t('trip.step1', 'Plug the Bluetooth adapter into the port under the steering wheel.')}</li>
            <li>{t('trip.step2', 'Turn the car on.')}</li>
            <li>{t('trip.step3', 'Tap "Start trip" and pick the adapter in the list (only the first time).')}</li>
            <li className="list-none -ml-5 pt-1">
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => void obd.startTrip({ showAll: true })}>
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
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Bluetooth className="w-4 h-4 text-primary" />
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

        {status !== 'unsupported' && (
          <label className="flex items-start gap-3 border-t border-border pt-3 cursor-pointer">
            <Switch checked={alwaysOn} onCheckedChange={setAlwaysOn} aria-label={t('trip.alwaysOn', 'Always on')} />
            <span className="text-xs">
              <span className="font-medium block">{t('trip.alwaysOn', 'Always on')}</span>
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
