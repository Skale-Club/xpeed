import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
  icon: LucideIcon;
  tone?: 'default' | 'success' | 'warn' | 'critical';
  onClick?: () => void;
}

const TONE_CLASS: Record<NonNullable<StatCardProps['tone']>, string> = {
  default:  'text-foreground',
  success:  'text-success',
  warn:     'text-warn',
  critical: 'text-destructive',
};

const TONE_BG: Record<NonNullable<StatCardProps['tone']>, string> = {
  default:  'bg-primary/5 border-border',
  success:  'bg-success/5 border-success/30',
  warn:     'bg-warn/5 border-warn/30',
  critical: 'bg-destructive/5 border-destructive/30',
};

/**
 * Compact KPI card used on the dashboard. 44+ px tap target on mobile.
 */
export default function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  tone = 'default',
  onClick,
}: StatCardProps) {
  const interactive = !!onClick;
  return (
    <Card
      className={`${TONE_BG[tone]} border transition-colors ${interactive ? 'cursor-pointer hover:opacity-90 active:scale-[0.99]' : ''}`}
      onClick={onClick}
    >
      <CardContent className="p-3 sm:p-4 flex items-center gap-3 min-h-[64px]">
        <div className={`w-9 h-9 rounded-full bg-background/50 flex items-center justify-center flex-shrink-0 ${TONE_CLASS[tone]}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground truncate">
            {label}
          </div>
          <div className={`text-lg font-mono font-bold ${TONE_CLASS[tone]} flex items-baseline gap-1`}>
            <span className="tabular-nums">{value}</span>
            {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
