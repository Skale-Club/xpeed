import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { EyeOff, Globe, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanName, driverPath, VISIBILITIES, type Visibility } from '@/lib/sim/social-client';
import { atHandle } from './social-utils';

/**
 * Who a driver is: the display name and the handle, or the handle alone when the person has no name to show (a private profile in
 * a friend list). Never an e-mail, a phone number or an account name: the API has none to give. Links to the driver's page.
 */
export function DriverName({ handle, displayName, link = true, className, testId }: {
  handle: string;
  displayName?: string | null;
  link?: boolean;
  className?: string;
  testId?: string;
}) {
  const name = cleanName(displayName);
  const inner = name ? (
    <>
      <span className="truncate font-medium">{name}</span>
      <span className="truncate text-xs text-muted-foreground">{atHandle(handle)}</span>
    </>
  ) : (
    <span className="truncate font-medium">{atHandle(handle)}</span>
  );
  const classes = cn('flex min-w-0 items-baseline gap-x-2', className);
  return link ? (
    <Link to={driverPath(handle)} className={cn(classes, 'rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring')} data-testid={testId ?? 'driver-name'}>
      {inner}
    </Link>
  ) : (
    <span className={classes} data-testid={testId ?? 'driver-name'}>{inner}</span>
  );
}

const VISIBILITY_ICON = { public: Globe, friends: Users, private: EyeOff } as const;

/** Who can see a profile: three choices, each with what it means in plain words. */
export function VisibilityPicker({ value, onChange, disabled, name = 'visibility' }: {
  value: Visibility;
  onChange: (value: Visibility) => void;
  disabled?: boolean;
  name?: string;
}) {
  const { t } = useTranslation();
  const labels: Record<Visibility, { title: string; body: string }> = {
    public: {
      title: t('social.visibility.public', 'Public'),
      body: t('social.visibility.publicBody', 'Any signed-in driver can open your page and see you on the leaderboards: your name, your handle, when you joined and your best laps. This is the default.'),
    },
    friends: {
      title: t('social.visibility.friends', 'Friends only'),
      body: t('social.visibility.friendsBody', 'Only your friends can open your page, and you only show on the friends leaderboards. Nobody else can find you, not even by your handle.'),
    },
    private: {
      title: t('social.visibility.private', 'Private'),
      body: t('social.visibility.privateBody', 'Nobody can open your page or find you, and you are on no leaderboard. Your laps stay yours. A link you share still shows the lap, but not your name.'),
    },
  };
  return (
    <div role="radiogroup" aria-label={t('social.visibility.label', 'Who can see your profile')} className="grid gap-2" data-testid="visibility-picker">
      {VISIBILITIES.map((option) => {
        const Icon = VISIBILITY_ICON[option];
        const selected = value === option;
        return (
          <label
            key={option}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring',
              selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option)}
              className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
              data-testid={`visibility-${option}`}
            />
            <span className="min-w-0 space-y-0.5">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden /> {labels[option].title}
              </span>
              <span className="block text-xs text-muted-foreground">{labels[option].body}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** A line under a field or a button: what went wrong, said so a screen reader reads it. */
export function ErrorLine({ children, id, testId }: { children: ReactNode; id?: string; testId?: string }) {
  return (
    <p id={id} role="alert" className="text-xs text-destructive" data-testid={testId}>
      {children}
    </p>
  );
}

/** A labelled native drop-down, the same on every phone. */
export function PlainSelect({ label, value, onChange, options, disabled, testId }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select
        className="h-9 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      >
        {value && !options.some((option) => option.value === value) && <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
