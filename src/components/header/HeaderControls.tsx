import { useTranslation } from 'react-i18next';
import { ConnectionPill } from '@/components/trip/ConnectionPill';
import { VehicleNotificationBell } from '@/components/VehicleNotificationBell';

export function HeaderControls() {
  const { t } = useTranslation();
  return <div role="group" aria-label={t('header.controls', 'Car status and notifications')}
      className="ml-auto flex min-w-0 items-center">
      <ConnectionPill />
      <VehicleNotificationBell />
    </div>;
}
