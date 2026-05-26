import { useRef, useState } from 'react';
import { Upload, ImageIcon, CheckCircle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { uploadAppIcon, buildIconUrl, applyFaviconToDocument } from '@/lib/app-icon';
import { useAppIcon } from '@/hooks/use-app-icon';

export function AppIconUpload() {
  const { icon192, isLoading } = useAppIcon();
  const [uploading, setUploading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid file', description: 'Please select an image file.', variant: 'destructive' });
      return;
    }
    const preview = URL.createObjectURL(file);
    setLocalPreview(preview);
    setUploading(true);
    try {
      const baseUrl = await uploadAppIcon(file);
      applyFaviconToDocument(
        buildIconUrl(baseUrl, 'icon-192.png'),
        buildIconUrl(baseUrl, 'apple-touch-icon.png'),
      );
      toast({ title: 'Icon updated', description: 'Sizes 192×192, 512×512 and 180×180 generated and saved.' });
    } catch (err) {
      setLocalPreview(null);
      URL.revokeObjectURL(preview);
      toast({ title: 'Upload failed', description: String(err), variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const displayIcon = localPreview ?? icon192;

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          App Icon
          {displayIcon && !uploading && <CheckCircle className="w-3.5 h-3.5 text-success" />}
        </CardTitle>
        <CardDescription className="text-xs">
          The master icon for this app. Automatically resized to 192×192, 512×512 (PWA), and
          180×180 (Apple touch icon). Used as the browser favicon and home-screen shortcut.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div
            className="w-16 h-16 rounded-xl border border-border bg-muted flex items-center justify-center overflow-hidden flex-shrink-0 cursor-pointer"
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            onClick={() => !uploading && inputRef.current?.click()}
            title="Click or drop an image to upload"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : displayIcon ? (
              <img src={displayIcon} alt="App icon" className="w-full h-full object-cover" />
            ) : (
              <ImageIcon className="w-6 h-6 text-muted-foreground" />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? (
                <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Generating sizes…</>
              ) : (
                <><Upload className="w-3.5 h-3.5 mr-2" />Upload icon</>
              )}
            </Button>
            <p className="text-[10px] text-muted-foreground font-mono">PNG · SVG · JPG · max 2 MB</p>
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={onInputChange}
        />
      </CardContent>
    </Card>
  );
}
