import { useEffect, useState } from 'react';
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

  useEffect(() => {
    let cancelled = false;
    setPhoto(null);
    setFailed(false);
    if (car.photo_path) {
      void carPhotoUrl(car.photo_path).then((url) => { if (!cancelled) setPhoto(url); });
    }
    return () => { cancelled = true; };
  }, [car.photo_path]);

  if (car.photo_path && photo && !failed) {
    return (
      <img
        src={photo}
        alt={label ?? car.name ?? ''}
        onError={() => setFailed(true)}
        className={cn('aspect-[200/76] w-full rounded-xl object-cover', className)}
        data-testid="car-photo"
      />
    );
  }
  return <CarSilhouette bodyType={carBodyType(car)} color={car.color} title={label} className={className} />;
}
