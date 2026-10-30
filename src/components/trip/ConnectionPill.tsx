import { Link } from 'react-router-dom';
import { Bluetooth, BluetoothOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useObd } from '@/contexts/ObdScannerContext';
import { HeaderControl } from '@/components/header/HeaderControl';

/** One entry point for connecting the adapter and viewing the connected car. */
export function ConnectionPill() {
  const { t } = useTranslation();
  const { status, recording, linkOpen, connection, connect } = useObd();
  if (status === 'unsupported') return null;

  const canConnect = status === 'idle' && !recording?.active && !linkOpen && !connection;
  const Icon = canConnect ? BluetoothOff : Bluetooth;
  const [color, label] = recording?.active
    ? ['text-destructive', t('pill.recording', 'Recording trip')]
    : status === 'live'
      ? ['text-success', t('pill.live', 'Car connected')]
      : status === 'waiting'
        ? ['text-muted-foreground', t('pill.waiting', 'Waiting for the car')]
        : status === 'connecting' || status === 'reconnecting'
          ? ['text-warn motion-safe:animate-pulse', t('pill.connecting', 'Connecting…')]
          : ['text-muted-foreground', t('pill.idle', 'Car not connected')];

  return (
    <HeaderControl asChild className="w-auto min-w-0 shrink gap-1.5 px-3 text-[11px] font-medium text-foreground min-[380px]:text-xs">
      <Link to="/live" title={label} data-testid="connection-pill" onClick={event => {
        if (!canConnect || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        // Open the chooser in this user gesture, before the Link changes route.
        void connect();
      }}>
        <Icon className={`shrink-0 ${color}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </Link>
    </HeaderControl>
  );
}
