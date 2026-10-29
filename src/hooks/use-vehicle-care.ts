import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { vehicleCareRequest } from '@/lib/vehicle-care-api';
export function useVehicleCare(carId: string) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['vehicle-care', user?.id, carId], queryFn: () => vehicleCareRequest(carId), enabled: !!user && !!carId, staleTime: 60000, refetchInterval: 60000 });
}
