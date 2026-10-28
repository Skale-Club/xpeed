import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Upload, SlidersHorizontal, PackagePlus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  newPidId, normalizeCommand, normalizeHeader, parseTorqueCsv, validateCustomPid, type CustomPid,
} from '@/lib/obd/custom-pids';
import { PID_PRESETS, mergePreset } from '@/lib/obd/presets';

interface Props {
  pids: CustomPid[];
  onChange: (pids: CustomPid[]) => void;
  /** Custom ECU headers only work on CAN vehicles. */
  headersUnsupported?: boolean;
}

const EMPTY = { name: '', unit: '', header: '', command: '', formula: '', min: '0', max: '100' };

export function CustomPidsCard({ pids, onChange, headersUnsupported }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const add = () => {
    const pid: CustomPid = {
      id: newPidId(),
      name: form.name.trim(),
      unit: form.unit.trim(),
      header: normalizeHeader(form.header),
      command: normalizeCommand(form.command),
      formula: form.formula.trim(),
      min: Number(form.min),
      max: Number(form.max),
    };
    const err = validateCustomPid(pid);
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setForm(EMPTY);
    onChange([...pids, pid]);
  };

  const importFile = async (file: File) => {
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
    const { pids: imported, errors } = parseTorqueCsv(text);
    if (imported.length) onChange([...pids, ...imported]);
    toast({
      title: t('scanner.custom.imported', 'Imported {{count}} PIDs', { count: imported.length }),
      description: errors.length ? errors.slice(0, 3).join('\n') + (errors.length > 3 ? `\n+${errors.length - 3}…` : '') : undefined,
      variant: imported.length ? 'default' : 'destructive',
    });
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4" />
          {t('scanner.custom.title', 'Custom PIDs')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('scanner.custom.hint', 'Manufacturer-specific data (e.g. Toyota hybrid ECU on header 7E2/7E3, mode 21). Formulas use Torque syntax: A, B, C… are reply bytes, e.g. (A*256+B)/10. Import a Torque custom-PID CSV or add one by hand, then compare the values with the dashboard before trusting them.')}
        </p>
        {headersUnsupported && pids.some((p) => p.header) && (
          <p className="text-xs text-destructive">{t('scanner.custom.needsCan', 'This vehicle is not CAN, so PIDs with an ECU header cannot be read.')}</p>
        )}

        {pids.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {pids.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">{p.name} {p.unit && <span className="text-muted-foreground">({p.unit})</span>}</p>
                  <p className="font-mono text-muted-foreground truncate">
                    {p.header ? `${p.header} · ` : ''}{p.command} · {p.formula}
                  </p>
                </div>
                <Button
                  size="icon" variant="ghost" className="h-7 w-7"
                  aria-label={t('scanner.custom.remove', 'Remove {{name}}', { name: p.name })}
                  onClick={() => onChange(pids.filter((x) => x.id !== p.id))}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="col-span-2 space-y-1">
            <Label htmlFor="cp-name" className="text-[11px]">{t('scanner.custom.name', 'Name')}</Label>
            <Input id="cp-name" value={form.name} onChange={set('name')} placeholder="State of Charge" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-unit" className="text-[11px]">{t('scanner.custom.unit', 'Unit')}</Label>
            <Input id="cp-unit" value={form.unit} onChange={set('unit')} placeholder="%" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-header" className="text-[11px]">{t('scanner.custom.header', 'ECU header')}</Label>
            <Input id="cp-header" value={form.header} onChange={set('header')} placeholder="7E3" className="h-8 text-xs font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-command" className="text-[11px]">{t('scanner.custom.command', 'Request')}</Label>
            <Input id="cp-command" value={form.command} onChange={set('command')} placeholder="2181" className="h-8 text-xs font-mono" />
          </div>
          <div className="col-span-2 sm:col-span-3 space-y-1">
            <Label htmlFor="cp-formula" className="text-[11px]">{t('scanner.custom.formula', 'Formula')}</Label>
            <Input id="cp-formula" value={form.formula} onChange={set('formula')} placeholder="(A*256+B)/10" className="h-8 text-xs font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-min" className="text-[11px]">Min</Label>
            <Input id="cp-min" value={form.min} onChange={set('min')} inputMode="decimal" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-max" className="text-[11px]">Max</Label>
            <Input id="cp-max" value={form.max} onChange={set('max')} inputMode="decimal" className="h-8 text-xs" />
          </div>
        </div>
        {formError && <p className="text-xs text-destructive">{formError}</p>}

        <div className="flex flex-wrap gap-2">
          {PID_PRESETS.map((preset) => (
            <Button
              key={preset.id} size="sm" variant="outline"
              onClick={() => onChange(mergePreset(pids, preset.pids()))}
            >
              <PackagePlus className="w-3.5 h-3.5 mr-2" />
              {t('scanner.custom.addPreset', 'Add preset: {{label}}', { label: preset.label })}
            </Button>
          ))}
          {pids.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              <Trash2 className="w-3.5 h-3.5 mr-2" />
              {t('scanner.custom.removeAll', 'Remove all')}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={add}>
            <Plus className="w-3.5 h-3.5 mr-2" />
            {t('scanner.custom.add', 'Add PID')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="w-3.5 h-3.5 mr-2" />
            {t('scanner.custom.import', 'Import Torque CSV')}
          </Button>
          <input
            ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" data-testid="custom-pid-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
