import { useState } from 'react';
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

const SEVERITY_LABEL: Record<DtcInfo['severity'], string> = {
  minor: 'Minor',
  moderate: 'Moderate',
  severe: 'Severe',
};

const DIFFICULTY_LABEL: Record<number, string> = {
  1: 'DIY-friendly',
  2: 'Easy with basic tools',
  3: 'Moderate — some experience helpful',
  4: 'Advanced — shop tools recommended',
  5: 'Specialist — dealer or pro shop',
};

export default function DTCPanel({ codes, onAskAi }: DTCPanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (codes.length === 0) {
    return (
      <Card className="bg-card border-success/30">
        <CardContent className="p-4 flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-success" />
          <div>
            <p className="text-sm font-medium text-foreground">No active DTCs</p>
            <p className="text-xs text-muted-foreground">No diagnostic trouble codes were stored during this session.</p>
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
                      {SEVERITY_LABEL[dtc.severity]}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground uppercase">{dtc.category}</span>
                  </div>
                  <p className="text-xs text-foreground mt-1 leading-relaxed">{dtc.name}</p>
                  <button
                    type="button"
                    onClick={() => setExpanded(s => ({ ...s, [dtc.code]: !s[dtc.code] }))}
                    className="mt-2 inline-flex items-center gap-1 text-[10px] font-mono text-primary hover:underline"
                  >
                    {isOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {isOpen ? 'Hide details' : 'Show details'}
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-2 border-t border-border/50 pt-2">
                      <div>
                        <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">Description</div>
                        <p className="text-xs text-foreground/90 leading-relaxed">{dtc.description}</p>
                      </div>
                      {dtc.likely_causes.length > 0 && (
                        <div>
                          <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">Likely causes</div>
                          <ul className="text-xs text-foreground/90 list-disc pl-4 space-y-0.5">
                            {dtc.likely_causes.map(c => <li key={c}>{c}</li>)}
                          </ul>
                        </div>
                      )}
                      <div>
                        <div className="text-[10px] font-mono uppercase text-muted-foreground mb-0.5">Repair difficulty</div>
                        <p className="text-xs text-foreground/90">
                          {'★'.repeat(dtc.repair_difficulty)}{'☆'.repeat(5 - dtc.repair_difficulty)} — {DIFFICULTY_LABEL[dtc.repair_difficulty]}
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
                          Ask AI about {dtc.code}
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
