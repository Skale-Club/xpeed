import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useObd } from '@/contexts/ObdScannerContext';

/** Always-visible car connection status in the top bar; tapping opens the live view. */
export function ConnectionPill() {
  const { t } = useTranslation();
  const { status, recording } = useObd();
  if (status === 'unsupported') return null;

  const [dot, label] = recording?.active
    ? ['bg-destructive', t('pill.recording', 'Recording trip')]
    : status === 'live'
      ? ['bg-success', t('pill.live', 'Car connected')]
      : status === 'waiting'
        ? ['bg-muted-foreground', t('pill.waiting', 'Waiting for the car')]
        : status === 'connecting' || status === 'reconnecting'
          ? ['bg-warn animate-pulse', t('pill.connecting', 'Connecting…')]
          : ['bg-muted-foreground/40', t('pill.idle', 'Car not connected')];

  return (
    <Link
      to={status === 'idle' ? '/' : '/live'}
      className="ml-auto inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs hover:bg-accent"
      data-testid="connection-pill"
    >
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </Link>
  );
}
