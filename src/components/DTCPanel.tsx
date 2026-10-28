import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronUp, CheckCircle, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { lookupDtcs, type DtcInfo } from '@/lib/dtc-codes';

interface DTCPanelProps {
  codes: string[];
  onAskAi?: (dtc: DtcInfo) => void;
}

const SEVERITY_COLOR: Record<DtcInfo['severity'], string> = {
  minor: 'text-warn',
  moderate: 'text-warn',
  severe: 'text-destructive',
};

// English defaults; translations live under faultCodes.* in src/locales.
const SEVERITY_LABEL: Record<DtcInfo['severity'], string> = {
  minor: 'Minor',
  moderate: 'Moderate',
  severe: 'Serious',
};

const CATEGORY_LABEL: Record<DtcInfo['category'], string> = {
  powertrain: 'Engine & gearbox',
  chassis: 'Brakes, steering & suspension',
  body: 'Body & comfort',
  network: 'Electronics',
};

const DIFFICULTY_LABEL: Record<number, string> = {
  1: 'Easy — you can probably fix it yourself',
  2: 'Simple with basic tools',
  3: 'Medium — some experience helps',
  4: 'Hard — best done at a garage',
  5: 'Specialist — take it to a dealer or specialist garage',
};

export default function DTCPanel({ codes, onAskAi }: DTCPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (codes.length === 0) {
    return (
      <Card className="bg-card border-success/30">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-success" />
          <div>
            <p className="text-sm font-medium text-foreground">{t('faultCodes.noneTitle', 'No fault codes')}</p>
            <p className="text-xs text-muted-foreground">{t('faultCodes.noneBody', "Your car didn't report any fault codes.")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const items = lookupDtcs(codes);
  // Sort severe first
  const sorted = [...items].sort((a, b) => {
    const order = { severe: 0, moderate: 1, minor: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <div className="space-y-2">
      {sorted.map((dtc) => {
        const isOpen = expanded[dtc.code];
        return (
          <Card key={dtc.code} className="border-border bg-card">
            <CardContent className="p-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${SEVERITY_COLOR[dtc.severity]}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm font-bold text-foreground">{dtc.code}</span>
                    <span className={`text-[10px] uppercase font-mono font-bold tracking-wider ${SEVERITY_COLOR[dtc.severity]}`}>
                      {t(`faultCodes.severity.${dtc.severity}`, SEVERITY_LABEL[dtc.severity])}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground uppercase">{t(`faultCodes.category.${dtc.category}`, CATEGORY_LABEL[dtc.category] ?? dtc.category)}</span>
                  </div>
                  <p className="text-xs text-foreground mt-1 leading-relaxed">{dtc.name}</p>
                  <button
                    type="button"
                    onClick={() => setExpanded(s => ({ ...s, [dtc.code]: !s[dtc.code] }))}
                    className="mt-2 inline-flex items-center gap-1 text-[10px] font-mono text-primary hover:underline"
                  >
                    {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {isOpen ? t('faultCodes.hideDetails', 'Hide details') : t('faultCodes.showDetails', 'Show details')}
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
                      <div>
                        <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">{t('faultCodes.whatItMeans', 'What it means')}</div>
                        <p className="text-xs text-foreground/90 leading-relaxed">{dtc.description}</p>
                      </div>
                      {dtc.likely_causes.length > 0 && (
                        <div>
                          <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">{t('faultCodes.likelyCauses', 'Likely causes')}</div>
                          <ul className="text-xs text-foreground/90 list-disc pl-4 space-y-0.5">
                            {dtc.likely_causes.map(c => <li key={c}>{c}</li>)}
                          </ul>
                        </div>
                      )}
                      <div>
                        <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">{t('faultCodes.repairDifficulty', 'How hard is the fix')}</div>
                        <p className="text-xs text-foreground/90">
                          {'★'.repeat(dtc.repair_difficulty)}{'☆'.repeat(5 - dtc.repair_difficulty)} — {t(`faultCodes.difficulty.${dtc.repair_difficulty}`, DIFFICULTY_LABEL[dtc.repair_difficulty])}
                        </p>
                      </div>
                      {onAskAi && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-1 h-7 text-[10px] font-mono"
                          onClick={() => onAskAi(dtc)}
                        >
                          <Sparkles className="w-3 h-3 mr-1" />
                          {t('faultCodes.askAssistant', 'Ask the assistant about {{code}}', { code: dtc.code })}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
