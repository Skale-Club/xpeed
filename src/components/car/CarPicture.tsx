import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { carBodyType } from '@/lib/car-look';
import { carPhotoUrl } from '@/lib/car-photo';
import { CarSilhouette } from '@/components/car/CarSilhouette';

export interface CarLook {
  name?: string | null;
  model?: string | null;
  body_type?: string | null;
  color?: string | null;
  photo_path?: string | null;
}

/**
 * The car as people recognise it: the owner's photo when there is one,
 * otherwise a silhouette of its kind of car in its colour.
 */
export function CarPicture({ car, className, label }: { car: CarLook; className?: string; label?: string }) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const recover = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let lastRefresh = 0;
    let retried = false;
    setPhoto(null);
    setFailed(false);
    const path = car.photo_path;
    if (!path) return;
    const refresh = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const url = await carPhotoUrl(path, true);
        if (!cancelled && url) {
          setPhoto(url);
          setFailed(false);
          lastRefresh = Date.now();
        }
      } catch {
        // Keep the current image on a transient signing failure.
      } finally { pending = false; }
    };
    recover.current = () => {
      setFailed(true);
      lastRefresh = 0;
      if (!retried) { retried = true; void refresh(); }
    };
    const resume = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh >= 50 * 60_000) void refresh();
    };
    const online = () => { retried = false; void refresh(); };
    // Start with a full lifetime; a cached link could be close to expiring.
    void refresh();
    const timer = setInterval(() => { retried = false; void refresh(); }, 50 * 60_000);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', online);
    return () => {
      cancelled = true;
      recover.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', online);
    };
  }, [car.photo_path]);

  if (car.photo_path && photo && !failed) {
    return (
      <img
        src={photo}
        alt={label ?? car.name ?? ''}
        onError={() => recover.current()}
        className={cn('aspect-[200/76] w-full rounded-xl object-cover', className)}
        data-testid="car-photo"
      />
    );
  }
  return <CarSilhouette bodyType={carBodyType(car)} color={car.color} title={label} className={className} />;
}
