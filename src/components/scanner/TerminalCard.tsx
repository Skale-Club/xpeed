import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, SquareTerminal, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { normalizeCommand, normalizeHeader } from '@/lib/obd/custom-pids';

interface Entry {
  id: number;
  header: string | null;
  command: string;
  lines?: string[];
  error?: string;
}

interface Props {
  onSend: (command: string, header: string | null) => Promise<string[]>;
}

const MAX_ENTRIES = 30;

export function TerminalCard({ onSend }: Props) {
  const { t } = useTranslation();
  const [header, setHeader] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);

  const send = async () => {
    const cmd = normalizeCommand(command);
    if (!cmd || busy) return;
    const h = normalizeHeader(header);
    const id = Date.now();
    setBusy(true);
    try {
      const lines = await onSend(cmd, h);
      setLog((l) => [{ id, header: h, command: cmd, lines }, ...l].slice(0, MAX_ENTRIES));
    } catch (err) {
      setLog((l) => [{ id, header: h, command: cmd, error: err instanceof Error ? err.message : String(err) }, ...l].slice(0, MAX_ENTRIES));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <SquareTerminal className="w-4 h-4" />
          {t('scanner.terminal.title', 'Terminal')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t('scanner.terminal.hint', 'Send a read request to an ECU and see the raw reply — useful to find manufacturer PIDs. Only reads are allowed; nothing is written to the car.')}
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); void send(); }}
        >
          <Input
            value={header} onChange={(e) => setHeader(e.target.value)}
            placeholder={t('scanner.terminal.header', 'Header')} aria-label={t('scanner.terminal.header', 'Header')}
            className="h-8 w-24 text-xs font-mono"
          />
          <Input
            value={command} onChange={(e) => setCommand(e.target.value)}
            placeholder="2181" aria-label={t('scanner.terminal.command', 'Command')}
            className="h-8 flex-1 text-xs font-mono"
          />
          <Button type="submit" size="sm" disabled={busy || !command.trim()} aria-label={t('scanner.terminal.send', 'Send')}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </Button>
        </form>
        {log.length > 0 && (
          <div className="rounded-md border border-border bg-muted/30 p-2 max-h-64 overflow-auto font-mono text-[11px] space-y-2">
            {log.map((e) => (
              <div key={e.id}>
                <p className="text-primary">&gt; {e.header ? `[${e.header}] ` : ''}{e.command}</p>
                {e.error
                  ? <p className="text-destructive whitespace-pre-wrap">{e.error}</p>
                  : <p className="text-foreground whitespace-pre-wrap break-all">{e.lines?.join('\n') || '(empty)'}</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
