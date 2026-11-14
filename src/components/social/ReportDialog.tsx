import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Flag, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { errorCode, REPORT_DETAILS_MAX, REPORT_REASONS, useReport, type ReportReason, type ReportTarget } from '@/lib/sim/social-client';
import { ErrorLine } from './social-bits';
import { atHandle } from './social-utils';
import { useErrorText } from './use-error-text';

type Outcome = 'sent' | 'already' | null;

/**
 * Report a driver or a lap: pick what (when the screen offers both), pick a reason, add details if you want (up to 300 characters),
 * send. One report stays open per person and target, so a second one says "already reported" instead of failing.
 */
export function ReportDialog({ open, onOpenChange, targets }: { open: boolean; onOpenChange: (open: boolean) => void; targets: ReportTarget[] }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const report = useReport();
  const id = useId();
  const [index, setIndex] = useState(0);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [outcome, setOutcome] = useState<Outcome>(null);

  // Every time the dialog opens it starts empty.
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setReason(null);
    setDetails('');
    setOutcome(null);
    report.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reasons: Record<ReportReason, string> = {
    cheating: t('social.report.reasons.cheating', 'Cheating or an impossible time'),
    offensive_name: t('social.report.reasons.offensive_name', 'Offensive name'),
    impersonation: t('social.report.reasons.impersonation', 'Pretending to be someone else'),
    spam: t('social.report.reasons.spam', 'Spam'),
    other: t('social.report.reasons.other', 'Something else'),
  };
  const target = targets[Math.min(index, targets.length - 1)];
  const targetLabel = (entry: ReportTarget) =>
    entry.kind === 'lap' ? t('social.report.targetLap', 'This lap') : t('social.report.targetDriver', 'The driver {{handle}}', { handle: atHandle(entry.handle) });

  const send = async () => {
    if (!target || !reason) return;
    try {
      await report.mutateAsync({ target, reason, details });
      setOutcome('sent');
    } catch (error) {
      if (errorCode(error) === 'already_reported') setOutcome('already');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="report-dialog">
        <DialogHeader>
          <DialogTitle>{t('social.report.title', 'Report')}</DialogTitle>
          <DialogDescription>
            {t('social.report.body', 'Tell us what is wrong. We review every report, and the person is not told who reported them.')}
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <div className="space-y-3" role="status" data-testid={outcome === 'sent' ? 'report-sent' : 'report-already'}>
            <p className="flex items-start gap-2 text-sm">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" aria-hidden />
              {outcome === 'sent'
                ? t('social.report.sent', 'Thank you. Your report was sent and a moderator will look at it.')
                : t('social.report.already', 'You already reported this, and it is still being reviewed. Nothing more to do.')}
            </p>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t('social.common.close', 'Close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {targets.length > 1 && (
              <fieldset className="space-y-1">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('social.report.what', 'What do you want to report?')}</legend>
                {targets.map((entry, i) => (
                  <label key={`${entry.kind}-${i}`} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input type="radio" name={`${id}-target`} checked={i === index} onChange={() => setIndex(i)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                    {targetLabel(entry)}
                  </label>
                ))}
              </fieldset>
            )}
            {targets.length === 1 && target && <p className="text-sm font-medium">{targetLabel(target)}</p>}

            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-medium text-muted-foreground">{t('social.report.reason', 'Reason')}</legend>
              {REPORT_REASONS.map((entry) => (
                <label key={entry} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${id}-reason`}
                    value={entry}
                    checked={reason === entry}
                    onChange={() => setReason(entry)}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                    data-testid={`report-reason-${entry}`}
                  />
                  {reasons[entry]}
                </label>
              ))}
            </fieldset>

            <div className="space-y-1">
              <label htmlFor={`${id}-details`} className="text-xs font-medium text-muted-foreground">
                {t('social.report.details', 'Details (optional)')}
              </label>
              <Textarea
                id={`${id}-details`}
                value={details}
                maxLength={REPORT_DETAILS_MAX}
                onChange={(event) => setDetails(event.target.value)}
                rows={3}
                data-testid="report-details"
              />
              <p className="text-right text-xs text-muted-foreground" data-testid="report-count">{details.length} / {REPORT_DETAILS_MAX}</p>
            </div>

            {report.isError && errorCode(report.error) !== 'already_reported' && <ErrorLine testId="report-error">{errorText(report.error)}</ErrorLine>}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
              <Button type="submit" disabled={!reason || report.isPending} data-testid="report-send">
                {report.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('social.report.send', 'Send report')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A small flag button that opens the report dialog for these targets (the person picks which when there are two). */
export function ReportButton({ targets, label, className }: { targets: ReportTarget[]; label?: string; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const text = label ?? t('social.report.button', 'Report');
  return (
    <>
      <Button type="button" size="icon" variant="ghost" className={className ?? 'h-8 w-8'} aria-label={text} title={text} onClick={() => setOpen(true)} data-testid="report-button">
        <Flag className="h-4 w-4" />
      </Button>
      <ReportDialog open={open} onOpenChange={setOpen} targets={targets} />
    </>
  );
}
