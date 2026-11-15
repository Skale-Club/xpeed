import { Suspense, lazy, type ComponentProps, type ComponentType, type JSX } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

/**
 * A chart that loads on its own. The chart library is large; a screen that shows
 * charts only after its numbers are in should not make everybody download it
 * before the screen can draw. The place of the chart shows a quiet block until it arrives.
 */
export function lazyChart<C extends AnyComponent>(
  load: () => Promise<{ default: C }>,
  height = 'h-64',
): (props: ComponentProps<C>) => JSX.Element {
  const Chart: AnyComponent = lazy(load);
  const Wrapped = (props: ComponentProps<C>) => (
    <Suspense fallback={<Skeleton className={`${height} w-full rounded-lg`} data-testid="chart-loading" />}>
      <Chart {...props} />
    </Suspense>
  );
  return Wrapped;
}
