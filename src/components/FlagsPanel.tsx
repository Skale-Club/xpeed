import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, AlertCircle, CheckCircle, ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DEFAULT_PRIUS_RULES, type DefaultRule } from '@/lib/default-rules';

interface Flag {
  id?: string;
  severity: string;
  canonical_key: string;
  parameter_key: string;
  message: string;
  evidence?: Record<string, unknown> | null;
  resolved?: boolean | null;
}

interface FlagsPanelProps {
  flags: Flag[];
  limit?: number;
  // Optional rule set used to look up structured action messages (B1).
  // Defaults to the Prius set so existing call sites keep working.
  rules?: DefaultRule[];
  onAskAi?: (flag: Flag) => void;
}

interface ExpandedState {
  [flagKey: string]: boolean;
}

function findRule(rules: DefaultRule[], canonicalKey: string): DefaultRule | undefined {
  return rules.find(r => r.canonical_key === canonicalKey);
}

function fallbackActionMessages(notes: string, severity: 'critical' | 'attention') {
  // Backward-compat parser for legacy `notes` strings shaped like
  // "Attention: ...something... Critical: ...something else..."
  const lower = severity;
  const re = new RegExp(`${lower}:`, 'i');
  const after = notes.split(re)[1];
  if (!after) return { what_to_do: notes.split('.')[0] + '.' };
  const block = after.split(/critical:|attention:/i)[0].trim();
  return { what_to_do: block || notes };
}

export default function FlagsPanel({
  flags,
  limit,
  rules = DEFAULT_PRIUS_RULES,
  onAskAi,
}: FlagsPanelProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const num = (n: unknown) => new Intl.NumberFormat(i18n.resolvedLanguage || undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(n));

  // Sort: criticals first, then attentions, both above resolved
  const sorted = [...flags].sort((a, b) => {
    const aw = (a.resolved ? 100 : 0) + (a.severity === 'critical' ? 0 : a.severity === 'attention' ? 1 : 2);
    const bw = (b.resolved ? 100 : 0) + (b.severity === 'critical' ? 0 : b.severity === 'attention' ? 1 : 2);
    return aw - bw;
  });
  const displayed = limit ? sorted.slice(0, limit) : sorted;

  if (flags.length === 0) {
    return (
      <Card className="bg-card border-success/30">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-success" />
          <div>
            <p className="text-sm font-medium text-foreground">{t('flags.all_normal', 'All readings look normal')}</p>
            <p className="text-xs text-muted-foreground">{t('flags.no_flags', 'No flags detected for this session.')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {displayed.map((flag, i) => {
        const isCritical = flag.severity === 'critical';
        const Icon = isCritical ? AlertCircle : AlertTriangle;
        const evidence = flag.evidence as Record<string, number> | null;
        const flagKey = flag.id || `${flag.canonical_key}-${i}`;
        const isExpanded = expanded[flagKey];
        const rule = findRule(rules, flag.canonical_key);
        const severity = isCritical ? 'critical' : 'attention';
        const what_happened = rule?.what_happened;
        const why_it_matters = rule?.why_it_matters;
        const what_to_do = rule?.what_to_do || (rule?.notes ? fallbackActionMessages(rule.notes, severity).what_to_do : null);
        const hasGuidance = !!(what_happened || why_it_matters || what_to_do);

        return (
          <Card
            key={flagKey}
            className={`${isCritical ? 'severity-critical' : 'severity-attention'} border transition-opacity ${flag.resolved ? 'opacity-50' : ''}`}
          >
            <CardContent className="p-3">
              <div className="flex gap-3">
                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isCritical ? 'text-destructive' : 'text-warn'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`text-[10px] uppercase font-mono font-bold tracking-wider ${isCritical ? 'text-destructive' : 'text-warn'}`}>
                      {t(`flags.${isCritical ? 'critical' : 'attention'}`, isCritical ? 'Critical' : 'Attention')}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground">{flag.canonical_key}</span>
                    {flag.resolved && (
                      <span className="text-[10px] font-mono text-success px-1.5 rounded bg-success/10">{t('flags.resolved', 'resolved')}</span>
                    )}
                  </div>
                  <p className="text-xs text-foreground leading-relaxed">{flag.message}</p>
                  {evidence && (
                    <div className="flex gap-3 mt-2 text-[10px] font-mono text-muted-foreground">
                      {evidence.max !== undefined && <span>{t('flags.max', 'max')}: {num(evidence.max)}</span>}
                      {evidence.avg !== undefined && <span>{t('flags.avg', 'avg')}: {num(evidence.avg)}</span>}
                      {evidence.pct_out_of_range !== undefined && <span>{t('flags.out_of_range', '{{value}}% out of range', { value: num(evidence.pct_out_of_range) })}</span>}
                    </div>
                  )}

                  {hasGuidance && (
                    <>
                      <button
                        type="button"
                        onClick={() => setExpanded(s => ({ ...s, [flagKey]: !s[flagKey] }))}
                        className="mt-2 inline-flex min-h-10 items-center gap-1 text-xs text-primary hover:underline"
                      >
                        {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        {isExpanded ? t('flags.hide_guidance', 'Hide') : t('flags.show_guidance', 'What should I do?')}
                      </button>
                      {isExpanded && (
                        <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
                          {what_happened && (
                            <div>
                              <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">{t('flags.what_happened', 'What happened')}</div>
                              <p className="text-xs text-foreground/90 leading-relaxed">{what_happened}</p>
                            </div>
                          )}
                          {why_it_matters && (
                            <div>
                              <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">{t('flags.why_it_matters', 'Why it matters')}</div>
                              <p className="text-xs text-foreground/90 leading-relaxed">{why_it_matters}</p>
                            </div>
                          )}
                          {what_to_do && (
                            <div>
                              <div className="text-[10px] font-mono uppercase text-warn mb-0.5">{t('flags.what_to_do', 'What to do')}</div>
                              <p className="text-xs text-foreground leading-relaxed">{what_to_do}</p>
                            </div>
                          )}
                          {onAskAi && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="mt-1 h-7 text-[10px] font-mono"
                              onClick={() => onAskAi(flag)}
                            >
                              <Sparkles className="w-3 h-3 mr-1" />
                              {t('flags.ask_ai', 'Ask AI about this')}
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {limit && sorted.length > limit && (
        <p className="text-xs text-muted-foreground text-center">{t('flags.more', '+{{count}} more', { count: sorted.length - limit })}</p>
      )}
    </div>
  );
}
