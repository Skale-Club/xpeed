import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { setCompanionCoachPermission } from '@/lib/sim/companion-coach';
import { isDemoMode, useDemoMode } from '@/lib/sim/demo/mode';

export function DeviceCoachPermission({ accountId, deviceId, allowed, onChanged }: {
  accountId: string; deviceId: string; allowed: boolean; onChanged: () => void;
}) {
  const demo = useDemoMode();
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(allowed);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => setEnabled(allowed), [allowed]);
  useLayoutEffect(() => {
    setConfirm(false); setBusy(false); setFailed(false);
    return () => { pending.current?.abort(); pending.current = null; };
  }, [accountId, deviceId, demo]);
  const change = async (next: boolean) => {
    if (pending.current || demo || isDemoMode()) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setFailed(false);
    try {
      const saved = await setCompanionCoachPermission(accountId, deviceId, next, controller.signal);
      if (controller.signal.aborted || isDemoMode()) return;
      setEnabled(saved); onChanged();
    } catch { if (!controller.signal.aborted && !isDemoMode()) setFailed(true); }
    finally { if (pending.current === controller) { pending.current = null; if (!controller.signal.aborted) setBusy(false); } }
  };
  if (demo) return null;
  return <div className="space-y-2 border-t border-border pt-3">
    <p className="text-sm font-medium">{t('modes.deviceCoach.title')}</p>
    <p className="text-xs text-muted-foreground">{t(enabled ? 'modes.deviceCoach.on' : 'modes.deviceCoach.off')}</p>
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => enabled ? void change(false) : setConfirm(true)}>
      {t(enabled ? 'modes.deviceCoach.disable' : 'modes.deviceCoach.enable')}
    </Button>
    {failed && <p role="alert" className="text-xs text-destructive">{t('modes.deviceCoach.failed')}</p>}
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={t('modes.deviceCoach.confirmTitle')}
      description={t('modes.deviceCoach.confirmBody')} confirmLabel={t('modes.deviceCoach.enable')} onConfirm={() => void change(true)} />
  </div>;
}
