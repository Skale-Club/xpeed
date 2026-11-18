import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/contexts/AuthContext';
import { useAdminStatus } from '@/hooks/use-admin-status';
import {
  isAiApiKey, isAiModelId, listAiAccounts, requestAiPreference,
  type AiAccount, type AiPreferenceAction, type AiPreferenceStatus, type AiProviderMode,
} from '@/lib/ai-preferences';
import { DEMO_USER_ID, isDemoMode, useDemoMode } from '@/lib/sim/demo/mode';

export function AccountAIProviderSection() {
  const { user, loading } = useAuth();
  const demo = useDemoMode();
  if (loading || !user || demo || user.id === DEMO_USER_ID) return null;
  return <AdminProviderCard key={user.id} actorId={user.id} />;
}

function AdminProviderCard({ actorId }: { actorId: string }) {
  const { isAdmin, loading } = useAdminStatus();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (loading || !isAdmin) return null;
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <details onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm font-semibold">
            <Bot className="mx-2 inline h-5 w-5 text-primary" aria-hidden="true" />
            {t('settings.ai.title')}
          </summary>
          {open && <AccountPicker actorId={actorId} />}
        </details>
      </CardContent>
    </Card>
  );
}

function accountLabel({ id, name, email }: AiAccount) {
  return [name, email === name ? null : email].filter(Boolean).join(' · ') || id;
}

function AccountPicker({ actorId }: { actorId: string }) {
  const { t } = useTranslation();
  const pickerId = useId();
  const [accounts, setAccounts] = useState<AiAccount[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [targetId, setTargetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const load = useCallback(async (cursor?: string) => {
    if (pending.current || isDemoMode()) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const page = await listAiAccounts(actorId, cursor, controller.signal);
      if (controller.signal.aborted || isDemoMode()) return;
      setAccounts((previous) => {
        if (!cursor || !previous) return page.accounts;
        const seen = new Set(previous.map((account) => account.id));
        return [...previous, ...page.accounts.filter((account) => !seen.has(account.id))];
      });
      setNextCursor(page.nextCursor === cursor ? null : page.nextCursor);
    } catch {
      if (!controller.signal.aborted && !isDemoMode()) setFailed(true);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!isDemoMode()) setLoading(false);
      }
    }
  }, [actorId]);

  useEffect(() => { void load(); }, [load]);

  const target = accounts?.find((account) => account.id === targetId);
  return (
    <div className="space-y-3 pt-3">
      <p className="text-sm text-muted-foreground">{t('settings.ai.appliesTo')}</p>
      {!!accounts?.length && (
        <div className="space-y-1.5">
          <Label htmlFor={pickerId}>{t('settings.ai.account')}</Label>
          <select id={pickerId} value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="">{t('settings.ai.selectAccount')}</option>
            {accounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </div>
      )}
      {accounts && !accounts.length && <p className="text-sm text-muted-foreground">{t('settings.ai.noAccounts')}</p>}
      {loading && <p className="text-sm text-muted-foreground" role="status">{t('common.loading', 'Loading…')}</p>}
      {failed && <p className="text-sm text-destructive" role="alert">{t('settings.ai.accountLoadError')}</p>}
      {nextCursor && (
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void load(nextCursor)}>
          {t('settings.ai.loadMoreAccounts')}
        </Button>
      )}
      {failed && !accounts && (
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('settings.ai.retry')}</Button>
      )}
      {target && <ProviderForm key={target.id} actorId={actorId} target={target} />}
    </div>
  );
}

function ProviderForm({ actorId, target }: { actorId: string; target: AiAccount }) {
  const { t } = useTranslation();
  const targetAccountId = target.id;
  const fieldId = useId();
  const [status, setStatus] = useState<AiPreferenceStatus | null>(null);
  const [mode, setMode] = useState<AiProviderMode>('global');
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(true);
  const [feedback, setFeedback] = useState<'error' | 'saved' | 'deleted' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const perform = useCallback(async (input: AiPreferenceAction) => {
    if (pending.current || isDemoMode()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await requestAiPreference(actorId, input, controller.signal);
      if (controller.signal.aborted || isDemoMode()) return;
      setStatus(next);
      setMode(next.mode);
      setModel(next.model ?? next.globalModel);
      setKey('');
      if (input.action !== 'status') setFeedback(input.action === 'save' ? 'saved' : 'deleted');
    } catch {
      if (!controller.signal.aborted && !isDemoMode()) setFeedback('error');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (!isDemoMode()) setBusy(false);
      }
    }
  }, [actorId]);

  useEffect(() => { void perform({ action: 'status', targetAccountId }); }, [perform, targetAccountId]);

  if (!status) {
    return (
      <div className="pt-3 text-sm text-muted-foreground">
        {busy && <p role="status">{t('common.loading', 'Loading…')}</p>}
        {feedback === 'error' && (
          <>
            <p role="alert">{t('settings.ai.loadError')}</p>
            <Button className="mt-2" size="sm" variant="outline" onClick={() => void perform({ action: 'status', targetAccountId })}>
              {t('settings.ai.retry')}
            </Button>
          </>
        )}
      </div>
    );
  }

  const cleanKey = key.trim();
  const cleanModel = model.trim();
  const personal = mode === 'personal';
  const dirty = mode !== status.mode || (personal && (cleanModel !== status.model || Boolean(cleanKey)));
  const personalValid = status.canSaveKey && isAiModelId(cleanModel)
    && (cleanKey ? isAiApiKey(cleanKey) : status.keyConfigured);
  const canSave = !busy && dirty && (!personal || personalValid);
  const keyHint = status.keyConfigured ? 'settings.ai.replaceKeyHint' : 'settings.ai.keyHint';

  const save = () => {
    if (!canSave) return;
    void perform(personal
      ? { action: 'save', mode: 'personal', targetAccountId, model: cleanModel, ...(cleanKey ? { apiKey: cleanKey } : {}) }
      : { action: 'save', mode: 'global', targetAccountId });
  };

  return (
    <form className="space-y-4 border-t border-border pt-3" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); save(); }}>
      <p className="text-sm font-medium">{t(status.mode === 'personal' ? 'settings.ai.activePersonal' : 'settings.ai.activeGlobal')}</p>
      <fieldset disabled={busy} className="space-y-2">
        <legend className="text-sm font-medium">{t('settings.ai.billingSource')}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input className="mt-1 accent-primary" type="radio" name={fieldId} value="global" checked={!personal}
            aria-labelledby={`${fieldId}-global-label`}
            aria-describedby={`${fieldId}-global-hint`} onChange={() => { setMode('global'); setKey(''); }} />
          <span>
            <span id={`${fieldId}-global-label`}>{t('settings.ai.global')}</span>
            <span className="block text-muted-foreground" id={`${fieldId}-global-hint`}>{t('settings.ai.globalHint')}</span>
            {!status.globalConfigured && <span className="block text-muted-foreground">{t('settings.ai.globalUnavailable')}</span>}
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input className="mt-1 accent-primary" type="radio" name={fieldId} value="personal" checked={personal}
            aria-labelledby={`${fieldId}-personal-label`}
            aria-describedby={`${fieldId}-personal-hint`} onChange={() => setMode('personal')} />
          <span>
            <span id={`${fieldId}-personal-label`}>{t('settings.ai.personal')}</span>
            <span className="block text-muted-foreground" id={`${fieldId}-personal-hint`}>{t('settings.ai.personalHint')}</span>
          </span>
        </label>
      </fieldset>

      {!status.canSaveKey && <p className="text-sm text-muted-foreground" role="status">{t('settings.ai.storageUnavailable')}</p>}
      {personal && (
        <fieldset disabled={busy || !status.canSaveKey} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-model`}>{t('settings.ai.model')}</Label>
            <Input id={`${fieldId}-model`} value={model} onChange={(event) => setModel(event.target.value)}
              autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={200} required
              aria-describedby={`${fieldId}-model-hint`} aria-invalid={Boolean(cleanModel) && !isAiModelId(cleanModel)} />
            <p className="text-sm text-muted-foreground" id={`${fieldId}-model-hint`}>{t('settings.ai.modelHint')}</p>
            {cleanModel && !isAiModelId(cleanModel) && <p className="text-sm text-destructive">{t('settings.ai.invalidModel')}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-key`}>{t('settings.ai.apiKey')}</Label>
            <Input id={`${fieldId}-key`} type="password" value={key} onChange={(event) => setKey(event.target.value)}
              autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={512} required={!status.keyConfigured}
              aria-describedby={`${fieldId}-key-hint`} aria-invalid={Boolean(cleanKey) && !isAiApiKey(cleanKey)} />
            <p className="text-sm text-muted-foreground" id={`${fieldId}-key-hint`}>{t(keyHint)}</p>
            {cleanKey && !isAiApiKey(cleanKey) && <p className="text-sm text-destructive">{t('settings.ai.invalidKey')}</p>}
          </div>
        </fieldset>
      )}

      {status.keyConfigured && (
        <p className="text-sm text-muted-foreground">
          {status.keyLast4 ? t('settings.ai.keyEnding', { last4: status.keyLast4 }) : t('settings.ai.keySaved')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={!canSave}>{t(busy ? 'settings.saving' : 'settings.ai.save')}</Button>
        {status.keyConfigured && (
          <Button size="sm" type="button" variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
            {t('settings.ai.remove')}
          </Button>
        )}
      </div>
      {feedback === 'error' && <p role="alert" className="text-sm text-destructive">{t('settings.ai.changeError')}</p>}
      {feedback && feedback !== 'error' && <p role="status" className="text-sm">{t(`settings.ai.${feedback}`)}</p>}
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title={t('settings.ai.confirmRemoveTitle')}
        description={t('settings.ai.confirmRemoveBody', { account: accountLabel(target) })} confirmLabel={t('settings.ai.remove')}
        onConfirm={() => void perform({ action: 'delete', targetAccountId })} />
    </form>
  );
}
