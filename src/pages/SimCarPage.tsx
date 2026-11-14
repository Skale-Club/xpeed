import AppLayout from '@/components/AppLayout';
import { CarPage } from '@/components/sim/CarPage';

/**
 * Virtual > Game cars > one car: its dashboard (it has no menu entry of its own; Game cars stays highlighted). The page draws its own header: the name
 * of the car is the heading, with the way back above it.
 */
export default function SimCarPage() {
  return (
    <AppLayout>
      <div className="max-w-7xl">
        <CarPage />
      </div>
    </AppLayout>
  );
}
