import { useQuery } from '@tanstack/react-query';
import { CarBrandLogo } from '@/components/car/CarBrandLogo';
import { fetchCarBrands } from '@/lib/car-brands';
import { resolveVirtualCarBrand } from '@/lib/sim/car-brand';

/** A car as the person knows it: the brand's logo when the name says the brand (the generic car otherwise) and the name as the game gives it. */
export function SimCarIdentity({ name, className = '', logoClassName = 'h-6 w-6' }: { name: string; className?: string; logoClassName?: string }) {
  const { data: brands = [] } = useQuery({ queryKey: ['car-brands'], queryFn: fetchCarBrands, staleTime: 60 * 60 * 1000 });
  const brand = resolveVirtualCarBrand(name, brands);
  return <span className={`inline-flex min-w-0 items-center gap-2 ${className}`} data-testid="sim-car-identity">
    <CarBrandLogo make={brand?.name} className={logoClassName} />
    <span className="truncate">{name}</span>
  </span>;
}
