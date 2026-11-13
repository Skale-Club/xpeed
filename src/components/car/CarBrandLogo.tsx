import { useQuery } from '@tanstack/react-query';
import { Car } from 'lucide-react';
import { useState } from 'react';
import { carBrandLogoUrl, fetchCarBrands, resolveCarBrand } from '@/lib/car-brands';
import { cn } from '@/lib/utils';

interface CarBrandLogoProps { make?: string | null; className?: string; decorative?: boolean }

export function CarBrandLogo({ make, className, decorative = true }: CarBrandLogoProps) {
  const { data: brands = [] } = useQuery({ queryKey: ['car-brands'], queryFn: fetchCarBrands, staleTime: 60 * 60 * 1000 });
  const brand = resolveCarBrand(make, brands);
  const src = brand ? carBrandLogoUrl(brand) : undefined;
  const [failedSrc, setFailedSrc] = useState<string>();
  const showLogo = !!src && failedSrc !== src;
  return (
    <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-1 ring-1 ring-black/5', className)}>
      {showLogo ? <img key={src} src={src} alt={decorative ? '' : brand?.name ?? ''} className="h-full w-full object-contain" onError={() => setFailedSrc(src)} /> : <Car aria-hidden="true" className="h-4 w-4 text-muted-foreground" />}
    </span>
  );
}
