import { useQuery } from '@tanstack/react-query';
import { CarBrandLogo } from '@/components/car/CarBrandLogo';
import { fetchCarBrands } from '@/lib/car-brands';
import { resolveVirtualCarBrand } from '@/lib/sim/car-brand';

export function SimCarIdentity({ name, className = '' }: { name: string; className?: string }) {
  const { data: brands = [] } = useQuery({ queryKey: ['car-brands'], queryFn: fetchCarBrands, staleTime: 60 * 60 * 1000 });
  const brand = resolveVirtualCarBrand(name, brands);
  return <span className={`inline-flex min-w-0 items-center gap-2 ${className}`} data-testid="sim-car-identity">
    <CarBrandLogo make={brand?.name} className="h-6 w-6" />
    <span className="truncate">{name}</span>
  </span>;
}
