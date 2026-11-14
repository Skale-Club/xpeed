import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * How a control of a filter bar sits in the row: on a phone two to a row (a lone one takes the whole row), on a wider screen it keeps the
 * width it is given. The bar is a wrapping flex row, so this is all a control needs to fit one line at 1280 px and wrap cleanly at 375 px.
 */
export const FILTER_CELL = 'min-w-0 flex-1 basis-[calc(50%-0.25rem)] sm:flex-none sm:basis-auto';

/** A control that takes a whole row on a phone (a search box) and a fixed width on a wider screen. */
export const FILTER_WIDE_CELL = 'min-w-0 basis-full sm:flex-none sm:basis-auto';

/**
 * The bar over a list or a chart: one wrapping row of small controls (drop-downs with their name inside, a search box, a toggle), with no card,
 * border or padding of its own. Anything that filters or sorts a list is built from this, so every bar looks and behaves the same.
 */
export function FilterBar({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)} {...rest}>
      {children}
    </div>
  );
}
