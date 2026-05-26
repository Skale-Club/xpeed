import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Plug, Loader2, Copy, Check, AlertTriangle, Trash2, Plus, Key, ShieldCheck } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  listMcpTokens, createMcpToken, revokeMcpToken, type McpToken,
} from '@/lib/mcp-tokens';
import { supabase } from '@/integrations/supabase/client';

const MCP_ENDPOINT = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xpeed-mcp`;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function CopyButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button size="sm" variant="outline" onClick={handleCopy} className={className}>
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </Button>
  );
}

export default function McpTokensSection() {
  const { toast } = useToast();
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newTokenName, setNewTokenName] = useState('');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [sessionJwt, setSessionJwt] = useState<string | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const [tokenList, session] = await Promise.all([
        listMcpTokens(),
        supabase.auth.getSession(),
      ]);
      setTokens(tokenList);
      setSessionJwt(session.data.session?.access_token ?? null);
    } catch (err) {
      toast({ title: 'Failed to load tokens', description: String(err), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newTokenName.trim()) return;
    setCreating(true);
    try {
      const { token } = await createMcpToken(newTokenName.trim());
      setGeneratedToken(token);
      setNewTokenName('');
      await load();
    } catch (err) {
      toast({ title: 'Failed to create token', description: String(err), variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  const handleCloseDialog = () => {
    setShowCreateDialog(false);
    setGeneratedToken(null);
    setNewTokenName('');
  };

  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      await revokeMcpToken(id);
      toast({ title: 'Token revoked' });
      await load();
    } catch (err) {
      toast({ title: 'Failed to revoke', description: String(err), variant: 'destructive' });
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Plug className="w-5 h-5 text-primary" />
            <h3 className="text-sm font-mono font-semibold text-foreground">MCP Server</h3>
          </div>
          <Button size="sm" onClick={() => setShowCreateDialog(true)} className="font-mono text-xs">
            <Plus className="w-3.5 h-3.5 mr-1" /> New Token
          </Button>
        </div>

        {/* Endpoint */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">Endpoint</p>
          <div className="flex gap-2">
            <Input value={MCP_ENDPOINT} readOnly className="font-mono text-xs h-8" />
            <CopyButton value={MCP_ENDPOINT} />
          </div>
        </div>

        {/* Auth methods */}
        <Tabs defaultValue="apikey" className="w-full">
          <TabsList className="h-7 text-xs w-full">
            <TabsTrigger value="apikey" className="flex-1 text-xs gap-1.5">
              <Key className="w-3 h-3" /> API Key
            </TabsTrigger>
            <TabsTrigger value="oauth" className="flex-1 text-xs gap-1.5">
              <ShieldCheck className="w-3 h-3" /> OAuth / JWT
            </TabsTrigger>
          </TabsList>

          {/* API key tab */}
          <TabsContent value="apikey" className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Persistent tokens — ideal for AI agents (Claude.ai, Cursor, etc). Revocable at any time.
              Each token grants read-only access to <strong>your</strong> data only.
            </p>

            {loading ? (
              <div className="text-center py-4">
                <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
              </div>
            ) : tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground font-mono text-center py-4">
                No tokens yet. Generate one to connect an AI agent.
              </p>
            ) : (
              <div className="space-y-2">
                {tokens.map((t) => {
                  const isRevoked = !!t.revoked_at;
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded border border-border ${isRevoked ? 'opacity-50' : ''}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono font-medium text-foreground truncate">
                          {t.name}
                          {t.token_prefix && (
                            <span className="ml-2 text-[10px] text-muted-foreground">{t.token_prefix}…</span>
                          )}
                          {isRevoked && <span className="ml-2 text-[9px] uppercase text-destructive">revoked</span>}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          Created {formatDate(t.created_at)} · Last used {formatDate(t.last_used_at)}
                        </div>
                      </div>
                      {!isRevoked && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleRevoke(t.id)}
                          disabled={revokingId === t.id}
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        >
                          {revokingId === t.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* OAuth / JWT tab */}
          <TabsContent value="oauth" className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Your current session JWT works directly as a Bearer token — no API key needed.
              Issued by Supabase Auth (supports Google OAuth, email/password, etc).
              Expires in ~1 hour; use API keys for long-lived integrations.
            </p>

            {sessionJwt ? (
              <div className="space-y-2">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wide">Session JWT</p>
                <div className="flex gap-2">
                  <Input
                    value={sessionJwt}
                    readOnly
                    className="font-mono text-xs h-8"
                    type="password"
                  />
                  <CopyButton value={sessionJwt} />
                </div>
                <p className="text-[10px] text-muted-foreground font-mono">
                  Usage: <code className="bg-muted px-1 rounded">Authorization: Bearer &lt;jwt&gt;</code>
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground font-mono text-center py-4">
                No active session found.
              </p>
            )}
          </TabsContent>
        </Tabs>

        {/* Create token dialog */}
        <Dialog open={showCreateDialog} onOpenChange={(o) => { if (!o) handleCloseDialog(); else setShowCreateDialog(true); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{generatedToken ? 'Token Generated' : 'New API Key Token'}</DialogTitle>
              <DialogDescription>
                {generatedToken
                  ? 'Copy this token now — it will not be shown again.'
                  : 'Name the token so you know where it will be used (e.g. "Claude.ai", "Cursor").'}
              </DialogDescription>
            </DialogHeader>

            {generatedToken ? (
              <div className="space-y-3">
                <Alert>
                  <AlertTriangle className="w-4 h-4" />
                  <AlertDescription className="text-xs">
                    This token will <strong>only be shown once</strong>. Store it somewhere safe.
                  </AlertDescription>
                </Alert>
                <div className="flex gap-2">
                  <Input value={generatedToken} readOnly className="font-mono text-xs" />
                  <CopyButton value={generatedToken} />
                </div>
                <div className="text-[10px] text-muted-foreground font-mono space-y-1">
                  <p>Endpoint: <code className="bg-muted px-1 rounded">{MCP_ENDPOINT}</code></p>
                  <p>Header: <code className="bg-muted px-1 rounded">X-API-Key: {generatedToken.slice(0, 12)}…</code></p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="token-name" className="text-xs font-mono">Token name</Label>
                  <Input
                    id="token-name"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                    placeholder="Claude.ai"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              {generatedToken ? (
                <Button onClick={handleCloseDialog}>Done</Button>
              ) : (
                <>
                  <Button variant="outline" onClick={handleCloseDialog}>Cancel</Button>
                  <Button onClick={handleCreate} disabled={!newTokenName.trim() || creating}>
                    {creating && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
                    Generate
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
