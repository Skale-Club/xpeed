import { useState, useEffect } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, Sparkles, Check, X, Loader2, Eye, EyeOff, Globe, Ruler } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { getGeminiApiKey, saveGeminiApiKey, deleteGeminiApiKey, getGeminiModel, saveGeminiModel } from '@/lib/db';
import { validateApiKey } from '@/lib/gemini-service';
import { PageLoader } from '@/components/PageLoader';
import { useSettings } from '@/contexts/SettingsContext';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function SettingsPage() {
  const { distanceUnit, setDistanceUnit, timezone, setTimezone } = useSettings();
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isTesting, setIsTesting] = useState(false);
  const [model, setModel] = useState('gemini-2.5-flash');
  const { toast } = useToast();
  
  const timezones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [Intl.DateTimeFormat().resolvedOptions().timeZone];

  // Load existing API key status on mount
  useEffect(() => {
    async function loadSettings() {
      const [key, savedModel] = await Promise.all([
        getGeminiApiKey(),
        getGeminiModel(),
      ]);
      
      setIsConfigured(!!key);
      if (key) {
        setApiKey('••••••••••••••••'); // Masked value
      }
      if (savedModel) {
        setModel(savedModel);
      }
    }
    loadSettings().finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (!apiKey || apiKey === '••••••••••••••••') {
      toast({ title: 'Error', description: 'Please enter a valid API key', variant: 'destructive' });
      return;
    }

    setIsLoading(true);
    try {
      await Promise.all([
        saveGeminiApiKey(apiKey),
        saveGeminiModel(model),
      ]);
      
      setIsConfigured(true);
      setApiKey('••••••••••••••••');
      setShowApiKey(false);
      toast({ title: 'Success', description: 'Settings saved successfully' });
    } catch (error) {
      toast({ title: 'Error', description: String(error), variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTest = async () => {
    if (!isConfigured && (!apiKey || apiKey === '••••••••••••••••')) {
      toast({ title: 'Error', description: 'Please enter an API key first', variant: 'destructive' });
      return;
    }

    setIsTesting(true);
    try {
      const keyToTest = isConfigured && apiKey === '••••••••••••••••'
        ? await getGeminiApiKey()
        : apiKey;

      if (!keyToTest) {
        toast({ title: 'Error', description: 'No API key to test', variant: 'destructive' });
        return;
      }

      const isValid = await validateApiKey(keyToTest, model);
      if (isValid) {
        toast({ title: 'Success', description: `Connection to ${model} successful!` });
      } else {
        toast({ title: 'Error', description: 'API key is invalid or model not supported', variant: 'destructive' });
      }
    } catch (error) {
      toast({ title: 'Error', description: `Test failed: ${String(error)}`, variant: 'destructive' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleRemove = async () => {
    setIsLoading(true);
    try {
      await deleteGeminiApiKey();
      setApiKey('');
      setIsConfigured(false);
      toast({ title: 'Success', description: 'API key removed' });
    } catch (error) {
      toast({ title: 'Error', description: String(error), variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (value: string) => {
    setApiKey(value);
    if (value === '••••••••••••••••') {
      // User is trying to edit masked key, clear it
      setApiKey('');
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <PageLoader fullScreen={false} />
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-mono font-bold text-foreground">Settings</h2>
        </div>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-4">
              <Globe className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">Preferences</h3>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs font-mono">Distance Unit</Label>
                <Select value={distanceUnit} onValueChange={(v: 'km' | 'mi') => setDistanceUnit(v)}>
                  <SelectTrigger className="font-mono text-xs">
                    <SelectValue placeholder="Select unit" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="km">Kilometers (km)</SelectItem>
                    <SelectItem value="mi">Miles (mi)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Used for displaying distances and speed.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs font-mono">Timezone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger className="font-mono text-xs">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[250px]">
                    {timezones.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Used for displaying dates and times.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-4">
              <Sparkles className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">Google Gemini AI</h3>
              {isConfigured && (
                <div className="ml-auto flex items-center gap-1 text-xs text-green-600">
                  <Check className="w-3 h-3" />
                  <span>Configured</span>
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="gemini-api-key" className="text-xs font-mono">
                  API Key
                </Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="gemini-api-key"
                      type={showApiKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => handleInputChange(e.target.value)}
                      placeholder="Enter your Gemini API key"
                      className="font-mono text-xs pr-10"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="absolute right-0 top-0 h-full px-3"
                      onClick={() => setShowApiKey(!showApiKey)}
                    >
                      {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Get your API key from{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    Google AI Studio
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="gemini-model" className="text-xs font-mono">
                  Model
                </Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id="gemini-model" className="font-mono text-xs">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gemini-2.5-flash">gemini-2.5-flash (Recommended)</SelectItem>
                    <SelectItem value="gemini-2.5-pro">gemini-2.5-pro</SelectItem>
                    <SelectItem value="gemini-2.0-flash">gemini-2.0-flash</SelectItem>
                    <SelectItem value="gemini-2.0-pro">gemini-2.0-pro</SelectItem>
                    <SelectItem value="gemini-1.5-flash">gemini-1.5-flash</SelectItem>
                    <SelectItem value="gemini-1.5-pro">gemini-1.5-pro</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleSave}
                  disabled={isLoading || !apiKey || apiKey === '••••••••••••••••'}
                  size="sm"
                  className="font-mono text-xs"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    'Save'
                  )}
                </Button>
                <Button
                  onClick={handleTest}
                  disabled={isTesting || (!isConfigured && !apiKey)}
                  variant="outline"
                  size="sm"
                  className="font-mono text-xs"
                >
                  {isTesting ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    'Test Connection'
                  )}
                </Button>
                {isConfigured && (
                  <Button
                    onClick={handleRemove}
                    disabled={isLoading}
                    variant="outline"
                    size="sm"
                    className="font-mono text-xs text-destructive hover:text-destructive"
                  >
                    <X className="w-3 h-3 mr-1" />
                    Remove
                  </Button>
                )}
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                When configured, Gemini AI will automatically analyze your OBD2 uploads and provide insights about your vehicle's health.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <h3 className="text-sm font-mono font-semibold text-foreground mb-2">About</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Car Insights AI is a personal data viewer for OBD2 logs exported from Car Scanner.
              Manage multiple vehicles and track their health separately. Always consult a professional for vehicle issues.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
