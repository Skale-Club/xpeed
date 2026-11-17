import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readLocalTrack, type LocalTrackIdentity } from '@/lib/sim/local-track';
import { TrackFormatError, type TrackFile } from '@/lib/sim/track-file';

/** Local bytes stay in memory: this chooser has no account, storage or upload dependency. */
export function LocalTrackLayout({ wanted, onLayout, selected = false }: { wanted: LocalTrackIdentity; onLayout: (layout: TrackFile | null) => void; selected?: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const request = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { request.current++; }, []);
  return <div className="mt-2 space-y-1 text-xs">
    <label htmlFor={id} className="block font-medium">{t('modes.compare.localTrack.open')}</label>
    <input id={id} type="file" accept=".xtrk,.gz,application/gzip" aria-describedby={`${id}-hint`} className="block max-w-full" onChange={async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const token = ++request.current;
      setBusy(true); setError(null);
      try {
        const layout = await readLocalTrack(file, wanted);
        if (token === request.current) onLayout(layout);
      } catch (cause) {
        if (token === request.current) setError(cause instanceof Error && cause.message === 'alignment_mismatch' ? 'alignment' : cause instanceof Error && cause.message === 'identity_mismatch' ? 'identity' : cause instanceof TrackFormatError && cause.code === 'too_large' ? 'size' : 'invalid');
      } finally { if (token === request.current) setBusy(false); }
    }} />
    <p id={`${id}-hint`} className="text-muted-foreground">{t('modes.compare.localTrack.private')}</p>
    {selected && <button type="button" className="underline" onClick={() => { request.current++; setBusy(false); setError(null); onLayout(null); }}>{t('modes.compare.localTrack.clear')}</button>}
    {busy && <p role="status">{t('modes.compare.localTrack.loading')}</p>}
    {error && <p role="alert" className="text-destructive">{t(`modes.compare.localTrack.${error}`)}</p>}
  </div>;
}
