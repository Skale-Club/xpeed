import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon, Loader2, Trash2, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import {
  uploadSessionPhoto, listSessionPhotos, getPhotoUrl, deleteSessionPhoto,
  type SessionPhoto, type PhotoType,
} from '@/lib/db-extras';
import { useToast } from '@/hooks/use-toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface PhotoUploadProps {
  sessionId: string;
}

// English defaults; translations live under photos.types.<type>.
const TYPE_LABELS: Record<PhotoType, string> = {
  dashboard: 'Dashboard / warning lights',
  scanner: 'Scanner screen',
  engine_bay: 'Under the hood',
  other: 'Other',
};

export default function PhotoUpload({ sessionId }: PhotoUploadProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [photoType, setPhotoType] = useState<PhotoType>('dashboard');
  const [caption, setCaption] = useState('');
  const [deleting, setDeleting] = useState<SessionPhoto | null>(null);
  const { toast } = useToast();
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadFailed(false);
    setUploading(false);
    setDeleting(null);
    setPhotos([]);
    setPhotoUrls({});
    void (async () => {
    try {
      const data = await listSessionPhotos(sessionId);
      if (!cancelled) {
        setPhotos(data);
      }
    } catch (err) {
      console.error('Failed to load photos:', err);
      if (!cancelled) setLoadFailed(true);
    } finally {
      if (!cancelled) setLoaded(true);
    }
    })();
    return () => { cancelled = true; };
  }, [sessionId, retry]);

  // Signed URLs expire after an hour. Renew before expiry, and on returning to
  // a tab whose background timers may have been suspended by the browser.
  useEffect(() => {
    if (!photos.length) return;
    let cancelled = false;
    let lastRefresh = 0;
    const refresh = async () => {
      const entries = await Promise.all(photos.map(async photo => [photo.id, await getPhotoUrl(photo.storage_path)] as const));
      if (!cancelled) {
        setPhotoUrls(Object.fromEntries(entries.filter(([, url]) => url) as [string, string][]));
        lastRefresh = Date.now();
      }
    };
    const tryRefresh = () => { void refresh().catch(error => console.warn('Photo URL refresh failed:', error)); };
    const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - lastRefresh >= 50 * 60_000) tryRefresh(); };
    tryRefresh();
    const timer = setInterval(tryRefresh, 50 * 60_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [photos, sessionId]);

  const handleFile = useCallback(async (file: File) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast({
        title: t('photos.invalidTitle', "That's not a photo"),
        description: t('photos.invalidBody', 'Please choose an image (JPG, PNG or WebP).'),
        variant: 'warning',
      });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: t('photos.tooLargeTitle', 'Photo too large'),
        description: t('photos.tooLargeBody', 'Photos can be up to 10 MB.'),
        variant: 'warning',
      });
      return;
    }
    setUploading(true);
    try {
      const photo = await uploadSessionPhoto(file, sessionId, photoType, caption.trim() || undefined);
      if (currentSession.current !== sessionId) return;
      setPhotos(prev => [...prev, photo]);
      setCaption('');
      toast({ title: t('photos.uploaded', 'Photo added'), variant: 'success' });
    } catch (err) {
      console.error('Photo upload failed:', err);
      if (currentSession.current !== sessionId) return;
      toast({
        title: t('photos.uploadFailed', "Couldn't add the photo"),
        description: t('photos.tryAgain', 'Please check your connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      if (currentSession.current === sessionId) setUploading(false);
    }
  }, [sessionId, photoType, caption, t, toast]);

  const handleDelete = useCallback(async (photo: SessionPhoto) => {
    try {
      await deleteSessionPhoto(photo);
      setPhotos(prev => prev.filter(p => p.id !== photo.id));
    } catch (err) {
      console.error('Photo delete failed:', err);
      toast({ title: t('photos.deleteFailed', "Couldn't delete the photo"), variant: 'destructive' });
    }
  }, [t, toast]);

  return (
    <Card className="border-border bg-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{t('photos.title', 'Photos')}</h3>
        </div>

        <div className="grid grid-cols-[1fr_2fr_auto] gap-2 items-end">
          <div>
            <Select value={photoType} onValueChange={(v) => setPhotoType(v as PhotoType)}>
              <SelectTrigger className="h-8 text-xs" aria-label={t('photos.typeLabel', 'What the photo shows')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABELS) as PhotoType[]).map(type => (
                  <SelectItem key={type} value={type}>{t(`photos.types.${type}`, TYPE_LABELS[type])}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder={t('photos.captionPlaceholder', 'Short description (optional)')}
            value={caption}
            onChange={e => setCaption(e.target.value)}
            className="h-8 text-xs"
          />
          <Button size="sm" disabled={uploading || !loaded || loadFailed} onClick={() => inputRef.current?.click()}>
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : t('photos.add', 'Add photo')}
          </Button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />

        {loadFailed ? (
          <div role="alert" className="text-sm space-y-2">
            <p>{t('photos.loadFailed', "Couldn't load these photos. Check your connection and try again.")}</p>
            <Button variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>{t('problems.retry', 'Try again')}</Button>
          </div>
        ) : photos.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            {t('photos.empty', 'Keep photos of warning lights, scanner readings or other details with this trip.')}
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {photos.map(p => (
              <div key={p.id} className="relative group rounded border border-border overflow-hidden">
                {photoUrls[p.id] && (
                  <img src={photoUrls[p.id]} alt={p.caption || ''} className="w-full h-28 object-cover" />
                )}
                {/* Always visible on touch screens; on a mouse it appears on hover or focus. */}
                <button
                  type="button"
                  onClick={() => setDeleting(p)}
                  className="absolute top-1 right-1 flex h-10 w-10 items-center justify-center rounded-lg bg-background/80 transition-opacity focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                  title={t('photos.delete', 'Delete photo')}
                  aria-label={t('photos.delete', 'Delete photo')}
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </button>
                {p.caption && (
                  <div className="absolute bottom-0 inset-x-0 bg-background/70 backdrop-blur-sm px-1.5 py-0.5 text-[10px] text-foreground truncate">
                    {p.caption}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={t('photos.deleteTitle', 'Delete this photo?')}
        description={t('photos.deleteBody', "It will be removed from this trip and can't be brought back.")}
        confirmLabel={t('photos.delete', 'Delete photo')}
        onConfirm={() => { if (deleting) void handleDelete(deleting); setDeleting(null); }}
      />
    </Card>
  );
}
