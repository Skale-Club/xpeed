import { useCallback, useRef, useState } from 'react';
import { Upload, FileUp, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCSVUpload } from '@/hooks/use-csv-upload';

interface UploadCardProps {
  onComplete: (sessionId: string) => void;
  carProfileId?: string;
  variant?: 'default' | 'compact';
}

export default function UploadCard({ onComplete, carProfileId, variant = 'default' }: UploadCardProps) {
  const { upload, uploading, progressLabel, progressValue } = useCSVUpload(onComplete, carProfileId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [sessionName, setSessionName] = useState('');

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      return;
    }
    upload(file, sessionName);
  }, [upload, sessionName]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  if (variant === 'compact') {
    return (
      <Card
        className="relative overflow-hidden border-dashed border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all cursor-pointer"
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        {uploading && (
          <div
            className="pointer-events-none absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-300 ease-out"
            style={{ width: `${progressValue}%` }}
          />
        )}
        <CardContent className="relative z-10 flex items-center justify-between py-4 px-6">
          <div className="flex items-center gap-3">
            {uploading ? (
              <Loader2 className="w-4 h-4 text-primary animate-spin" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center">
                <FileUp className="w-4 h-4 text-primary" />
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-foreground">
                {uploading ? progressLabel : "Upload new log"}
              </p>
              {!uploading && (
                <p className="text-xs text-muted-foreground">Drop CSV or click to upload</p>
              )}
            </div>
          </div>
          {uploading && <p className="text-xs font-mono text-primary">{progressValue}%</p>}
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = '';
            }}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="relative overflow-hidden border-dashed border-2 border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 transition-all"
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
    >
      {uploading && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-primary/20 transition-[width] duration-300 ease-out"
          style={{ width: `${progressValue}%` }}
        />
      )}
      <CardContent className="relative z-10 flex flex-col gap-3 py-5 px-4">
        {/* Session name — top so keyboard never hides the upload button */}
        {!uploading && (
          <div onClick={e => e.stopPropagation()}>
            <Input
              placeholder="Session name (optional)"
              value={sessionName}
              onChange={e => setSessionName(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
        )}

        {/* Upload trigger — always below input so it stays above the keyboard */}
        <button
          type="button"
          disabled={uploading}
          onClick={() => !uploading && inputRef.current?.click()}
          className="flex flex-col items-center justify-center gap-3 py-6 rounded-lg border border-dashed border-primary/40 bg-primary/5 hover:bg-primary/10 active:bg-primary/15 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed w-full"
        >
          {uploading ? (
            <>
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
              <p className="text-sm font-mono text-primary">{progressLabel}</p>
              <p className="text-xs font-mono text-primary/80">{progressValue}%</p>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center">
                <FileUp className="w-6 h-6 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">Tap to choose CSV</p>
                <p className="text-xs text-muted-foreground mt-0.5">Car Scanner / OBD Fusion export</p>
              </div>
            </>
          )}
        </button>

        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
      </CardContent>
    </Card>
  );
}
