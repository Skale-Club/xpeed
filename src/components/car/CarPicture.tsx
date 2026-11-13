import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { carPhotoUrl } from '@/lib/car-photo';
import { findVehicleVisual, loadVehicleVisuals, vehicleVisualAssetUrl, type VehicleVisual } from '@/lib/vehicle-visuals';
import { isTransparentImage } from '@/lib/transparent-image';
import { VehicleModelViewer } from '@/components/car/VehicleModelViewer';

export interface CarLook {
  name?: string | null;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  body_type?: string | null;
  color?: string | null;
  photo_path?: string | null;
}

/**
 * Shows catalog-backed art, optionally with an interactive GLB and verified owner cutout.
 */
export function CarPicture({ car, className, label, interactive = false, cutoutOnly = false }: { car: CarLook; className?: string; label?: string; interactive?: boolean; cutoutOnly?: boolean }) {
  const [visual, setVisual] = useState<VehicleVisual>();
  const [catalogReady, setCatalogReady] = useState(false);
  const [ownerPhoto, setOwnerPhoto] = useState<string>();
  const [cutout, setCutout] = useState<string>();
  const [posterFailed, setPosterFailed] = useState(false);
  const [modelFailed, setModelFailed] = useState(false);
  const handleModelFailure = useCallback(() => setModelFailed(true), []);
  const recoverPhoto = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    setVisual(undefined);
    setCatalogReady(false);
    setModelFailed(false);
    setPosterFailed(false);
    void loadVehicleVisuals().then((items) => {
      if (active) {
        const match = findVehicleVisual(items, { make: car.make, model: car.model, year: car.year });
        setVisual(match ? { ...match, modelPath: match.modelPath ? vehicleVisualAssetUrl(match.modelPath) : null, posterPath: match.posterPath ? vehicleVisualAssetUrl(match.posterPath) : null } : undefined);
        setCatalogReady(true);
      }
    }).catch(() => { if (active) setCatalogReady(true); });
    return () => { active = false; };
  }, [car.make, car.model, car.year]);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let lastRefresh = 0;
    let retried = false;
    setOwnerPhoto(undefined);
    setCutout(undefined);
    setPosterFailed(false);
    if (!car.photo_path) return;
    const refresh = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const url = await carPhotoUrl(car.photo_path!, true);
        if (!url) return;
        if (cutoutOnly) {
          const transparent = await isTransparentImage(url);
          if (!cancelled && transparent) setCutout(url);
          else if (!cancelled) setCutout(undefined);
        } else if (!cancelled) setOwnerPhoto(url);
        if (!cancelled) lastRefresh = Date.now();
      } catch { /* Use catalog art when the private photo cannot be verified. */ }
      finally { pending = false; }
    };
    recoverPhoto.current = () => {
      setOwnerPhoto(undefined);
      setCutout(undefined);
      lastRefresh = 0;
      if (cutoutOnly || retried) return;
      retried = true;
      void refresh();
    };
    void refresh();
    const timer = setInterval(() => { retried = false; void refresh(); }, 50 * 60_000);
    const resume = () => { if (document.visibilityState === 'visible' && Date.now() - lastRefresh >= 50 * 60_000) void refresh(); };
    const online = () => { retried = false; void refresh(); };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', resume);
    return () => { cancelled = true; recoverPhoto.current = () => {}; clearInterval(timer); window.removeEventListener('online', online); document.removeEventListener('visibilitychange', resume); };
  }, [car.photo_path, cutoutOnly]);

  const alt = label ?? ([car.year, car.make, car.model].filter(Boolean).join(' ') || car.name || 'Vehicle');
  if (cutoutOnly && cutout) return <img src={cutout} alt={alt} onError={() => recoverPhoto.current()} className={cn('h-full w-full object-contain', className)} data-testid="vehicle-cutout" />;
  if (!cutoutOnly && ownerPhoto) return <img src={ownerPhoto} alt={alt} onError={() => recoverPhoto.current()} className={cn('aspect-[200/76] w-full rounded-xl object-cover', className)} data-testid="car-photo" />;
  if (!catalogReady || !visual) return null;
  const showPoster = !!visual.posterPath && !posterFailed;
  const showModel = interactive && !!visual.modelPath && !modelFailed;
  if (!showPoster && !showModel) return null;
  return (
    <div className={cn('relative aspect-[4/3] min-w-0 overflow-hidden', className)}>
      {showPoster && <img src={visual.posterPath!} alt={alt} onError={() => setPosterFailed(true)} className="absolute inset-0 h-full w-full object-contain" data-testid="vehicle-poster" />}
      {showModel && <VehicleModelViewer visual={visual} alt={alt} className="absolute inset-0 h-full w-full" onFailure={handleModelFailure} />}
      {showModel && <span aria-hidden="true" className="absolute bottom-1 left-1 rounded bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground">360°</span>}
      <div className="absolute bottom-1 right-1 z-10 flex gap-1 rounded bg-background/75 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        <a href={visual.credit.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Model by ${visual.credit.author}`} title={`${visual.credit.author}${visual.credit.changes ? ` · ${visual.credit.changes}` : ''}`}>{visual.credit.author}</a>
        <a href={visual.credit.licenseUrl} target="_blank" rel="noreferrer" aria-label={`License ${visual.credit.license}`}>{visual.credit.license}</a>
      </div>
    </div>
  );
}
