import AppLayout from '@/components/AppLayout';
import { SimOverview } from '@/components/sim/SimOverview';

/** Virtual > Overview: the racing dashboard. It draws its own header (the title, the period and the Companion status). */
export default function SimOverviewPage() {
  return (
    <AppLayout>
      <div className="max-w-7xl">
        <SimOverview />
      </div>
    </AppLayout>
  );
}
