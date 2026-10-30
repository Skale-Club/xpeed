import { queryClient } from '@/lib/query-client';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarClock, CheckCircle2, History, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToastAction } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { notifyProblemsChanged, useVehicleIssues } from '@/hooks/use-open-problems';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import { ignoreIssue, reopenIssue, resolveIssue, type VehicleIssue } from '@/lib/db-issues';
import { AI_PREFIX, CODE_GONE_NOTE, URGENCY, URGENCY_ORDER, describeProblem, isOpenProblem, type Urgency } from '@/lib/problems';
import { formatAppDate } from '@/lib/app-date';
import { timeAgo } from '@/lib/time-ago';
import { ReadCodesButton } from '@/components/ReadCodesButton';

const URGENCY_STYLE: Record<Urgency, string> = {
  urgent: 'bg-destructive/15 text-destructive border-destructive/30',
  soon: 'bg-warn/15 text-warn border-warn/30',
  watch: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
  later: 'bg-muted text-muted-foreground border-border',
};

const URGENCY_DEFAULT: Record<Urgency, string> = {
  urgent: 'Urgent',
  soon: 'Book a check-up',
  watch: 'Keep an eye on it',
  later: 'Can wait',
};

type Action = 'resolve' | 'ignore' | 'reopen';

export default function IssuesPage() {
  const { t, i18n } = useTranslation();
  const { selectedCar } = useCarsContext();
  const { toast } = useToast();
  const query = useVehicleIssues(selectedCar?.id);
  const issues = query.data ?? [];
  const loading = query.isPending;
  const loadFailed = query.isError;
  const load = query.refetch;
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [confirmIgnore, setConfirmIgnore] = useState<VehicleIssue | null>(null);
  const { hash } = useLocation();
  const requested = issues.find(issue => hash === `#issue-${encodeURIComponent(issue.id)}`);
  const requestedId = requested?.id, requestedStatus = requested?.status;
  useEffect(() => {
    if (requestedStatus) setTab(requestedStatus === 'active' || requestedStatus === 'recurred' ? 'open' : 'closed');
  }, [requestedId, requestedStatus]);
  useEffect(() => {
    if (!requestedId || !requestedStatus || (tab === 'open') !== (requestedStatus === 'active' || requestedStatus === 'recurred')) return;
    const card = document.getElementById(`issue-${requestedId}`);
    card?.scrollIntoView?.({ block: 'center' });
    card?.focus({ preventScroll: true });
  }, [requestedId, requestedStatus, tab]);

  // "28 Oct, 13:39"; the year only when it isn't this year.
  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return formatAppDate(date, i18n.resolvedLanguage || undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    });
  };


  const act = async (issue: VehicleIssue, action: Action) => {
    setActingOn(issue.id);
    try {
      if (action === 'resolve') await resolveIssue(issue.id);
      else if (action === 'ignore') await ignoreIssue(issue.id);
      else await reopenIssue(issue.id);
      queryClient.setQueryData<VehicleIssue[]>(['vehicle-issues',selectedCar?.id], previous => previous?.map(item => item.id === issue.id ? {...item, status:action === 'resolve' ? 'resolved' : action === 'ignore' ? 'ignored' : 'active',resolved_at:action === 'resolve' ? new Date().toISOString() : action === 'reopen' ? null : item.resolved_at} : item));
      // The home card and the tab-bar badge show the same list.
      notifyProblemsChanged();
      if (action !== 'reopen') {
        toast({
          title: action === 'resolve' ? t('problems.markedFixed', 'Marked as fixed') : t('problems.markedIgnored', 'Problem ignored'),
          variant: 'success',
          action: (
            <ToastAction altText={t('problems.undo', 'Undo')} onClick={() => void act(issue, 'reopen')}>
              {t('problems.undo', 'Undo')}
            </ToastAction>
          ),
        });
      }
    } catch (err) {
      console.error(err);
      toast({ title: t('problems.actionFailed', "Couldn't save that change"), variant: 'destructive' });
    } finally {
      setActingOn(null);
    }
  };

  // Ignoring something urgent is the one change worth a second thought.
  const requestAct = (issue: VehicleIssue, action: Action) => {
    if (action === 'ignore' && URGENCY[issue.severity] === 'urgent') setConfirmIgnore(issue);
    else void act(issue, action);
  };

  const open = issues.filter(isOpenProblem);
  const closed = issues.filter((i) => !isOpenProblem(i));
  const mostUrgent = URGENCY_ORDER.find((u) => open.some((i) => URGENCY[i.severity] === u));

  if (!selectedCar) {
    return (
      <AppLayout>
        <p className="text-sm text-muted-foreground">{t('problems.noCar', 'Choose a car in the menu to see its problems.')}</p>
      </AppLayout>
    );
  }

  const shown = tab === 'open' ? open : closed;

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-5">
        <div>
          <h2 className="text-xl font-bold">{t('problems.title', 'Problems')}</h2>
          <p className="text-sm text-muted-foreground">{selectedCar.name}</p>
        </div>
        <ReadCodesButton />

        {loadFailed && (
          <Card className="border-destructive/40" role="alert">
            <CardContent className="p-4 flex flex-wrap items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-destructive shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold">{t('problems.checkFailed', "Couldn't check your car")}</p>
                <p className="text-sm text-muted-foreground">{t('problems.checkFailedHint', 'Check your connection and try again.')}</p>
              </div>
              <Button variant="outline" onClick={() => void load()}>
                <RotateCcw className="w-4 h-4 mr-2" /> {t('problems.retry', 'Try again')}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* One-line answer to "is my car OK?" — only once the list has loaded */}
        {!loading && !loadFailed && (
          <Card className={open.length ? 'border-warn/40' : 'border-success/40'}>
            <CardContent className="p-4 flex items-center gap-3">
              {open.length === 0
                ? <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
                : <AlertTriangle className={`w-6 h-6 shrink-0 ${mostUrgent === 'urgent' ? 'text-destructive' : 'text-warn'}`} />}
              <div>
                <p className="font-semibold">
                  {open.length === 0
                    ? t('problems.allGood', 'No saved problems')
                    : t('problems.needAttention', { count: open.length, defaultValue: '{{count}} problems need attention' })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {open.length === 0
                    ? t('problems.allGoodHint', 'No problems have been saved for this car. This is not a fresh check of the car.')
                    : mostUrgent === 'urgent'
                      ? t('problems.urgentHint', 'At least one is urgent — see what to do below.')
                      : t('problems.notUrgentHint', 'Nothing urgent. See what to do below.')}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {!loadFailed && (
          <div className="flex gap-1 border-b border-border" role="tablist" aria-label={t('problems.title', 'Problems')}>
            {(['open', 'closed'] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`problems-tab-${key}`}
                aria-selected={tab === key}
                aria-controls="problems-panel"
                onClick={() => setTab(key)}
                className={`px-3 py-2.5 text-sm border-b-2 -mb-px ${tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {key === 'open' ? t('problems.tabOpen', 'Need attention') : t('problems.tabClosed', 'Resolved or ignored')}
                {!loading && <span className="ml-1.5 text-xs text-muted-foreground">{key === 'open' ? open.length : closed.length}</span>}
              </button>
            ))}
          </div>
        )}

        {loadFailed ? null : loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center" role="tabpanel" id="problems-panel" aria-labelledby={`problems-tab-${tab}`}>
            {tab === 'open' ? t('problems.emptyOpen', 'No problems here.') : t('problems.emptyClosed', 'Nothing resolved or ignored yet.')}
          </p>
        ) : (
          <div className="space-y-3" role="tabpanel" id="problems-panel" aria-labelledby={`problems-tab-${tab}`}>
            {[...shown]
              .sort((a, b) => URGENCY_ORDER.indexOf(URGENCY[a.severity]) - URGENCY_ORDER.indexOf(URGENCY[b.severity]))
              .map((issue) => (
                <ProblemCard
                  key={issue.id}
                  issue={issue}
                  acting={actingOn === issue.id}
                  formatDate={formatDate}
                  onAct={(a) => requestAct(issue, a)}
                />
              ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!confirmIgnore}
        onOpenChange={(o) => { if (!o) setConfirmIgnore(null); }}
        title={t('problems.ignoreUrgentTitle', 'Ignore an urgent problem?')}
        description={t('problems.ignoreUrgentBody', 'This one needs attention soon. If you ignore it, we stop reminding you. You can bring it back from the "Resolved or ignored" tab.')}
        confirmLabel={t('problems.ignore', 'Ignore')}
        onConfirm={() => { if (confirmIgnore) void act(confirmIgnore, 'ignore'); setConfirmIgnore(null); }}
      />
    </AppLayout>
  );
}

function ProblemCard({ issue, acting, formatDate, onAct }: {
  issue: VehicleIssue;
  acting: boolean;
  formatDate: (iso: string) => string;
  onAct: (action: Action) => void;
}) {
  const { t, i18n } = useTranslation();
  const ago = (iso: string) => timeAgo(iso, i18n.resolvedLanguage);
  const text = describeProblem(issue, t);
  const urgency = URGENCY[issue.severity] ?? 'soon';
  const isOpen = isOpenProblem(issue);

  return (
    <Card id={`issue-${issue.id}`} tabIndex={-1} className={`${isOpen ? '' : 'opacity-70'} target:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none scroll-mt-20`} data-testid="problem-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${URGENCY_STYLE[urgency]}`}>
            {t(`problems.urgency.${urgency}`, URGENCY_DEFAULT[urgency])}
          </span>
          {issue.status === 'recurred' && (
            <span className="text-xs text-warn">{t('problems.cameBack', { count: issue.recurrence_count, defaultValue: 'Came back after being fixed ({{count}}×)' })}</span>
          )}
          {issue.canonical_key.startsWith(AI_PREFIX) && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Sparkles className="w-3 h-3" /> {t('problems.aiBadge', 'AI warning')}
            </span>
          )}
          {issue.status === 'resolved' && (
            <span className="text-xs text-success">
              {issue.resolved_note === CODE_GONE_NOTE
                ? t('problems.codeGone', 'Resolved: the car no longer reports this code')
                : issue.resolved_at
                  ? t('problems.resolvedAgo', 'Resolved {{ago}}', { ago: ago(issue.resolved_at) })
                  : t('problems.resolved', 'Resolved')}
            </span>
          )}
          {issue.status === 'ignored' && <span className="text-xs text-muted-foreground">{t('problems.ignored', 'Ignored')}</span>}
        </div>

        <div>
          <h3 className="font-semibold">{text.title}</h3>
          <p className="text-sm text-muted-foreground">{text.meaning}</p>
        </div>

        <div className="rounded-md bg-muted/40 p-3">
          <p className="text-xs font-medium mb-0.5">{t('problems.whatToDo', 'What to do')}</p>
          <p className="text-sm">{text.action}</p>
        </div>

        {/* When it started and when it was last seen: how long the owner has had it. */}
        <div className="grid grid-cols-2 gap-2" data-testid="problem-dates">
          <ProblemDate
            icon={<CalendarClock className="w-3.5 h-3.5" />}
            label={t('problems.appeared', 'Appeared')}
            ago={ago(issue.first_seen_at)}
            date={formatDate(issue.first_seen_at)}
          />
          <ProblemDate
            icon={<History className="w-3.5 h-3.5" />}
            label={t('problems.lastSeen', 'Last seen')}
            ago={ago(issue.last_seen_at)}
            date={formatDate(issue.last_seen_at)}
          />
        </div>
        {issue.last_session_id && (
          <Link to={`/session/${issue.last_session_id}`} className="inline-block text-sm text-primary hover:underline">
            {t('problems.viewTrip', 'View the trip')}
          </Link>
        )}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{t('problems.forMechanic', 'For the mechanic')}</summary>
          <p className="mt-1 font-mono">{text.code}{text.technical && text.technical !== text.code ? ` — ${text.technical}` : ''}</p>
        </details>

        <div className="flex flex-wrap gap-2">
          {isOpen ? (
            <>
              <Button size="sm" variant="outline" disabled={acting} onClick={() => onAct('resolve')}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" /> {t('problems.markResolved', "It's fixed")}
              </Button>
              <Button size="sm" variant="ghost" disabled={acting} onClick={() => onAct('ignore')}>
                {t('problems.ignore', 'Ignore')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={acting} onClick={() => onAct('reopen')}>
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" /> {t('problems.reopen', 'Reopen')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ProblemDate({ icon, label, ago, date }: { icon: ReactNode; label: string; ago: string; date: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/50 px-3 py-2">
      <p className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{icon} {label}</p>
      <p className="mt-0.5 text-base font-semibold first-letter:uppercase">{ago}</p>
      <p className="text-xs text-muted-foreground">{date}</p>
    </div>
  );
}
