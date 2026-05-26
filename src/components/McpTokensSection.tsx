import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Plug, Loader2, Copy, Check, AlertTriangle, Trash2, Plus } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  listMcpTokens, createMcpToken, revokeMcpToken, type McpToken,
} from '@/lib/mcp-tokens';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
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
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setTokens(await listMcpTokens());
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

  const handleCopy = async () => {
    if (!generatedToken) return;
    await navigator.clipboard.writeText(generatedToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCloseDialog = () => {
    setShowCreateDialog(false);
    setGeneratedToken(null);
    setNewTokenName('');
    setCopied(false);
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
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Plug className="w-5 h-5 text-primary" />
            <h3 className="text-sm font-mono font-semibold text-foreground">MCP Tokens</h3>
          </div>
          <Button size="sm" onClick={() => setShowCreateDialog(true)} className="font-mono text-xs">
            <Plus className="w-3.5 h-3.5 mr-1" /> Generate
          </Button>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">
          Tokens let AI agents (Claude.ai, Cursor, etc) query your vehicle data via the MCP endpoint.
          Each token sees only your data. Treat them like passwords — they grant read access to all your sessions.
        </p>

        {loading ? (
          <div className="text-center py-6">
            <Loader2 className="w-5 h-5 animate-spin mx-auto text-primary" />
          </div>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground font-mono text-center py-6">
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

        <Dialog open={showCreateDialog} onOpenChange={(o) => { if (!o) handleCloseDialog(); else setShowCreateDialog(true); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{generatedToken ? 'Token Generated' : 'New MCP Token'}</DialogTitle>
              <DialogDescription>
                {generatedToken
                  ? 'Copy this token now. You will not be able to see it again.'
                  : 'Give the token a name to identify where you will use it (e.g. "Claude.ai", "Cursor").'}
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
                  <Button size="sm" variant="outline" onClick={handleCopy}>
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">
                  Use as: <code>X-API-Key: {generatedToken.slice(0, 12)}…</code><br />
                  Or in URL: <code>?key={generatedToken.slice(0, 12)}…</code>
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="token-name" className="text-xs font-mono">Token name</Label>
                  <Input
                    id="token-name"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
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
