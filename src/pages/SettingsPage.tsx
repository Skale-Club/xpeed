import { useState, useEffect } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, Sparkles, Globe, Info, Key, Copy, Check, Trash2, Plus } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useSettings } from '@/contexts/SettingsContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import McpTokensSection from '@/components/McpTokensSection';

interface McpToken {
  id: string;
  name: string;
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export default function SettingsPage() {
  const { distanceUnit, setDistanceUnit, timezone, setTimezone } = useSettings();
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const timezones = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [Intl.DateTimeFormat().resolvedOptions().timeZone];

  useEffect(() => {
    loadTokens();
  }, []);

  async function api(action: string, body?: Record<string, unknown>) {
    return supabase.functions.invoke('manage-mcp-tokens', { body: { action, ...body } });
  }

  async function loadTokens() {
    setLoading(true);
    const { data, error } = await api('list');
    if (!error && data?.tokens) setTokens(data.tokens);
    setLoading(false);
  }

  async function generateToken() {
    const { data, error } = await api('create', { name: `MCP Token ${new Date().toLocaleDateString()}` });
    if (error) return;
    setNewToken(data.token);
    await loadTokens();
  }

  async function revokeToken(id: string) {
    await api('revoke', { token_id: id });
    setTokens((prev) => prev.filter((t) => t.id !== id));
  }

  async function copyToken() {
    if (newToken) {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
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
              <Key className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">MCP Integration</h3>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed mb-4">
              MCP (Model Context Protocol) tokens allow AI agents like Claude Desktop, Cursor, and OpenCode
              to read your vehicle data. Tokens expire in 30 days.
            </p>

            {newToken && (
              <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-md">
                <p className="text-xs font-mono font-semibold text-amber-600 dark:text-amber-400 mb-1">
                  Save this token — it will not be shown again!
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-background p-2 rounded border break-all select-all">
                    {newToken}
                  </code>
                  <Button variant="outline" size="icon" onClick={copyToken} className="shrink-0">
                    {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-mono text-muted-foreground">
                {tokens.length} active token{tokens.length !== 1 ? 's' : ''}
              </span>
              <Button variant="outline" size="sm" onClick={generateToken} className="gap-1">
                <Plus className="w-3.5 h-3.5" />
                Generate Token
              </Button>
            </div>

            {loading ? (
              <p className="text-xs text-muted-foreground">Loading tokens...</p>
            ) : tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active tokens. Generate one to connect MCP clients.</p>
            ) : (
              <div className="space-y-2">
                {tokens.map((token) => (
                  <div key={token.id} className="flex items-center justify-between p-2 bg-muted/50 rounded border">
                    <div className="min-w-0">
                      <p className="text-xs font-mono font-medium truncate">{token.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {token.token_prefix}...
                        {token.last_used_at && ` \u00B7 Last used ${new Date(token.last_used_at).toLocaleDateString()}`}
                        {token.expires_at && ` \u00B7 Expires ${new Date(token.expires_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => revokeToken(token.id)} className="text-destructive shrink-0">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Sparkles className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">AI Assistant</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              AI features (session analysis + chat) are powered by a shared Google Gemini key configured by the
              system administrator. No per-user setup is required. Daily fair-use limits apply.
            </p>
          </CardContent>
        </Card>

        {/* MCP Tokens */}
        <McpTokensSection />

        {/* About */}
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3 mb-2">
              <Info className="w-5 h-5 text-primary" />
              <h3 className="text-sm font-mono font-semibold text-foreground">About</h3>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Xpeed is a personal data viewer for OBD2 logs exported from Car Scanner, Torque Pro,
              and similar apps. Manage multiple vehicles and track their health separately. Always consult a
              professional for serious vehicle issues.
            </p>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
