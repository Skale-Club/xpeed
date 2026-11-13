import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Info, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { driverPath, profileFieldOf, useMyProfile, useUpdateProfile, type ProfilePatch, type Visibility } from '@/lib/sim/social-client';
import { ActiveLinks } from './ShareDialog';
import { ErrorLine, VisibilityPicker } from './social-bits';
import { atHandle } from './social-utils';
import { useErrorText } from './use-error-text';

export const HANDLE_CHANGES_PER_WINDOW = 3;
export const DISPLAY_NAME_MAX = 40;

/**
 * Virtual > Profile: the handle (3 changes in 30 days, the count is on screen), the display name, and who can see the profile
 * (Public, Friends only, Private, each explained). Saves with PATCH and shows what the server refused under the field it is about.
 * Below: the share links the person made, each revocable.
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
  const patch: ProfilePatch = {};
  if (profile) {
    if (handle.trim().toLowerCase() !== profile.handle) patch.handle = handle.trim().toLowerCase();
    if (displayName.trim() !== (profile.displayName ?? '')) patch.displayName = displayName.trim();
    if (visibility !== profile.visibility) patch.visibility = visibility;
  }
  const dirty = Object.keys(patch).length > 0;

  const failed = update.isError ? update.error : null;
  const failedField = failed ? profileFieldOf(failed) : null;
  const fieldError = (field: 'handle' | 'displayName' | 'visibility') => (failed && failedField === field ? errorText(failed) : null);

  const save = async () => {
    setSaved(false);
    try {
      await update.mutateAsync(patch);
      setSaved(true);
    } catch {
      /* shown under the field it is about */
    }
  };

  return (
    <div className="space-y-4" data-testid="profile-settings">
      <QueryGate query={query} empty={false} skeleton={<Skeleton className="h-96 w-full rounded-lg" />}>
        {profile && (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm" data-testid="profile-starts-public">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p>{t('social.profile.startsPublic', 'Your racing profile starts public: any signed-in driver can see your name, your handle and your best laps. Choose below who can see it.')}</p>
            </div>

            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                if (dirty) void save();
              }}
            >
              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">{t('social.profile.identity', 'Who you are on the leaderboards')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="space-y-1.5">
                    <label htmlFor="profile-handle" className="text-sm font-medium">{t('social.profile.handle', 'Handle')}</label>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground" aria-hidden>@</span>
                      <Input
                        id="profile-handle"
                        value={handle}
                        maxLength={24}
                        disabled={handleLocked}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-invalid={fieldError('handle') ? true : undefined}
                        aria-describedby="profile-handle-help"
                        onChange={(event) => { setHandle(event.target.value.toLowerCase()); setSaved(false); }}
                        data-testid="profile-handle"
                      />
                    </div>
                    <p id="profile-handle-help" className="text-xs text-muted-foreground">
                      {t('social.profile.handleHelp', '3 to 24 characters: a to z, 0 to 9 and _. Friends find you by it.')}
                    </p>
                    <p className="text-xs text-muted-foreground" data-testid="handle-changes">
                      {handleLocked
                        ? t('social.profile.changesNone', 'You have no handle changes left. You can change it again on {{date}}.', {
                            date: profile.handleChangesResetAt ? when(Date.parse(profile.handleChangesResetAt)) : '–',
                          })
                        : t('social.profile.changesLeft', 'You can change your handle {{left}} more times in 30 days (up to {{max}}).', { left, max: HANDLE_CHANGES_PER_WINDOW })}
                      {!handleLocked && profile.handleChangesResetAt &&
                        ` ${t('social.profile.changesBack', 'The next one comes back on {{date}}.', { date: when(Date.parse(profile.handleChangesResetAt)) })}`}
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
                    <p id="profile-name-help" className="text-xs text-muted-foreground">
                      {t('social.profile.displayNameHelp', 'Shown next to your handle. Use a nickname: your sign-in name and your e-mail are never shown to anyone.')}
                    </p>
                    {fieldError('displayName') && <ErrorLine testId="error-displayName">{fieldError('displayName')}</ErrorLine>}
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">{t('social.profile.visibility', 'Who can see your profile')}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <VisibilityPicker value={visibility} onChange={(value) => { setVisibility(value); setSaved(false); }} disabled={update.isPending} />
                  {fieldError('visibility') && <ErrorLine testId="error-visibility">{fieldError('visibility')}</ErrorLine>}
                  <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    <Link to="/virtual/privacy" className="underline">{t('social.profile.privacyLink', 'Privacy and your data')}</Link>
                  </p>
                </CardContent>
              </Card>

              {failed && !failedField && <ErrorLine testId="profile-error">{errorText(failed)}</ErrorLine>}

              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={!dirty || update.isPending} data-testid="profile-save">
                  {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('social.profile.save', 'Save')}
                </Button>
                {saved && !dirty && (
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status" data-testid="profile-saved">
                    <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden /> {t('social.profile.saved', 'Saved')}
                  </span>
                )}
                <Button asChild variant="link" className="h-auto p-0 text-sm">
                  <Link to={driverPath(profile.handle)}>{t('social.profile.viewPage', 'Your page: {{handle}}', { handle: atHandle(profile.handle) })}</Link>
                </Button>
              </div>
            </form>

            <Card className="bg-card border-border" data-testid="my-shared-links">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">{t('social.share.mine', 'My shared links')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('social.share.mineBody', 'Links to laps and sessions you shared. Anyone who has one can see that lap or session. Revoke a link to stop it working at once.')}</p>
                <ActiveLinks />
              </CardContent>
            </Card>
          </>
        )}
      </QueryGate>
    </div>
  );
}
