import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sparkles, Loader2, Eye, EyeOff, CheckCircle, Plug } from 'lucide-react';
import { listAdminSettings, upsertAdminSetting } from '@/lib/db-extras';
import { chatViaEdge } from '@/lib/ai-client';
import { useToast } from '@/hooks/use-toast';

const KEY_SETTING = 'admin_secret_openrouter_api_key';
const MODEL_SETTING = 'admin_openrouter_model';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

// Common OpenRouter model ids (suggestions only — any valid slug works).
const MODEL_PRESETS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.7-sonnet',
  'google/gemini-2.0-flash-001',
  'deepseek/deepseek-chat',
  'meta-llama/llama-3.3-70b-instruct',
];

export default function AIProviderSection() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [apiKey, setApiKey] = useState('');
  const [keyStored, setKeyStored] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [model, setModel] = useState('');
  const [initialKey, setInitialKey] = useState<string | null>(null);
  const [initialModel, setInitialModel] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await listAdminSettings();
        const key = data.find((s) => s.setting_key === KEY_SETTING)?.setting_value ?? null;
        const mdl = data.find((s) => s.setting_key === MODEL_SETTING)?.setting_value ?? null;
        setKeyStored(!!key);
        setInitialKey(key);
        setInitialModel(mdl);
        setApiKey(key ?? '');
        setModel(mdl ?? '');
      } catch (err) {
        toast({ title: 'Failed to load AI settings', description: String(err), variant: 'destructive' });
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  const keyDirty = (apiKey.trim() || null) !== initialKey;
  const modelDirty = (model.trim() || null) !== initialModel;
  const isDirty = keyDirty || modelDirty;

  const handleSave = async () => {
    setSaving(true);
    try {
      if (keyDirty) {
        const v = apiKey.trim() === '' ? null : apiKey.trim();
        await upsertAdminSetting(KEY_SETTING, v);
        setInitialKey(v);
        setKeyStored(!!v);
      }
      if (modelDirty) {
        const v = model.trim() === '' ? null : model.trim();
        await upsertAdminSetting(MODEL_SETTING, v);
        setInitialModel(v);
      }
      toast({ title: 'Saved', description: 'AI provider settings updated.' });
    } catch (err) {
      toast({ title: 'Save failed', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const reply = await chatViaEdge(
        [],
        'Reply with the single word: OK',
        {},
      );
      if (reply && reply.trim().length > 0) {
        toast({ title: 'Connection OK', description: `Model replied: "${reply.slice(0, 60)}"` });
      } else {
        toast({
          title: 'No reply',
          description: 'The AI endpoint returned nothing. Check the key and model, then save first.',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Test failed', description: String(err), variant: 'destructive' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          AI Provider (OpenRouter)
          {keyStored && <CheckCircle className="w-3.5 h-3.5 text-success" />}
        </CardTitle>
        <CardDescription className="text-xs">
          Configure the shared OpenRouter key and default model used by session analysis and chat.
          Get a key at{' '}
          <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">
            openrouter.ai/keys
          </a>
          . Browse models at{' '}
          <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" className="underline">
            openrouter.ai/models
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
        ) : (
          <>
            {/* API key */}
            <div className="space-y-1.5">
              <Label htmlFor="or-key" className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                API Key
                <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-warn/10 text-warn">
                  secret
                </span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="or-key"
                  type={revealKey ? 'text' : 'password'}
                  placeholder="sk-or-v1-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="font-mono text-xs"
                  autoComplete="off"
                />
                <Button type="button" variant="outline" size="sm" className="px-3"
                  onClick={() => setRevealKey((v) => !v)} title={revealKey ? 'Hide' : 'Show'}>
                  {revealKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </Button>
              </div>
              {keyStored && (
                <p className="text-[10px] text-muted-foreground font-mono">
                  A key is stored (masked). Type a new value to replace it.
                </p>
              )}
            </div>

            {/* Model */}
            <div className="space-y-1.5">
              <Label htmlFor="or-model" className="text-xs font-mono text-muted-foreground">
                Default Model
              </Label>
              <Input
                id="or-model"
                list="or-model-presets"
                placeholder={DEFAULT_MODEL}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="font-mono text-xs"
              />
              <datalist id="or-model-presets">
                {MODEL_PRESETS.map((m) => <option key={m} value={m} />)}
              </datalist>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {MODEL_PRESETS.slice(0, 5).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setModel(m)}
                    className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                      model === m
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:border-primary/40'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">
                Leave empty to use the code default ({DEFAULT_MODEL}). Any valid OpenRouter slug works.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Button size="sm" disabled={!isDirty || saving} onClick={handleSave}>
                {saving && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                Save
              </Button>
              <Button size="sm" variant="outline" disabled={testing || !keyStored} onClick={handleTest}
                title={keyStored ? 'Send a test message through the chat function' : 'Save a key first'}>
                {testing ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <Plug className="w-3.5 h-3.5 mr-2" />}
                Test connection
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
