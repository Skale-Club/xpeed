import { cn } from '@/lib/utils';

/**
 * The Xpeed logo, the same everywhere (sidebar, header, landing, sign-in,
 * onboarding, shared reports). It is generated with the other icons from
 * branding/mark.svg by `npm run brand`, so all of them change together.
 */
export function BrandLogo({ className, alt = 'Xpeed' }: { className?: string; alt?: string }) {
  return <img src="/logo.svg" alt={alt} className={cn('h-8 w-8 shrink-0 rounded-[22%] object-contain', className)} />;
}
