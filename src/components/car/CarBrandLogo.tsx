import { useQuery } from '@tanstack/react-query';
import { Car } from 'lucide-react';
import { useState } from 'react';
import { carBrandLogoUrl, fetchCarBrands, resolveCarBrand } from '@/lib/car-brands';
import { knownLogoTone, logoToneFilter, readLogoTone, type LogoTone } from '@/lib/logo-tone';
import { cn } from '@/lib/utils';

interface CarBrandLogoProps { make?: string | null; className?: string; decorative?: boolean }

/** A make's logo on its own, with no box: the app is dark only, so a black logo is shown white to never disappear into the page. */
export function CarBrandLogo({ make, className, decorative = true }: CarBrandLogoProps) {
  const { data: brands = [] } = useQuery({ queryKey: ['car-brands'], queryFn: fetchCarBrands, staleTime: 60 * 60 * 1000 });
  const brand = resolveCarBrand(make, brands);
  const src = brand ? carBrandLogoUrl(brand) : undefined;
  const [failedSrc, setFailedSrc] = useState<string>();
  const [tone, setTone] = useState<{ src: string; tone: LogoTone }>();
  const showLogo = !!src && failedSrc !== src;
  const currentTone = src ? (tone?.src === src ? tone.tone : knownLogoTone(src)) : undefined;
  const onLoad = () => {
    if (!src || knownLogoTone(src)) return;
    void readLogoTone(src).then((value) => setTone({ src, tone: value }));
  };
  return (
    <span className={cn('inline-flex h-8 w-8 shrink-0 items-center justify-center', className)} data-testid="car-brand-logo">
      {showLogo ? (
        <img
          key={src}
          src={src}
          alt={decorative ? '' : brand?.name ?? ''}
          className="h-full w-full object-contain"
          style={{ filter: logoToneFilter(currentTone) }}
          data-tone={currentTone}
          onLoad={onLoad}
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <Car aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
      )}
    </span>
  );
}
