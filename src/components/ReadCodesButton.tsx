import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ScanSearch } from 'lucide-react';
import { Button } from './ui/button';
export function ReadCodesButton() {
  const { t } = useTranslation();
  return <Button asChild variant="outline" className="w-full whitespace-normal sm:w-auto"><Link to="/codes"><ScanSearch className="mr-2 h-4 w-4 shrink-0" />{t('codes.title', 'Read car fault codes')}</Link></Button>;
}
