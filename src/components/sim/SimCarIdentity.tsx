import { useQuery } from '@tanstack/react-query';
import { CarBrandLogo } from '@/components/car/CarBrandLogo';
import { fetchCarBrands } from '@/lib/car-brands';
import { resolveVirtualCarBrand } from '@/lib/sim/car-brand';
import { CAR_LOGO } from './identity-sizes';

/**
 * A car as the person knows it, wherever a car is named: the brand's logo when the name says the brand (the generic car otherwise) and the
 * name as the game gives it. Never write a car's name alone on a Virtual screen: use this. The logo's size is one of `CAR_LOGO`
 * (`size`); a page header passes its own, bigger `logoClassName`.
 */
export function SimCarIdentity({ name, className = '', size = 'row', logoClassName, nameClassName = 'truncate' }: {
  name: string;
  className?: string;
  size?: keyof typeof CAR_LOGO;
  logoClassName?: string;
  nameClassName?: string;
}) {
  const { data: brands = [] } = useQuery({ queryKey: ['car-brands'], queryFn: fetchCarBrands, staleTime: 60 * 60 * 1000 });
  const brand = resolveVirtualCarBrand(name, brands);
  return <span className={`inline-flex min-w-0 max-w-full items-center gap-2 ${className}`} data-testid="sim-car-identity">
    <CarBrandLogo make={brand?.name} className={logoClassName ?? CAR_LOGO[size]} />
    <span className={nameClassName}>{name}</span>
  </span>;
}
