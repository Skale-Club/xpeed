import { forwardRef } from 'react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** A compact 32 px surface inside a comfortable 44 px touch target. */
export const HeaderControl = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, ...props }, ref) => (
    <Button ref={ref} variant="ghost" size="icon" {...props}
      className={cn(
        "relative isolate h-11 w-11 shrink-0 rounded-lg bg-transparent p-0 text-muted-foreground before:pointer-events-none before:absolute before:inset-x-1 before:inset-y-1.5 before:-z-10 before:rounded-lg before:border before:border-border/50 before:bg-card/50 before:transition-colors before:content-[''] hover:bg-transparent hover:text-foreground hover:before:border-foreground/20 hover:before:bg-accent data-[state=open]:text-primary data-[state=open]:before:border-primary/40 data-[state=open]:before:bg-primary/10 [&_svg]:size-4",
        className,
      )} />
  ),
);
HeaderControl.displayName = 'HeaderControl';
