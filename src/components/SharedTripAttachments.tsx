import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSharedMedia } from '@/lib/db-extras';
import type { SharedTripMedia } from '@/lib/trip-media';
import { Button } from './ui/button';

export function SharedTripAttachments({ reportId }: { reportId: string }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<SharedTripMedia[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    setItems([]); setFailed(false);
    const refresh = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const next = await getSharedMedia(reportId);
        if (!cancelled) { setItems(next); setFailed(false); }
      } catch { if (!cancelled) { setItems([]); setFailed(true); } }
      finally { pending = false; }
    };
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    const online = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 240_000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', online);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', online);
    };
  }, [reportId, retry]);
  if (failed) return <section className="mb-4 space-y-2" role="alert"><p className="text-sm text-muted-foreground">{t('photos.sharedFailed', 'Could not load shared attachments. The diagnostic report is still available.')}</p><Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>{t('common.retry', 'Try again')}</Button></section>;
  if (!items.length) return null;
  return <section className="mb-4 space-y-3"><h2 className="text-sm font-semibold">{t('photos.title', 'Trip records')}</h2>
    <div className="grid gap-3 sm:grid-cols-2">{items.map((item) => <figure key={item.id} className="min-w-0 overflow-hidden rounded-xl border border-border">
      {item.video ? <video controls preload="metadata" src={item.url} onError={() => setFailed(true)} className="max-h-80 w-full bg-black" aria-label={item.caption || t('photos.video', 'Trip video')} /> : <a href={item.url} target="_blank" rel="noopener noreferrer"><img src={item.url} onError={() => setFailed(true)} alt={item.caption || ''} loading="lazy" className="max-h-80 w-full object-contain" /></a>}
      {item.caption && <figcaption className="whitespace-pre-wrap break-words p-3 text-sm">{item.caption}</figcaption>}
    </figure>)}</div>
  </section>;
}
