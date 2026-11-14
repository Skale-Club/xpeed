import { useId, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { OptionSelect } from '@/components/ui/option-select';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, EyeOff, Globe, Users, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanName, driverPath, VISIBILITIES, type Visibility } from '@/lib/sim/social-client';
import { VISIBILITY_SHOWS, atHandle, avatarHue, initialsOf } from './social-utils';

const AVATAR_SIZE = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-sm', lg: 'h-14 w-14 text-xl', xl: 'h-16 w-16 text-2xl' } as const;

/** A round avatar with the driver's initials, in a colour that is always the same for the same handle. Decorative: the name is written next to it. */
export function Avatar({ handle, displayName, size = 'md', className }: { handle: string; displayName?: string | null; size?: keyof typeof AVATAR_SIZE; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none', AVATAR_SIZE[size], className)}
      style={{ backgroundColor: `hsl(${avatarHue(handle)} 42% 33%)`, color: 'hsl(0 0% 98%)' }}
      data-testid="avatar"
    >
      {initialsOf(displayName, handle)}
    </span>
  );
}

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

/**
 * Who can see a profile: three choices, each with what it means in plain words and a short preview (what the others see: the public
 * leaderboards, the friends leaderboards, your page, a friend request by your handle).
 */
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
  const rows: Array<{ id: 'publicBoard' | 'friendsBoard' | 'page' | 'findable'; text: string }> = [
    { id: 'publicBoard', text: t('social.visibility.showsPublicBoard', 'Public leaderboards') },
    { id: 'friendsBoard', text: t('social.visibility.showsFriendsBoard', 'Friends leaderboards') },
    { id: 'page', text: t('social.visibility.showsPage', 'Your driver page') },
    { id: 'findable', text: t('social.visibility.showsFindable', 'Found by your handle') },
  ];
  return (
    <div role="radiogroup" aria-label={t('social.visibility.label', 'Who can see your profile')} className="grid gap-2 lg:grid-cols-3" data-testid="visibility-picker">
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
              <span className="block pt-1.5">
                <span className="sr-only">{t('social.visibility.showsHeading', 'Who sees what with this choice')}</span>
                <ul className="grid gap-1 text-xs" data-testid={`visibility-shows-${option}`}>
                  {rows.map((row) => {
                    const yes = VISIBILITY_SHOWS[option][row.id];
                    return (
                      <li key={row.id} className={cn('flex items-center gap-1.5', yes ? 'text-foreground' : 'text-muted-foreground')} data-shows={yes ? 'yes' : 'no'}>
                        {yes ? <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" /> : <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                        <span>{row.text}</span>
                        <span className="sr-only">: {yes ? t('social.visibility.yes', 'shown') : t('social.visibility.no', 'not shown')}</span>
                      </li>
                    );
                  })}
                </ul>
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * One block of a settings page: the title and a sentence about it on the left, the controls in a card on the right (stacked on a phone).
 * `danger` is for what cannot be undone: a red outline and a red title.
 */
export function SettingsSection({ title, description, danger, testId, children }: { title: ReactNode; description?: ReactNode; danger?: boolean; testId?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 md:grid-cols-[15rem,minmax(0,1fr)] md:gap-6" data-testid={testId}>
      <div className="space-y-1">
        <h3 className={cn('text-sm font-semibold', danger && 'text-destructive')}>{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Card className={cn('min-w-0 space-y-4 bg-card p-4', danger && 'border-destructive/40')}>{children}</Card>
    </section>
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

/** A labelled drop-down (the app's Radix select, the same on every screen). */
export function PlainSelect({ label, value, onChange, options, disabled, testId }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** An option with a `group` goes under that heading (the groups keep the order they first appear in). */
  options: Array<{ value: string; label: string; group?: string }>;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <label htmlFor={id}>{label}</label>
      <OptionSelect id={id} size="sm" className="h-9 w-full min-w-0 text-sm" value={value} onChange={onChange} options={options} disabled={disabled} data-testid={testId} />
    </div>
  );
}
