import { useTranslation } from 'react-i18next';
import { Lightbulb } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { sessionFindingText, type SessionFinding } from '@/lib/sim/insight-text';
import type { SessionKpis } from '@/lib/sim/session-detail';
import { Panel } from '../overview/parts';
import { findingOf, useSessionInsights } from './use-session-insights';

/**
 * "What stood out": the sentences the server worked out for the session (the sector where the best lap loses most, the sector that varies most, how much the laps
 * vary) and, from the laps on screen, how much the best sectors would gain and how many laps the game voided. Each line is a sentence and nothing else; with
 * nothing to say the card is not shown.
 */
export function StoodOutCard({ sessionId, version, kpis }: { sessionId: string; version: string; kpis: SessionKpis }) {
  const { t } = useTranslation();
  const query = useSessionInsights(sessionId, version);
  const findings = (query.data?.findings ?? []).map(findingOf);
  const voided = kpis.laps - kpis.validLaps;
  const own: Array<{ id: string; text: string }> = [];
  if (kpis.theoreticalGainMs !== null && kpis.theoreticalGainMs >= 50) {
    own.push({ id: 'theoretical', text: t('sessionsDash.session.stoodTheoretical', 'Your best sectors put together make a lap {{seconds}} s faster than your best lap.', { seconds: (kpis.theoreticalGainMs / 1000).toFixed(3) }) });
  }
  if (voided > 0) {
    own.push({ id: 'voided', text: t('sessionsDash.session.stoodVoided', { count: voided, defaultValue_one: 'The game voided {{count}} lap, so it does not count.', defaultValue_other: 'The game voided {{count}} laps, so they do not count.' }) });
  }
  const sentences = [
    ...findings.map((finding) => {
      const text = sessionFindingText(finding);
      return { id: finding.kind, text: t(text.key, text.values) };
    }),
    ...own,
  ];
  if (query.isPending) {
    return (
      <Panel title={<span className="flex items-center gap-2"><Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />{t('sessionsDash.session.stoodTitle', 'What stood out')}</span>} testId="stood-out">
        <div className="space-y-2" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="stood-loading">
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-full" />
        </div>
      </Panel>
    );
  }
  if (sentences.length === 0) return null;
  return (
    <Panel title={<span className="flex items-center gap-2"><Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />{t('sessionsDash.session.stoodTitle', 'What stood out')}</span>} testId="stood-out">
      <ul className="space-y-2 text-sm">
        {sentences.map((sentence) => (
          <li key={sentence.id} className="flex gap-2" data-testid="stood-sentence" data-kind={sentence.id}>
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            <span>{sentence.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
