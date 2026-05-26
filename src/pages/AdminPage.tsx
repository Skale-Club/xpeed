import { useEffect, useState } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Shield, Loader2, Eye, EyeOff, CheckCircle, AlertTriangle } from 'lucide-react';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { listAdminSettings, upsertAdminSetting, type AdminSetting } from '@/lib/db-extras';
import { useToast } from '@/hooks/use-toast';
import { PageLoader } from '@/components/PageLoader';
import BrandingSection from '@/components/admin/BrandingSection';

interface SettingRowState {
  value: string;
  initialValue: string | null;
  saving: boolean;
  revealed: boolean;
}

export default function AdminPage() {
  const { isAdmin, loading: adminLoading } = useAdminStatus();
  const { toast } = useToast();
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [state, setState] = useState<Record<string, SettingRowState>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAdmin || adminLoading) return;
    (async () => {
      try {
        const data = await listAdminSettings();
        setSettings(data);
        const initial: Record<string, SettingRowState> = {};
        data.forEach((s) => {
          initial[s.setting_key] = {
            value: s.setting_value || '',
            initialValue: s.setting_value,
            saving: false,
            revealed: false,
          };
        });
        setState(initial);
      } catch (err) {
        toast({ title: 'Failed to load settings', description: String(err), variant: 'destructive' });
      } finally {
        setLoading(false);
      }
    })();
  }, [isAdmin, adminLoading, toast]);

  if (adminLoading) return <PageLoader />;
  if (!isAdmin) return (
    <AppLayout>
      <div className="max-w-md mx-auto pt-12 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-destructive" />
          <h2 className="text-lg font-mono font-bold text-foreground">Admin Access Required</h2>
        </div>
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-xs space-y-2">
            <p>Your account is not marked as admin in the database.</p>
            <p className="font-mono bg-destructive/10 rounded px-2 py-1 mt-2 select-all">
              UPDATE public.car_profiles SET is_admin = true WHERE user_id = (SELECT id FROM auth.users WHERE email = 'skale.club@gmail.com' LIMIT 1);
            </p>
            <p>Run the SQL above no <strong>Supabase Dashboard → SQL Editor</strong>, depois recarregue a página.</p>
          </AlertDescription>
        </Alert>
      </div>
    </AppLayout>
  );

  const handleSave = async (settingKey: string) => {
    const row = state[settingKey];
    if (!row) return;
    setState((s) => ({ ...s, [settingKey]: { ...row, saving: true } }));
    try {
      const valueToSave = row.value.trim() === '' ? null : row.value.trim();
      await upsertAdminSetting(settingKey, valueToSave);
      setState((s) => ({
        ...s,
        [settingKey]: { ...row, saving: false, initialValue: valueToSave },
      }));
      toast({ title: 'Saved', description: settings.find((x) => x.setting_key === settingKey)?.label });
    } catch (err) {
      setState((s) => ({ ...s, [settingKey]: { ...row, saving: false } }));
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-mono font-bold text-foreground">Super-Admin Panel</h2>
        </div>

        <Alert>
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription className="text-xs">
            These settings are <strong>global</strong>. They affect every user of the system. Secret values
            (Gemini API key) are stored in the database and consumed only by trusted Edge Functions.
          </AlertDescription>
        </Alert>

        <BrandingSection />

        {loading ? (
          <Card><CardContent className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" /></CardContent></Card>
        ) : (
          <div className="space-y-3">
            {settings.map((setting) => {
              const row = state[setting.setting_key] || { value: '', initialValue: null, saving: false, revealed: false };
              const isDirty = (row.value.trim() || null) !== row.initialValue;
              const hasValue = !!row.initialValue;
              return (
                <Card key={setting.setting_key} className="border-border">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-mono flex items-center gap-2">
                      {setting.label}
                      {hasValue && <CheckCircle className="w-3.5 h-3.5 text-success" />}
                      {setting.is_secret && (
                        <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-warn/10 text-warn">
                          secret
                        </span>
                      )}
                    </CardTitle>
                    <CardDescription className="text-xs">{setting.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`setting-${setting.setting_key}`} className="text-xs font-mono text-muted-foreground">
                        {setting.setting_key}
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id={`setting-${setting.setting_key}`}
                          type={setting.is_secret && !row.revealed ? 'password' : 'text'}
                          placeholder={setting.is_secret ? 'sk-... or AIza...' : ''}
                          value={row.value}
                          onChange={(e) =>
                            setState((s) => ({
                              ...s,
                              [setting.setting_key]: { ...row, value: e.target.value },
                            }))
                          }
                          className="font-mono text-xs"
                        />
                        {setting.is_secret && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="px-3"
                            onClick={() =>
                              setState((s) => ({
                                ...s,
                                [setting.setting_key]: { ...row, revealed: !row.revealed },
                              }))
                            }
                            title={row.revealed ? 'Hide' : 'Show'}
                          >
                            {row.revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={!isDirty || row.saving}
                          onClick={() => handleSave(setting.setting_key)}
                        >
                          {row.saving && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                          Save
                        </Button>
                      </div>
                      {hasValue && setting.is_secret && (
                        <p className="text-[10px] text-muted-foreground font-mono">
                          Currently stored (masked). Type a new value to replace.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
