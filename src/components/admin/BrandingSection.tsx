// Super-admin branding section. Lives inside AdminPage. Lets admins upload
// one source image plus optional OG override, customize theme/background
// colors, and saves the whole config to app_settings.brand_config in one go.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Image as ImageIcon, RotateCcw, AlertTriangle, CheckCircle, Upload, Sparkles } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  buildAndUploadBrand,
  saveBrandConfig,
  clearBrandConfig,
  loadBrandConfig,
  generateThumbnails,
  DEFAULT_BRAND,
  ICON_SIZES,
  type BrandConfig,
} from '@/lib/brand';
import { reloadBrand, useBrand } from '@/hooks/use-brand';

export default function BrandingSection() {
  const { toast } = useToast();
  const currentBrand = useBrand();

  const [persisted, setPersisted] = useState<BrandConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [ogFile, setOgFile] = useState<File | null>(null);
  const [ogPreview, setOgPreview] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<{ size: number; dataUrl: string }[]>([]);

  const [themeColor, setThemeColor] = useState(currentBrand.theme_color);
  const [backgroundColor, setBackgroundColor] = useState(currentBrand.background_color);

  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const ogInputRef = useRef<HTMLInputElement>(null);

  // Initial load — fetch the persisted brand config (may be null)
  useEffect(() => {
    (async () => {
      const cfg = await loadBrandConfig();
      setPersisted(cfg);
      if (cfg) {
        setThemeColor(cfg.theme_color);
        setBackgroundColor(cfg.background_color);
      }
      setLoading(false);
    })();
  }, []);

  // Regenerate thumbnails whenever the source or background changes
  useEffect(() => {
    if (!sourceFile) {
      setThumbs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const t = await generateThumbnails(sourceFile, backgroundColor);
        if (!cancelled) setThumbs(t);
      } catch (err) {
        if (!cancelled) toast({ title: 'Preview failed', description: String(err), variant: 'destructive' });
      }
    })();
    return () => { cancelled = true; };
  }, [sourceFile, backgroundColor, toast]);

  // Object URLs for previews
  useEffect(() => {
    if (!sourceFile) {
      setSourcePreview(null);
      return;
    }
    const url = URL.createObjectURL(sourceFile);
    setSourcePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceFile]);

  useEffect(() => {
    if (!ogFile) {
      setOgPreview(null);
      return;
    }
    const url = URL.createObjectURL(ogFile);
    setOgPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [ogFile]);

  const hasSource = !!sourceFile;
  const hasChanges = useMemo(() => {
    if (sourceFile || ogFile) return true;
    if (!persisted) {
      return themeColor !== DEFAULT_BRAND.theme_color || backgroundColor !== DEFAULT_BRAND.background_color;
    }
    return themeColor !== persisted.theme_color || backgroundColor !== persisted.background_color;
  }, [sourceFile, ogFile, themeColor, backgroundColor, persisted]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // If only colors changed (no new source upload), patch the existing config
      if (!sourceFile && !ogFile && persisted) {
        const next: BrandConfig = { ...persisted, theme_color: themeColor, background_color: backgroundColor };
        await saveBrandConfig(next);
        setPersisted(next);
        await reloadBrand();
        toast({ title: 'Brand colors saved' });
        return;
      }

      if (!sourceFile) {
        toast({ title: 'Pick a source image first', variant: 'destructive' });
        return;
      }

      const result = await buildAndUploadBrand({
        sourceFile,
        ogFile: ogFile ?? null,
        themeColor,
        backgroundColor,
        previousVersion: persisted?.version ?? 0,
      });
      await saveBrandConfig(result);
      setPersisted(result);
      setSourceFile(null);
      setOgFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (ogInputRef.current) ogInputRef.current.value = '';
      await reloadBrand();
      toast({ title: 'Brand updated', description: `Version ${result.version} live across the app.` });
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [sourceFile, ogFile, persisted, themeColor, backgroundColor, toast]);

  const handleReset = useCallback(async () => {
    if (!confirm('Reset to default branding? Uploaded images stay in storage but stop being used.')) return;
    setResetting(true);
    try {
      await clearBrandConfig();
      setPersisted(null);
      setThemeColor(DEFAULT_BRAND.theme_color);
      setBackgroundColor(DEFAULT_BRAND.background_color);
      setSourceFile(null);
      setOgFile(null);
      await reloadBrand();
      toast({ title: 'Branding reset to default' });
    } catch (err) {
      toast({ title: 'Reset failed', description: String(err), variant: 'destructive' });
    } finally {
      setResetting(false);
    }
  }, [toast]);

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          Branding
          {persisted && <CheckCircle className="w-3.5 h-3.5 text-success" />}
          <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
            v{persisted?.version ?? 0}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">
          Upload one square image (PNG, JPG, WebP, or SVG; max 2 MB). It auto-populates the favicon,
          PWA icons (32, 180, 192, 512), app header, auth/onboarding logos, and the OG/Twitter share image.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="text-center py-6"><Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" /></div>
        ) : (
          <>
            {/* Current state preview */}
            <div className="grid grid-cols-3 gap-3 text-[10px] font-mono text-muted-foreground">
              <div className="space-y-1">
                <div className="uppercase tracking-wide">Current logo</div>
                <div
                  className="w-full aspect-square rounded border border-border flex items-center justify-center overflow-hidden"
                  style={{ background: currentBrand.background_color }}
                >
                  <img src={currentBrand.logo_url} alt="logo" className="max-w-[80%] max-h-[80%] object-contain" />
                </div>
              </div>
              <div className="space-y-1">
                <div className="uppercase tracking-wide">Theme</div>
                <div className="w-full aspect-square rounded border border-border" style={{ background: currentBrand.theme_color }} />
                <code className="block">{currentBrand.theme_color}</code>
              </div>
              <div className="space-y-1">
                <div className="uppercase tracking-wide">Background</div>
                <div className="w-full aspect-square rounded border border-border" style={{ background: currentBrand.background_color }} />
                <code className="block">{currentBrand.background_color}</code>
              </div>
            </div>

            {/* Source uploader */}
            <div className="space-y-2">
              <Label className="text-xs font-mono">Source image (square, ≥512px recommended)</Label>
              <div className="flex gap-3 items-start">
                <div
                  className="w-32 h-32 rounded border-2 border-dashed border-border flex items-center justify-center overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                  style={{ background: backgroundColor }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {sourcePreview ? (
                    <img src={sourcePreview} alt="source" className="max-w-full max-h-full object-contain" />
                  ) : (
                    <div className="text-muted-foreground text-center px-2">
                      <Upload className="w-5 h-5 mx-auto mb-1" />
                      <div className="text-[10px] font-mono">Click to upload</div>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
                />
                <div className="flex-1 space-y-2 text-xs font-mono text-muted-foreground">
                  {sourceFile ? (
                    <>
                      <div className="text-foreground">{sourceFile.name}</div>
                      <div>{(sourceFile.size / 1024).toFixed(1)} KB · {sourceFile.type}</div>
                      <Button size="sm" variant="outline" onClick={() => setSourceFile(null)} className="text-xs h-7">
                        Remove
                      </Button>
                    </>
                  ) : (
                    <>
                      <div>Drop or click the area to the left.</div>
                      <div className="text-[10px]">Accepted: PNG, JPG, WebP, SVG. Max 2 MB.</div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Live derived thumbnails */}
            {hasSource && thumbs.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs font-mono">Derived sizes (preview)</Label>
                <div className="flex gap-3 flex-wrap">
                  {thumbs.map(({ size, dataUrl }) => (
                    <div key={size} className="text-center">
                      <img
                        src={dataUrl}
                        alt={`${size}px`}
                        className="border border-border rounded"
                        style={{ width: Math.min(size, 96), height: Math.min(size, 96), imageRendering: size <= 32 ? 'pixelated' : 'auto' }}
                      />
                      <div className="text-[10px] font-mono text-muted-foreground mt-1">{size}×{size}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Colors */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-mono">Theme color</Label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={themeColor}
                    onChange={(e) => setThemeColor(e.target.value)}
                    className="h-9 w-12 rounded border border-border cursor-pointer bg-transparent"
                  />
                  <Input
                    value={themeColor}
                    onChange={(e) => setThemeColor(e.target.value)}
                    className="font-mono text-xs"
                    placeholder="#0a0a0a"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-mono">Background color</Label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={backgroundColor}
                    onChange={(e) => setBackgroundColor(e.target.value)}
                    className="h-9 w-12 rounded border border-border cursor-pointer bg-transparent"
                  />
                  <Input
                    value={backgroundColor}
                    onChange={(e) => setBackgroundColor(e.target.value)}
                    className="font-mono text-xs"
                    placeholder="#0a0a0a"
                  />
                </div>
              </div>
            </div>

            {/* Optional OG image */}
            <div className="space-y-2">
              <Label className="text-xs font-mono">OG share image (optional · 1200×630)</Label>
              <div className="flex gap-3 items-start">
                <div
                  className="w-32 h-16 rounded border-2 border-dashed border-border flex items-center justify-center overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                  style={{ background: backgroundColor }}
                  onClick={() => ogInputRef.current?.click()}
                >
                  {ogPreview ? (
                    <img src={ogPreview} alt="og" className="max-w-full max-h-full object-contain" />
                  ) : (
                    <ImageIcon className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>
                <input
                  ref={ogInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => setOgFile(e.target.files?.[0] ?? null)}
                />
                <div className="flex-1 text-[11px] font-mono text-muted-foreground">
                  {ogFile ? (
                    <>
                      <div className="text-foreground">{ogFile.name}</div>
                      <Button size="sm" variant="outline" onClick={() => setOgFile(null)} className="text-xs h-7 mt-1">
                        Remove
                      </Button>
                    </>
                  ) : (
                    <>If left empty, the OG image is auto-generated from the source logo on a {backgroundColor} background.</>
                  )}
                </div>
              </div>
            </div>

            {/* Sticky note */}
            <Alert>
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription className="text-xs">
                Changes propagate to <strong>all users</strong> on next reload. PWA installed copies refresh on
                their own update cycle (a few seconds to a few minutes).
              </AlertDescription>
            </Alert>

            <div className="flex justify-between gap-2">
              <Button variant="outline" size="sm" onClick={handleReset} disabled={resetting || !persisted}>
                {resetting && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Reset to default
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !hasChanges}>
                {saving && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                Save branding
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
