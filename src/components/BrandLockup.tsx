import { BrandLogo } from '@/components/BrandLogo';
import { cn } from '@/lib/utils';

/** Primary brand signature: keep the symbol and the product name together. */
export function BrandLockup({ className, logoClassName, nameClassName, labelClassName, tagline }: {
  className?: string;
  logoClassName?: string;
  nameClassName?: string;
  labelClassName?: string;
  tagline?: string;
}) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap', className)}>
      <BrandLogo className={logoClassName} alt="" />
      <span className={cn('flex flex-col text-left', labelClassName)}>
        <span className={cn('text-lg font-bold leading-none tracking-tight', nameClassName)}>Xpeed</span>
        {tagline && <span className="mt-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">{tagline}</span>}
      </span>
    </span>
  );
}
