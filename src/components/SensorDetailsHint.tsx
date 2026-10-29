import { Maximize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function SensorDetailsHint() {
  const { t } = useTranslation();
  return <span aria-hidden="true" className="mt-2 flex items-center justify-end gap-1.5 text-xs font-medium text-primary">
    <Maximize2 className="h-3.5 w-3.5 shrink-0" />
    <span>{t('live.viewDetails', 'View details')}</span>
  </span>;
}
