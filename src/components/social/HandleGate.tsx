import { useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AtSign, Loader2 } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useDemoMode } from '@/lib/sim/demo/mode';
import { profileFieldOf, useMyProfile, useUpdateProfile } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { Avatar, DriverName, ErrorLine } from './social-bits';
import { handleProblem, normalizeHandle, type HandleProblem } from './social-utils';
import { useErrorText } from './use-error-text';
import { DISPLAY_NAME_MAX } from './ProfileSettings';

/**
 * Layout route in front of every Virtual screen: someone whose handle is still the generated placeholder (driver_ plus six letters)
 * chooses their username first, right after signing in. Everyone else, the example, and a profile that cannot be read right now
 * (the screens show their own error) go straight through.
 */
export function HandleGate({ children }: { children?: ReactNode }) {
  const demo = useDemoMode();
  const query = useMyProfile();
  const through = children ?? <Outlet />;
  if (demo || query.isError) return <>{through}</>;
  if (!query.data) {
    return (
      <AppLayout>
        <div className="flex justify-center py-16" data-testid="handle-gate-loading"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden /></div>
      </AppLayout>
    );
  }
  if (query.data.handleChosen === false) return <AppLayout><ChooseHandle /></AppLayout>;
  return <>{through}</>;
}

/** The first-run form: a username (required) and a display name (the username when left empty). Saving lets the person in. */
export function ChooseHandle() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const update = useUpdateProfile();
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [touched, setTouched] = useState(false);

  const wanted = normalizeHandle(handle);
  const problem: HandleProblem | null = handleProblem(wanted);
  const problemText: Record<HandleProblem, string> = {
    empty: t('social.choose.handleEmpty', 'Choose a username to continue.'),
    short: t('social.friends.handleShort', 'A handle has at least 3 characters.'),
    long: t('social.friends.handleLong', 'A handle has at most 24 characters.'),
    characters: t('social.friends.handleCharacters', 'Only the letters a to z, the digits 0 to 9 and _ are allowed.'),
  };
  const liveProblem = problem && (touched || problem !== 'empty') ? problemText[problem] : null;
  const name = displayName.trim();

  const failed = update.isError ? update.error : null;
  const failedField = failed ? profileFieldOf(failed) : null;
  const fieldError = (field: 'handle' | 'displayName') => (failed && failedField === field ? errorText(failed) : null);

  const submit = async () => {
    setTouched(true);
    if (problem) return;
    try {
      await update.mutateAsync({ handle: wanted, displayName: name || wanted });
    } catch {
      /* shown under the field it is about */
    }
  };

  return (
    <div className="flex justify-center px-4 py-10" data-testid="choose-handle">
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="space-y-5 p-6">
          <div className="space-y-2 text-center">
            <AtSign className="mx-auto h-10 w-10 text-primary" aria-hidden />
            <h1 className="text-lg font-semibold">{t('social.choose.title', 'Choose your username')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('social.choose.body', 'This is how other drivers find you and see you on the leaderboards. Your e-mail and your account name are never shown.')}
            </p>
          </div>

          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="choose-handle-input" className="text-sm font-medium">{t('social.choose.handle', 'Username')}</label>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground" aria-hidden>@</span>
                <Input
                  id="choose-handle-input"
                  value={handle}
                  maxLength={26}
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  spellCheck={false}
                  placeholder={t('social.choose.handlePlaceholder', 'speedy_ana')}
                  aria-invalid={fieldError('handle') || liveProblem ? true : undefined}
                  aria-describedby="choose-handle-help choose-handle-live"
                  onChange={(event) => setHandle(event.target.value.toLowerCase())}
                  onBlur={() => wanted && setTouched(true)}
                  data-testid="choose-handle-input"
                />
              </div>
              <p id="choose-handle-help" className="text-xs text-muted-foreground">
                {t('social.choose.handleHelp', '3 to 24 characters: a to z, 0 to 9 and _. You can change it later, 3 times in 30 days.')}
              </p>
              <p id="choose-handle-live" className={cn('text-xs', liveProblem ? 'text-destructive' : 'text-muted-foreground')} role={liveProblem ? 'alert' : undefined} data-testid="choose-handle-live">
                {liveProblem ?? ''}
              </p>
              {fieldError('handle') && <ErrorLine testId="choose-error-handle">{fieldError('handle')}</ErrorLine>}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="choose-name-input" className="text-sm font-medium">{t('social.choose.displayName', 'Display name (optional)')}</label>
              <Input
                id="choose-name-input"
                value={displayName}
                maxLength={DISPLAY_NAME_MAX}
                autoComplete="nickname"
                placeholder={wanted && !problem ? wanted : ''}
                aria-invalid={fieldError('displayName') ? true : undefined}
                aria-describedby="choose-name-help"
                onChange={(event) => setDisplayName(event.target.value)}
                data-testid="choose-name-input"
              />
              <p id="choose-name-help" className="text-xs text-muted-foreground">
                {t('social.choose.displayNameHelp', 'Shown next to your username. Left empty, your username is used.')}
              </p>
              {fieldError('displayName') && <ErrorLine testId="choose-error-displayName">{fieldError('displayName')}</ErrorLine>}
            </div>

            {wanted && !problem && (
              <div className="flex items-center gap-3 rounded-lg border border-dashed border-border p-3" data-testid="choose-preview">
                <Avatar handle={wanted} displayName={name || wanted} size="lg" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{t('social.profile.preview', 'Preview')}</p>
                  <DriverName handle={wanted} displayName={name || wanted} link={false} className="flex-col items-start gap-0" testId="choose-preview-name" />
                </div>
              </div>
            )}

            {failed && !failedField && <ErrorLine testId="choose-error">{errorText(failed)}</ErrorLine>}

            <Button type="submit" className="w-full" disabled={update.isPending} data-testid="choose-save">
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('social.choose.save', 'Continue')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
