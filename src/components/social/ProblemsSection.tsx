import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bug, CheckCircle2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { PlainSelect, ErrorLine } from '@/components/social/social-bits';
import { useErrorText } from '@/components/social/use-error-text';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { useProblems, useResolveProblem, type Problem, type ProblemFilter } from '@/lib/problems-client';

function ProblemRow({ problem }: { problem: Problem }) {
  const { t } = useTranslation();
  const when = useWhen();
  const errorText = useErrorText();
  const resolve = useResolveProblem();
  const [open, setOpen] = useState(false);
  const resolved = problem.resolvedAt !== null;
  return (
    <li className="space-y-2 p-3" data-testid="problem" data-problem-id={problem.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={problem.source === 'site' ? 'default' : 'secondary'} data-testid="problem-source">
          {problem.source === 'site' ? t('social.admin.problemsSite', 'Site') : t('social.admin.problemsCompanion', 'Companion')}
        </Badge>
        {resolved && <Badge variant="outline" data-testid="problem-resolved">{t('social.admin.problemsResolved', 'Resolved')}</Badge>}
        {!resolved && problem.reopenedCount > 0 && <Badge variant="destructive" data-testid="problem-reopened">{t('social.admin.problemsReopened', 'Came back after being resolved')}</Badge>}
        <span className="text-sm font-medium break-words" data-testid="problem-message">{problem.message}</span>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="problem-facts">
        <span data-testid="problem-count">{t('social.admin.problemsTimes', '{{n}} times', { n: problem.count })}</span>
        <span>{t('social.admin.problemsLastSeen', 'Last seen {{when}}', { when: when(Date.parse(problem.lastSeen)) })}</span>
        {problem.version && <span data-testid="problem-version">{t('social.admin.problemsVersion', 'Version {{version}}', { version: problem.version })}</span>}
        <span>{t('social.admin.problemsPeople', '{{n}} people', { n: problem.affectedUsers })}</span>
        {problem.worker && <span>{t('social.admin.problemsWorker', 'Worker {{worker}}', { worker: problem.worker })}</span>}
        {problem.route && <span className="font-mono">{problem.route}</span>}
        {problem.agent && <span>{problem.agent}</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen((value) => !value)} aria-expanded={open} data-testid="problem-toggle">
          {open ? <ChevronDown className="mr-2 h-4 w-4" aria-hidden /> : <ChevronRight className="mr-2 h-4 w-4" aria-hidden />}
          {open ? t('social.admin.problemsHide', 'Hide the stack') : t('social.admin.problemsShow', 'Show the stack')}
        </Button>
        {resolved ? (
          <Button size="sm" variant="outline" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: problem.id, resolved: false })} data-testid="problem-reopen">
            <RotateCcw className="mr-2 h-4 w-4" aria-hidden /> {t('social.admin.problemsReopen', 'Reopen')}
          </Button>
        ) : (
          <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: problem.id, resolved: true })} data-testid="problem-resolve">
            <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden /> {t('social.admin.problemsResolve', 'Mark resolved')}
          </Button>
        )}
      </div>
      {open && (
        <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap break-words" data-testid="problem-stack">
          {problem.stack || t('social.admin.problemsNoStack', 'No stack was sent.')}
        </pre>
      )}
      {resolve.isError && <ErrorLine>{errorText(resolve.error)}</ErrorLine>}
    </li>
  );
}

/**
 * Admin > Problems: the errors the site and Xpeed Companion reported to Xpeed's own server, grouped by fingerprint, newest first, with how
 * many times, when, which version and how many people. The sample stack opens on demand. "Mark resolved" hides a problem until it happens again.
 * Only an admin ever sees it (the app's own admin check), and the server refuses everybody else.
 */
export function ProblemsSection() {
  const { isAdmin, loading } = useAdminStatus();
  if (loading || !isAdmin) return null;
  return <ProblemsBody />;
}

function ProblemsBody() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ProblemFilter>('open');
  const problems = useProblems(status);
  const items = problems.data ?? [];
  return (
    <section className="space-y-4" data-testid="problems-admin" aria-labelledby="problems-admin-title">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle id="problems-admin-title" className="flex items-center gap-2 text-lg font-bold"><Bug className="h-5 w-5 text-primary" aria-hidden /> {t('social.admin.problemsTitle', 'Problems')}</CardTitle>
            <PlainSelect
              label={t('social.admin.show', 'Show')}
              value={status}
              onChange={(value) => setStatus(value as ProblemFilter)}
              options={[
                { value: 'open', label: t('social.admin.open', 'Open') },
                { value: 'resolved', label: t('social.admin.problemsResolved', 'Resolved') },
                { value: 'all', label: t('social.admin.all', 'All') },
              ]}
              className="sm:w-44"
              testId="problems-status"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('social.admin.problemsBody', 'Errors that the site and Xpeed Companion reported to this server, newest first. A report never carries an e-mail, a phone number or a token. Reports are kept for 30 days.')}</p>
        </CardHeader>
        <CardContent className="p-0">
          <QueryGate
            query={problems}
            empty={items.length === 0}
            emptyNode={<p className="p-4 text-sm text-muted-foreground" data-testid="problems-none">{t('social.admin.problemsNone', 'No problems here.')}</p>}
          >
            <ul className="divide-y divide-border" data-testid="problems-list">
              {items.map((problem) => <ProblemRow key={problem.id} problem={problem} />)}
            </ul>
          </QueryGate>
        </CardContent>
      </Card>
    </section>
  );
}
