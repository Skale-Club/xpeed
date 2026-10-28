import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Radar, Loader2, Copy, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { NRC_NAMES, diffSweeps, formatSweep, type EcuProbe, type SweepHit } from '@/lib/obd/scan';
import type { ScanProgress } from '@/hooks/use-obd-scanner';

interface Props {
  findEcus: (onProgress: ScanProgress, signal: AbortSignal) => Promise<EcuProbe[]>;
  sweepMode21: (header: string, onProgress: ScanProgress, signal: AbortSignal) => Promise<{ command: string; data: number[] }[]>;
}

function hexByte(b: number) {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

export function EcuScanCard({ findEcus, sweepMode21 }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [probes, setProbes] = useState<EcuProbe[] | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [sweeps, setSweeps] = useState<Record<string, SweepHit[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = async <T,>(label: string, job: (onProgress: ScanProgress, signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ label, done: 0, total: 1 });
    try {
      return await job((done, total) => setProgress({ label, done, total }), controller.signal);
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  };

  const handleFind = async () => {
    const result = await run(t('scanner.scan.finding', 'Looking for ECUs…'), findEcus);
    setProbes(result);
  };

  const handleSweep = async (header: string) => {
    setSelected(header);
    const hits = await run(t('scanner.scan.sweeping', 'Reading mode 21 on {{header}}…', { header }), (p, s) => sweepMode21(header, p, s));
    setSweeps((prev) => ({ ...prev, [header]: diffSweeps(prev[header], hits) }));
  };

  const copy = async (header: string) => {
    try {
      await navigator.clipboard.writeText(formatSweep(header, sweeps[header] ?? []));
      toast({ title: t('scanner.scan.copied', 'Copied — paste it in the chat'), variant: 'success' });
    } catch {
      toast({ title: t('scanner.scan.copyFailed', 'Could not copy to the clipboard'), variant: 'destructive' });
    }
  };

  const responders = (probes ?? []).filter((p) => p.reply);
  const silent = (probes ?? []).length - responders.length;
  const hits = selected ? sweeps[selected] : undefined;
  const busy = progress !== null;

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Radar className="w-4 h-4" />
          {t('scanner.scan.title', 'ECU discovery')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('scanner.scan.hint', 'Find which control modules answer, then list every mode 21 data block a module returns. Run a scan twice (e.g. engine off vs. running) to highlight the bytes that change — those are live sensors. Read-only; live data pauses while scanning.')}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={handleFind} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Radar className="w-3.5 h-3.5 mr-2" />}
            {t('scanner.scan.find', 'Find ECUs')}
          </Button>
          {busy && (
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
              <X className="w-3.5 h-3.5 mr-2" />
              {t('common.cancel', 'Cancel')}
            </Button>
          )}
        </div>

        {progress && (
          <div className="space-y-1">
            <Progress value={(progress.done / progress.total) * 100} className="h-1.5" />
            <p className="text-[11px] text-muted-foreground font-mono">{progress.label} {progress.done}/{progress.total}</p>
          </div>
        )}

        {probes && (
          <div className="space-y-2">
            {responders.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('scanner.scan.none', 'No module answered.')}</p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {responders.map((p) => (
                  <div key={p.header} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <span className="font-mono font-bold w-12">{p.header}</span>
                    <span className="flex-1 text-muted-foreground">
                      {p.reply?.kind === 'positive'
                        ? t('scanner.scan.answers', 'answers')
                        : t('scanner.scan.answersNrc', 'answers ({{reason}})', {
                          reason: p.reply?.kind === 'negative' ? NRC_NAMES[p.reply.nrc] ?? `NRC ${hexByte(p.reply.nrc)}` : '',
                        })}
                    </span>
                    <Button size="sm" variant="outline" className="h-7" onClick={() => handleSweep(p.header)} disabled={busy}>
                      {t('scanner.scan.sweep', 'Scan PIDs')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {silent > 0 && (
              <p className="text-[11px] text-muted-foreground">{t('scanner.scan.silent', '{{count}} addresses did not answer.', { count: silent })}</p>
            )}
          </div>
        )}

        {selected && hits && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-mono font-bold">
                {t('scanner.scan.result', 'ECU {{header}}: {{count}} data blocks', { header: selected, count: hits.length })}
              </p>
              {hits.length > 0 && (
                <Button size="sm" variant="ghost" className="h-7" onClick={() => copy(selected)}>
                  <Copy className="w-3.5 h-3.5 mr-2" />
                  {t('scanner.scan.copy', 'Copy')}
                </Button>
              )}
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-2 max-h-80 overflow-auto font-mono text-[11px] space-y-1">
              {hits.map((h) => (
                <div key={h.command} className="flex gap-2">
                  <span className="text-primary shrink-0">{h.command}</span>
                  <span className="text-muted-foreground shrink-0">[{h.data.length}]</span>
                  <span className="break-all">
                    {h.data.map((b, i) => (
                      <span key={i} className={h.changed.includes(i) ? 'text-warn font-bold' : 'text-foreground'}>{hexByte(b)} </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
