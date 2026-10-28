import { useCallback, useRef, useState } from 'react';
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
  const [uploading, setUploading] = useState(false);
  const [photoType, setPhotoType] = useState<PhotoType>('dashboard');
  const [caption, setCaption] = useState('');
  const { toast } = useToast();

  const loadPhotos = useCallback(async () => {
    try {
      const data = await listSessionPhotos(sessionId);
      setPhotos(data);
      // Resolve short-lived signed URLs for the private bucket (S08-1).
      const entries = await Promise.all(
        data.map(async (p) => [p.id, await getPhotoUrl(p.storage_path)] as const),
      );
      setPhotoUrls(Object.fromEntries(entries.filter(([, url]) => url) as [string, string][]));
    } catch (err) {
      console.error('Failed to load photos:', err);
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  // Lazy load on first render
  if (!loaded && !uploading) {
    void loadPhotos();
  }

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast({
        title: t('photos.invalidTitle', "That's not a photo"),
        description: t('photos.invalidBody', 'Please choose an image (JPG, PNG or WebP).'),
        variant: 'destructive',
      });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: t('photos.tooLargeTitle', 'Photo too large'),
        description: t('photos.tooLargeBody', 'Photos can be up to 10 MB.'),
        variant: 'destructive',
      });
      return;
    }
    setUploading(true);
    try {
      const photo = await uploadSessionPhoto(file, sessionId, photoType, caption.trim() || undefined);
      setPhotos(prev => [...prev, photo]);
      setCaption('');
      toast({ title: t('photos.uploaded', 'Photo added') });
    } catch (err) {
      console.error('Photo upload failed:', err);
      toast({
        title: t('photos.uploadFailed', "Couldn't add the photo"),
        description: t('photos.tryAgain', 'Please check your connection and try again.'),
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
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
          <h3 className="text-sm font-mono font-semibold text-foreground">{t('photos.title', 'Photos')}</h3>
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
          <Button size="sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : t('photos.add', 'Add photo')}
          </Button>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />

        {photos.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            {t('photos.empty', 'Add a photo of a warning light, the scanner screen or anything else you can see. The assistant will look at it too.')}
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {photos.map(p => (
              <div key={p.id} className="relative group rounded border border-border overflow-hidden">
                {photoUrls[p.id] && (
                  <img src={photoUrls[p.id]} alt={p.caption || ''} className="w-full h-28 object-cover" />
                )}
                <button
                  type="button"
                  onClick={() => handleDelete(p)}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-background/80 rounded p-1"
                  title={t('photos.delete', 'Delete photo')}
                  aria-label={t('photos.delete', 'Delete photo')}
                >
                  <Trash2 className="w-3 h-3 text-destructive" />
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
    </Card>
  );
}
