import { AlertCircle, AlertTriangle, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Link } from 'react-router-dom';
import type { SessionFlag } from '@/types/session';

interface ActiveFlagsBannerProps {
  flags: SessionFlag[];
  onClick?: () => void;
}

/**
 * Sticky-friendly compact banner showing the count of unresolved critical /
 * attention flags. Renders nothing when there are no active flags.
 * Mobile-first: above-the-fold on the dashboard.
 */
export default function ActiveFlagsBanner({ flags, onClick }: ActiveFlagsBannerProps) {
  const active = flags.filter(f => !f.resolved);
  if (active.length === 0) return null;

  const criticals = active.filter(f => f.severity === 'critical');
  const attentions = active.filter(f => f.severity === 'attention');

  const Icon = criticals.length > 0 ? AlertCircle : AlertTriangle;
  const tone = criticals.length > 0 ? 'border-destructive/50 bg-destructive/5' : 'border-warn/50 bg-warn/5';
  const accent = criticals.length > 0 ? 'text-destructive' : 'text-warn';

  const content = (
    <Card className={`${tone} border cursor-pointer hover:opacity-90 transition-opacity`} onClick={onClick}>
      <CardContent className="p-3 flex items-center gap-3">
        <Icon className={`w-5 h-5 ${accent} flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            {criticals.length > 0 && (
              <span className="text-destructive font-bold">{criticals.length} critical</span>
            )}
            {criticals.length > 0 && attentions.length > 0 && <span className="text-muted-foreground">, </span>}
            {attentions.length > 0 && (
              <span className="text-warn">{attentions.length} attention</span>
            )}
            {' '}flag{active.length > 1 ? 's' : ''} need{active.length === 1 ? 's' : ''} attention
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tap to review and decide what to do.
          </p>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground" />
      </CardContent>
    </Card>
  );

  if (onClick) return content;
  return <Link to="/history">{content}</Link>;
}
