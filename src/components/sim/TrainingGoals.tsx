import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatAppDate } from '@/lib/app-date';
import { DEMO_USER_ID, isDemoMode, useDemoMode } from '@/lib/sim/demo/mode';
import { sessionPath } from '@/lib/sim/routes';
import {
  createTrainingGoal, deleteTrainingGoal, listTrainingGoals, setTrainingGoalStatus, TrainingRequestError,
  type TrainingFailure,
} from '@/lib/sim/training-client';
import {
  parseTrainingTarget, TRAINING_METRICS, type TrainingGoal, type TrainingGoalDraft, type TrainingGoalList,
  type TrainingMeasurement, type TrainingMetric, type TrainingStatus,
} from '@/lib/sim/training-types';
import { useConditions } from './use-session-text';

interface TrainingGoalsProps {
  userId: string;
  sessionId: string;
}

const trainingLabel = (key: string) => `modes.training.${key}`;
const initialDraft = { title: '', notes: '', metric: 'best_lap_ms' as TrainingMetric, targetText: '' };
type PendingWrite = (signal: AbortSignal) => Promise<unknown>;

export default function TrainingGoals(props: TrainingGoalsProps) {
  const demo = useDemoMode();
  if (demo || !props.userId || props.userId === DEMO_USER_ID) return null;
  return <TrainingPanel key={`${props.userId}:${props.sessionId}`} {...props} />;
}

function TrainingPanel({ userId, sessionId }: TrainingGoalsProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const fieldId = useId();
  const [list, setList] = useState<TrainingGoalList | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(initialDraft);
  const [editing, setEditing] = useState(false);
  const [deleteGoal, setDeleteGoal] = useState<TrainingGoal | null>(null);
  const [error, setError] = useState<TrainingFailure | 'refresh' | null>(null);
  const [notice, setNotice] = useState<'goalCreated' | 'goalUpdated' | 'goalDeleted' | null>(null);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const run = useCallback(async (
    write?: PendingWrite,
    success?: 'goalCreated' | 'goalUpdated' | 'goalDeleted',
  ) => {
    if (pending.current || isDemoMode()) return;
    const controller = new AbortController();
    const { signal } = controller;
    pending.current = controller;
    const current = () => !signal.aborted && !isDemoMode();
    let committed = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (write) {
        await write(signal);
        if (!current()) return;
        committed = true;
        setStale(true);
        if (success === 'goalCreated') {
          setEditing(false);
          setDraft(initialDraft);
        }
      }
      const next = await listTrainingGoals(userId, sessionId, signal);
      if (!current()) return;
      setList(next);
      setStale(false);
      if (success) setNotice(success);
    } catch (cause) {
      if (!current()) return;
      setError(committed ? 'refresh' : cause instanceof TrainingRequestError ? cause.kind : 'unavailable');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (current()) setLoading(false);
      }
    }
  }, [userId, sessionId]);

  useEffect(() => { void run(); }, [run]);

  const target = parseTrainingTarget(draft.metric, draft.targetText);
  const atLimit = Boolean(list && list.goals.length >= list.limit);
  const disabled = loading || stale;
  const save = () => {
    const title = draft.title.trim();
    if (disabled || atLimit || !title || title.length > 120 || draft.notes.length > 1000 || target === null) return;
    const input: TrainingGoalDraft = { title, notes: draft.notes, metric: draft.metric, target };
    void run((signal) => createTrainingGoal(userId, sessionId, input, signal), 'goalCreated');
  };
  const changeStatus = (goal: TrainingGoal, status: TrainingStatus) => {
    void run((signal) => setTrainingGoalStatus(userId, goal.id, status, signal), 'goalUpdated');
  };
  const remove = () => {
    if (deleteGoal) void run((signal) => deleteTrainingGoal(userId, deleteGoal.id, signal), 'goalDeleted');
  };
  const isPercent = draft.metric === 'valid_lap_pct';

  return (
    <section aria-labelledby={headingId} className="space-y-4 border-t border-border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id={headingId} className="text-base font-semibold">{t(trainingLabel('title'))}</h3>
          <p className="text-sm text-muted-foreground">{t(trainingLabel('intro'))}</p>
        </div>
        {list && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void run()}>
              {t(trainingLabel('refresh'))}
            </Button>
            {!editing && (
              <Button type="button" size="sm" variant="outline" disabled={disabled || atLimit}
                onClick={() => { setEditing(true); setError(null); setNotice(null); }}>
                {t(trainingLabel('add'))}
              </Button>
            )}
          </div>
        )}
      </div>

      {loading && <p role="status" className="text-sm text-muted-foreground">{t('common.loading', 'Loading…')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t(trainingLabel(`error.${error}`))}</p>}
      {error && !list && (
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void run()}>{t(trainingLabel('retry'))}</Button>
      )}
      {notice && <p role="status" className="text-sm">{t(trainingLabel(notice))}</p>}
      {list && (atLimit || list.truncated) && (
        <p className="text-sm text-muted-foreground">{t(trainingLabel('limit'), { limit: list.limit })}</p>
      )}

      {editing && (
        <form className="rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <fieldset disabled={disabled} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-title`}>{t(trainingLabel('goalTitle'))}</Label>
              <Input id={`${fieldId}-title`} required maxLength={120} value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-metric`}>{t(trainingLabel('metric'))}</Label>
                <select id={`${fieldId}-metric`} value={draft.metric}
                  className="h-11 w-full rounded-xl border border-input bg-background/60 px-3.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
                  onChange={(event) => setDraft({ ...draft, metric: event.target.value as TrainingMetric, targetText: '' })}>
                  {TRAINING_METRICS.map((metric) => <option key={metric} value={metric}>{t(trainingLabel(`metrics.${metric}`))}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-target`}>{t(trainingLabel(isPercent ? 'targetPercent' : 'targetSeconds'))}</Label>
                <Input id={`${fieldId}-target`} required inputMode="decimal" maxLength={12} value={draft.targetText}
                  aria-describedby={`${fieldId}-target-help`} aria-invalid={Boolean(draft.targetText.trim()) && target === null}
                  onChange={(event) => setDraft({ ...draft, targetText: event.target.value })} />
                <p id={`${fieldId}-target-help`} className="text-xs text-muted-foreground">
                  {t(trainingLabel(`targetHint.${draft.metric}`))}
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-notes`}>{t(trainingLabel('notes'))}</Label>
              <Textarea id={`${fieldId}-notes`} rows={2} maxLength={1000} value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" type="submit" disabled={atLimit || !draft.title.trim() || target === null}>{t(trainingLabel('save'))}</Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => { setEditing(false); setDraft(initialDraft); setError(null); }}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </div>
          </fieldset>
        </form>
      )}

      {list && !list.goals.length && !editing && <p className="text-sm text-muted-foreground">{t(trainingLabel('empty'))}</p>}
      {!!list?.goals.length && (
        <>
          <ul className="space-y-3">
            {list.goals.map((goal) => <GoalRow key={goal.id} goal={goal} disabled={disabled} onStatus={changeStatus} onDelete={setDeleteGoal} />)}
          </ul>
          <p className="text-sm text-muted-foreground">{t(trainingLabel('comparisonCaveat'))}</p>
        </>
      )}

      <ConfirmDialog open={deleteGoal !== null} onOpenChange={(open) => { if (!open) setDeleteGoal(null); }}
        title={t(trainingLabel('confirmDeleteTitle'))} description={t(trainingLabel('confirmDeleteBody'), { title: deleteGoal?.title ?? '' })}
        confirmLabel={t(trainingLabel('delete'))} onConfirm={remove} />
    </section>
  );
}

function useTrainingAmount() {
  const { t, i18n } = useTranslation();
  return (metric: TrainingMetric, amount: number | null, delta = false) => {
    if (amount === null) return t(trainingLabel('unmeasured'));
    const rate = metric === 'valid_lap_pct';
    const formatted = new Intl.NumberFormat(i18n.resolvedLanguage || 'en', {
      maximumFractionDigits: rate ? 10 : 3,
      signDisplay: delta && amount !== 0 ? 'always' : 'auto',
    }).format(rate ? amount : amount / 1000);
    const unit = !rate ? 'seconds' : delta ? 'points' : 'percent';
    return t(trainingLabel(`units.${unit}`), { value: formatted });
  };
}

function GoalRow({ goal, disabled, onStatus, onDelete }: {
  goal: TrainingGoal;
  disabled: boolean;
  onStatus: (goal: TrainingGoal, status: TrainingStatus) => void;
  onDelete: (goal: TrainingGoal) => void;
}) {
  const { t } = useTranslation();
  const amount = useTrainingAmount();
  const active = goal.status === 'active';
  return (
    <li className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 break-words text-sm font-semibold">{goal.title}</h4>
        <Badge variant="outline">{t(trainingLabel(`status.${goal.status}`))}</Badge>
      </div>
      <p className="text-sm">
        {t(trainingLabel('goalTarget'), { metric: t(trainingLabel(`metrics.${goal.metric}`)), target: amount(goal.metric, goal.target) })}
      </p>
      {goal.notes && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{goal.notes}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        <Measurement metric={goal.metric} label="baseline" measurement={goal.baseline} />
        {goal.latest
          ? <Measurement metric={goal.metric} label="latest" measurement={goal.latest} />
          : <div className="rounded-md bg-muted/30 p-2.5 text-sm"><p className="font-medium">{t(trainingLabel('latest'))}</p>
            <p className="text-muted-foreground">{t(trainingLabel('noFollowup'))}</p></div>}
      </div>
      {goal.delta !== null && <p className="text-sm">{t(trainingLabel('delta'), { value: amount(goal.metric, goal.delta, true) })}</p>}
      {goal.reached !== null && <p className="text-sm font-medium">{t(trainingLabel(goal.reached ? 'targetReached' : 'targetPending'))}</p>}
      <div className="flex flex-wrap gap-2">
        {active
          ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onStatus(goal, 'completed')}>{t(trainingLabel('complete'))}</Button>
          : <Button size="sm" variant="outline" disabled={disabled} onClick={() => onStatus(goal, 'active')}>{t(trainingLabel('reopen'))}</Button>}
        {goal.status !== 'archived' && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onStatus(goal, 'archived')}>{t(trainingLabel('archive'))}</Button>
        )}
        <Button size="sm" variant="ghost" className="text-destructive" disabled={disabled} onClick={() => onDelete(goal)}>
          {t(trainingLabel('delete'))}
        </Button>
      </div>
    </li>
  );
}

function Measurement({ metric, label, measurement }: {
  metric: TrainingMetric;
  label: 'baseline' | 'latest';
  measurement: TrainingMeasurement;
}) {
  const { t, i18n } = useTranslation();
  const amount = useTrainingAmount();
  const conditions = useConditions()(measurement);
  const kind = ['practice', 'qualifying', 'race'].includes(measurement.kind)
    ? t(`modes.sessions.kind.${measurement.kind}`) : t(trainingLabel('unknownKind'));
  const date = new Date(measurement.startedAt);
  const timestamp = Number.isFinite(date.getTime()) ? formatAppDate(date, i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }) : null;
  return (
    <div className="space-y-1 rounded-md bg-muted/30 p-2.5 text-sm">
      <Link className="font-medium text-primary underline-offset-2 hover:underline" to={sessionPath(measurement.sessionId)}>
        {t(trainingLabel(label))}
      </Link>
      <p className="text-xs text-muted-foreground">
        {kind}{timestamp && <> · <time dateTime={measurement.startedAt}>{timestamp}</time></>}
      </p>
      <p className="font-mono tabular-nums">{amount(metric, measurement.value)}</p>
      <p className="text-xs text-muted-foreground">
        {t(trainingLabel('coverage'), { usable: measurement.lapsUsed, clean: measurement.cleanLaps, total: measurement.totalLaps })}
      </p>
      <p className="break-words text-xs text-muted-foreground">{conditions || t(trainingLabel('unknownConditions'))}</p>
      {measurement.partial && <p className="text-xs font-medium">{t(trainingLabel('partial'))}</p>}
    </div>
  );
}
