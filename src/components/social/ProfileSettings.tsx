import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CheckCircle2, EyeOff, Globe, Info, Loader2, ShieldCheck, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { driverPath, profileFieldOf, useMyProfile, useUpdateProfile, type ProfilePatch, type Visibility } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { SharedLinks } from './SharedLinks';
import { Avatar, DriverName, ErrorLine, SettingsSection, VisibilityPicker } from './social-bits';
import { atHandle, handleProblem, normalizeHandle, type HandleProblem } from './social-utils';
import { useErrorText } from './use-error-text';

export const HANDLE_CHANGES_PER_WINDOW = 3;
export const DISPLAY_NAME_MAX = 40;

const VISIBILITY_ICON = { public: Globe, friends: Users, private: EyeOff } as const;

/** Three pips, one for each handle change of the 30 days: filled while it can still be used. */
function ChangePips({ left }: { left: number }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={t('social.profile.pips', '{{left}} of {{max}} handle changes left', { left, max: HANDLE_CHANGES_PER_WINDOW })} data-testid="handle-pips">
      {Array.from({ length: HANDLE_CHANGES_PER_WINDOW }, (_, i) => (
        <span key={i} className={cn('h-2 w-2 rounded-full border border-primary', i < left ? 'bg-primary' : 'bg-transparent')} />
      ))}
    </span>
  );
}

/**
 * Virtual > Profile, as a settings page: who you are now (the avatar, the name, the handle, who can see it, since when), then a block for the
 * identity (a preview of how others see you; the handle is checked as you type and the count of changes is on screen; the display name), a block
 * for who can see the profile (three choices, each with what it shows), and the links you shared as cards. Saves with PATCH and shows what the
 * server refused under the field it is about.
 */
export function ProfileSettings() {
  const { t } = useTranslation();
  const when = useWhen('date');
  const errorText = useErrorText();
  const query = useMyProfile();
  const update = useUpdateProfile();
  const profile = query.data ?? null;

  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [saved, setSaved] = useState(false);

  // The form starts from the saved profile, and starts over from it after every save.
  useEffect(() => {
    if (!profile) return;
    setHandle(profile.handle);
    setDisplayName(profile.displayName ?? '');
    setVisibility(profile.visibility);
  }, [profile?.handle, profile?.displayName, profile?.visibility]); // eslint-disable-line react-hooks/exhaustive-deps

  const left = profile?.handleChangesLeft ?? HANDLE_CHANGES_PER_WINDOW;
  const handleLocked = left <= 0;
  const wantedHandle = normalizeHandle(handle);
  const handleChanged = !!profile && wantedHandle !== profile.handle;
  const problem: HandleProblem | null = handleChanged ? handleProblem(wantedHandle) : null;
  const problemText: Record<HandleProblem, string> = {
    empty: t('social.friends.handleShort', 'A handle has at least 3 characters.'),
    short: t('social.friends.handleShort', 'A handle has at least 3 characters.'),
    long: t('social.friends.handleLong', 'A handle has at most 24 characters.'),
    characters: t('social.friends.handleCharacters', 'Only the letters a to z, the digits 0 to 9 and _ are allowed.'),
  };
  const patch: ProfilePatch = {};
  if (profile) {
    if (handleChanged) patch.handle = wantedHandle;
    if (displayName.trim() !== (profile.displayName ?? '')) patch.displayName = displayName.trim();
    if (visibility !== profile.visibility) patch.visibility = visibility;
  }
  const dirty = Object.keys(patch).length > 0;

  const failed = update.isError ? update.error : null;
  const failedField = failed ? profileFieldOf(failed) : null;
  const fieldError = (field: 'handle' | 'displayName' | 'visibility') => (failed && failedField === field ? errorText(failed) : null);
  const liveProblem = problem ? problemText[problem] : null;

  const save = async () => {
    setSaved(false);
    try {
      await update.mutateAsync(patch);
      setSaved(true);
    } catch {
      /* shown under the field it is about */
    }
  };

  const Visible = profile ? VISIBILITY_ICON[profile.visibility] : Globe;
  const shownName = displayName.trim();

  return (
    <div className="space-y-6" data-testid="profile-settings">
      <QueryGate query={query} empty={false} skeleton={<Skeleton className="h-96 w-full rounded-xl" />}>
        {profile && (
          <>
            <Card className="flex flex-wrap items-center justify-between gap-4 bg-card p-4" data-testid="profile-summary">
              <div className="flex min-w-0 flex-1 basis-60 items-center gap-4">
              <Avatar handle={profile.handle} displayName={profile.displayName} size="xl" />
              <div className="min-w-0 flex-1 space-y-1">
                <DriverName handle={profile.handle} displayName={profile.displayName} link={false} className="flex-col items-start gap-0 text-lg" testId="profile-summary-name" />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant="secondary" className="gap-1" data-testid="profile-summary-visibility"><Visible className="h-3 w-3" aria-hidden="true" />{t(`social.visibility.${profile.visibility}`, profile.visibility)}</Badge>
                  <span className="inline-flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{t('social.driver.joined', 'Joined {{when}}', { when: when(Date.parse(profile.createdAt)) })}</span>
                </div>
              </div>
              </div>
              <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
                <Link to={driverPath(profile.handle)}>{t('social.profile.viewPage', 'Your page: {{handle}}', { handle: atHandle(profile.handle) })}</Link>
              </Button>
            </Card>

            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" data-testid="profile-starts-public">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>{t('social.profile.startsPublic', 'Your racing profile starts public: any signed-in driver can see your name, your handle and your best laps. Choose below who can see it.')}</p>
            </div>

            <form
              className="space-y-8"
              onSubmit={(event) => {
                event.preventDefault();
                if (dirty && !problem) void save();
              }}
            >
              <SettingsSection title={t('social.profile.identity', 'Who you are on the leaderboards')} description={t('social.profile.identityHint', 'This is how other drivers see you next to your times.')}>
                <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-3" data-testid="profile-preview">
                  <Avatar handle={wantedHandle || profile.handle} displayName={shownName} size="lg" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{t('social.profile.preview', 'Preview')}</p>
                    <DriverName handle={problem ? profile.handle : wantedHandle || profile.handle} displayName={shownName} link={false} className="flex-col items-start gap-0" testId="profile-preview-name" />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="profile-handle" className="text-sm font-medium">{t('social.profile.handle', 'Handle')}</label>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground" aria-hidden>@</span>
                    <Input
                      id="profile-handle"
                      value={handle}
                      maxLength={26}
                      disabled={handleLocked}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-invalid={fieldError('handle') || liveProblem ? true : undefined}
                      aria-describedby="profile-handle-help profile-handle-live"
                      onChange={(event) => { setHandle(event.target.value.toLowerCase()); setSaved(false); }}
                      data-testid="profile-handle"
                    />
                  </div>
                  <p id="profile-handle-help" className="text-xs text-muted-foreground">
                    {t('social.profile.handleHelp', '3 to 24 characters: a to z, 0 to 9 and _. Friends find you by it.')}
                  </p>
                  <p id="profile-handle-live" className={cn('text-xs', liveProblem ? 'text-destructive' : 'text-muted-foreground')} role={liveProblem ? 'alert' : undefined} data-testid="handle-live">
                    {liveProblem ?? (handleChanged ? t('social.profile.handleChecked', 'The format is fine. Whether it is free is checked when you save.') : '')}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="handle-changes">
                    <ChangePips left={left} />
                    <span>
                      {handleLocked
                        ? t('social.profile.changesNone', 'You have no handle changes left. You can change it again on {{date}}.', {
                            date: profile.handleChangesResetAt ? when(Date.parse(profile.handleChangesResetAt)) : '–',
                          })
                        : t('social.profile.changesLeft', 'You can change your handle {{left}} more times in 30 days (up to {{max}}).', { left, max: HANDLE_CHANGES_PER_WINDOW })}
                      {!handleLocked && profile.handleChangesResetAt &&
                        ` ${t('social.profile.changesBack', 'The next one comes back on {{date}}.', { date: when(Date.parse(profile.handleChangesResetAt)) })}`}
                    </span>
                  </p>
                  {fieldError('handle') && <ErrorLine testId="error-handle">{fieldError('handle')}</ErrorLine>}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="profile-name" className="text-sm font-medium">{t('social.profile.displayName', 'Display name')}</label>
                  <Input
                    id="profile-name"
                    value={displayName}
                    maxLength={DISPLAY_NAME_MAX}
                    aria-invalid={fieldError('displayName') ? true : undefined}
                    aria-describedby="profile-name-help"
                    onChange={(event) => { setDisplayName(event.target.value); setSaved(false); }}
                    data-testid="profile-name"
                  />
                  <p id="profile-name-help" className="flex justify-between gap-2 text-xs text-muted-foreground">
                    <span>{t('social.profile.displayNameHelp', 'Shown next to your handle. Use a nickname: your sign-in name and your e-mail are never shown to anyone.')}</span>
                    <span className="shrink-0 tabular-nums" aria-hidden="true">{displayName.length}/{DISPLAY_NAME_MAX}</span>
                  </p>
                  {fieldError('displayName') && <ErrorLine testId="error-displayName">{fieldError('displayName')}</ErrorLine>}
                </div>
              </SettingsSection>

              <SettingsSection title={t('social.profile.visibility', 'Who can see your profile')} description={t('social.profile.visibilityHint', 'Takes effect at once everywhere. Your laps stay yours whatever you choose.')}>
                <VisibilityPicker value={visibility} onChange={(value) => { setVisibility(value); setSaved(false); }} disabled={update.isPending} />
                {fieldError('visibility') && <ErrorLine testId="error-visibility">{fieldError('visibility')}</ErrorLine>}
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  <Link to="/virtual/privacy" className="underline">{t('social.profile.privacyLink', 'Privacy and your data')}</Link>
                </p>
              </SettingsSection>

              {failed && !failedField && <ErrorLine testId="profile-error">{errorText(failed)}</ErrorLine>}

              <div className="flex flex-wrap items-center gap-3 md:pl-[16.5rem]">
                <Button type="submit" disabled={!dirty || !!problem || update.isPending} data-testid="profile-save">
                  {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('social.profile.save', 'Save')}
                </Button>
                {saved && !dirty && (
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="profile-saved">
                    <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden /> {t('social.profile.saved', 'Saved')}
                  </span>
                )}
              </div>
            </form>

            <SettingsSection
              testId="my-shared-links"
              title={t('social.share.mine', 'My shared links')}
              description={t('social.share.mineBody', 'Links to laps and sessions you shared. Anyone who has one can see that lap or session. Revoke a link to stop it working at once.')}
            >
              <SharedLinks />
            </SettingsSection>
          </>
        )}
      </QueryGate>
    </div>
  );
}
