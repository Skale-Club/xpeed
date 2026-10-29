import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bluetooth, BluetoothOff, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useObd } from '@/contexts/ObdScannerContext';
import { rememberedAdapterName } from '@/lib/obd/elm327';
import { Button } from '@/components/ui/button';
import { HeaderPanel } from '@/components/HeaderPanel';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export function BluetoothConnectionMenu() {
  const { t } = useTranslation();
  const obd = useObd();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (obd.status === 'unsupported') return null;
  const connected = obd.linkOpen || !!obd.connection;
  const canDisconnect = connected || ['connecting', 'reconnecting', 'waiting'].includes(obd.status);
  const name = obd.connection?.deviceName || rememberedAdapterName() || t('live.adapter', 'OBD2 adapter');
  const transport = obd.connection?.transport === 'classic' ? 'Bluetooth Classic (SPP)' : obd.connection?.transport === 'ble' ? 'Bluetooth LE (BLE)' : 'Bluetooth';
  return <>
    <HeaderPanel open={open} onOpenChange={setOpen} title={t('bluetooth.title', 'Bluetooth connection')}
      description={connected ? name : t('pill.idle', 'Car not connected')}
      trigger={<Button variant="ghost" size="icon" className="relative shrink-0" aria-label={t('bluetooth.title', 'Bluetooth connection')} title={t('bluetooth.title', 'Bluetooth connection')}>
        <Bluetooth className={`h-5 w-5 ${connected ? 'text-primary' : 'text-muted-foreground'}`} />
        {connected && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />}
      </Button>}>
      <div className="space-y-3">
        {connected && <p className="text-sm text-muted-foreground">{transport}</p>}
        {canDisconnect ? <Button variant="outline" className="w-full" onClick={() => { setOpen(false); setConfirm(true); }}>
          <BluetoothOff className="mr-2 h-4 w-4" />{t('bluetooth.disconnect', 'Disconnect Bluetooth')}
        </Button> : <p className="text-sm text-muted-foreground">{t('bluetooth.disconnected', 'No adapter connected. Connect from the trip card on Home.')}</p>}
        <Link to={canDisconnect ? '/live' : '/'} onClick={() => setOpen(false)} className="flex min-h-10 items-center justify-between text-sm text-primary">
          {canDisconnect ? t('trip.openLive', 'View Dashboard') : t('nav.dashboard', 'Home')}<ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    </HeaderPanel>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={t('live.disconnectTitle', 'Disconnect the adapter?')}
      description={obd.recording?.active ? t('bluetooth.endTrip', 'This disconnects the adapter and ends the current recording. The trip will be kept for saving.') : t('bluetooth.stayOff', 'This closes the connection to the adapter.')}
      confirmLabel={t('bluetooth.disconnect', 'Disconnect Bluetooth')} onConfirm={obd.disconnect} />
  </>;
}
