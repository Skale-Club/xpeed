import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CountryFlag } from '@/components/CountryFlag';
import { LANGUAGES, currentLanguage } from '@/lib/languages';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = currentLanguage(i18n.resolvedLanguage);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 text-xs">
          <CountryFlag iso={current.iso} />
          <span>{current.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {LANGUAGES.map((l) => (
          <DropdownMenuItem
            key={l.code}
            onClick={() => i18n.changeLanguage(l.code)}
            className={`gap-2 ${current.code === l.code ? 'bg-accent' : ''}`}
          >
            <CountryFlag iso={l.iso} />
            {l.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
