import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, RotateCcw, Loader2 } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import { getIssuesForCar, ignoreIssue, reopenIssue, resolveIssue, type VehicleIssue } from '@/lib/db-issues';
import { CODE_GONE_NOTE, URGENCY, URGENCY_ORDER, describeProblem, isOpenProblem, type Urgency } from '@/lib/problems';

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

export default function IssuesPage() {
  const { t, i18n } = useTranslation();
  const { selectedCar } = useCarsContext();
  const { toast } = useToast();
  const [issues, setIssues] = useState<VehicleIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [actingOn, setActingOn] = useState<string | null>(null);

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(i18n.resolvedLanguage || undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  const carId = selectedCar?.id;
  const load = useCallback(async () => {
    if (!carId) return;
    setLoading(true);
    try {
      setIssues(await getIssuesForCar(carId));
    } catch (err) {
      console.error(err);
      toast({ title: t('problems.loadFailed', "Couldn't load the problems"), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [carId, t, toast]);

  useEffect(() => { void load(); }, [load]);

  const act = async (issue: VehicleIssue, action: 'resolve' | 'ignore' | 'reopen') => {
    setActingOn(issue.id);
    try {
      if (action === 'resolve') await resolveIssue(issue.id);
      else if (action === 'ignore') await ignoreIssue(issue.id);
      else await reopenIssue(issue.id);
      const status = action === 'resolve' ? 'resolved' : action === 'ignore' ? 'ignored' : 'active';
      setIssues((prev) => prev.map((i) => (i.id === issue.id
        ? { ...i, status, resolved_at: action === 'resolve' ? new Date().toISOString() : action === 'reopen' ? null : i.resolved_at }
        : i)));
    } catch (err) {
      console.error(err);
      toast({ title: t('problems.actionFailed', "Couldn't save that change"), variant: 'destructive' });
    } finally {
      setActingOn(null);
    }
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

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-5">
        <div>
          <h2 className="text-xl font-bold">{t('problems.title', 'Problems')}</h2>
          <p className="text-sm text-muted-foreground">{selectedCar.name}</p>
        </div>

        {/* One-line answer to "is my car OK?" */}
        {!loading && (
          <Card className={open.length ? 'border-warn/40' : 'border-success/40'}>
            <CardContent className="p-4 flex items-center gap-3">
              {open.length === 0
                ? <CheckCircle2 className="w-6 h-6 text-success shrink-0" />
                : <AlertTriangle className={`w-6 h-6 shrink-0 ${mostUrgent === 'urgent' ? 'text-destructive' : 'text-warn'}`} />}
              <div>
                <p className="font-semibold">
                  {open.length === 0
                    ? t('problems.allGood', 'All good')
                    : t('problems.needAttention', { count: open.length, defaultValue: '{{count}} problems need attention' })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {open.length === 0
                    ? t('problems.allGoodHint', 'Nothing needs your attention right now. We keep checking on every trip.')
                    : mostUrgent === 'urgent'
                      ? t('problems.urgentHint', 'At least one is urgent — see what to do below.')
                      : t('problems.notUrgentHint', 'Nothing urgent. See what to do below.')}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-1 border-b border-border">
          {(['open', 'closed'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {key === 'open' ? t('problems.tabOpen', 'Need attention') : t('problems.tabClosed', 'Resolved or ignored')}
              <span className="ml-1.5 text-xs text-muted-foreground">{key === 'open' ? open.length : closed.length}</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : (tab === 'open' ? open : closed).length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {tab === 'open' ? t('problems.emptyOpen', 'No problems here.') : t('problems.emptyClosed', 'Nothing resolved or ignored yet.')}
          </p>
        ) : (
          <div className="space-y-3">
            {[...(tab === 'open' ? open : closed)]
              .sort((a, b) => URGENCY_ORDER.indexOf(URGENCY[a.severity]) - URGENCY_ORDER.indexOf(URGENCY[b.severity]))
              .map((issue) => (
                <ProblemCard
                  key={issue.id}
                  issue={issue}
                  acting={actingOn === issue.id}
                  formatDate={formatDate}
                  onAct={(a) => void act(issue, a)}
                />
              ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function ProblemCard({ issue, acting, formatDate, onAct }: {
  issue: VehicleIssue;
  acting: boolean;
  formatDate: (iso: string) => string;
  onAct: (action: 'resolve' | 'ignore' | 'reopen') => void;
}) {
  const { t } = useTranslation();
  const text = describeProblem(issue, t);
  const urgency = URGENCY[issue.severity] ?? 'soon';
  const isOpen = isOpenProblem(issue);

  return (
    <Card className={isOpen ? '' : 'opacity-70'} data-testid="problem-card">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${URGENCY_STYLE[urgency]}`}>
            {t(`problems.urgency.${urgency}`, URGENCY_DEFAULT[urgency])}
          </span>
          {issue.status === 'recurred' && (
            <span className="text-xs text-warn">{t('problems.cameBack', { count: issue.recurrence_count, defaultValue: 'Came back after being fixed ({{count}}×)' })}</span>
          )}
          {issue.status === 'resolved' && (
            <span className="text-xs text-success">
              {issue.resolved_note === CODE_GONE_NOTE
                ? t('problems.codeGone', 'Resolved: the car no longer reports this code')
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

        <p className="text-xs text-muted-foreground">
          {t('problems.seen', 'First seen {{first}} · last seen {{last}}', { first: formatDate(issue.first_seen_at), last: formatDate(issue.last_seen_at) })}
          {issue.last_session_id && (
            <> · <Link to={`/session/${issue.last_session_id}`} className="text-primary hover:underline">{t('problems.viewTrip', 'View the trip')}</Link></>
          )}
        </p>

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
