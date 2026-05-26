// OAuth 2.1 authorization endpoint (user-facing consent page).
// Reads OAuth params from query string, requires Supabase auth, shows consent UI,
// then calls /api/oauth/issue-code and redirects back to the client's redirect_uri.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, ShieldCheck, AlertTriangle, ExternalLink } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

interface OAuthParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
}

function parseParams(search: URLSearchParams): { params: OAuthParams | null; error: string | null } {
  const required = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method'];
  for (const key of required) {
    if (!search.get(key)) return { params: null, error: `Missing required parameter: ${key}` };
  }
  if (search.get('response_type') !== 'code') {
    return { params: null, error: 'Only response_type=code is supported' };
  }
  if (search.get('code_challenge_method') !== 'S256') {
    return { params: null, error: 'Only code_challenge_method=S256 is supported' };
  }
  return {
    params: {
      client_id: search.get('client_id')!,
      redirect_uri: search.get('redirect_uri')!,
      response_type: search.get('response_type')!,
      code_challenge: search.get('code_challenge')!,
      code_challenge_method: search.get('code_challenge_method')!,
      state: search.get('state'),
      scope: search.get('scope'),
    },
    error: null,
  };
}

export default function OAuthAuthorize() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const { params, error: paramErr } = useMemo(() => parseParams(searchParams), [searchParams]);

  // If not authenticated, bounce to login preserving the full URL
  useEffect(() => {
    if (!authLoading && !user) {
      const returnTo = window.location.pathname + window.location.search;
      navigate(`/login?next=${encodeURIComponent(returnTo)}`, { replace: true });
    }
  }, [authLoading, user, navigate]);

  const handleApprove = async () => {
    if (!params) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const jwt = sessionData.session?.access_token;
      if (!jwt) {
        setErrorMsg('No active session. Please log in again.');
        setSubmitting(false);
        return;
      }

      const res = await fetch('/api/oauth/issue-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          client_id: params.client_id,
          redirect_uri: params.redirect_uri,
          code_challenge: params.code_challenge,
          code_challenge_method: params.code_challenge_method,
          scope: params.scope || 'mcp',
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error_description || json.error || 'Failed to issue code');
        setSubmitting(false);
        return;
      }

      const url = new URL(params.redirect_uri);
      url.searchParams.set('code', json.code);
      if (params.state) url.searchParams.set('state', params.state);
      window.location.replace(url.toString());
    } catch (err) {
      setErrorMsg(String(err));
      setSubmitting(false);
    }
  };

  const handleDeny = () => {
    if (!params) return;
    const url = new URL(params.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied the authorization request');
    if (params.state) url.searchParams.set('state', params.state);
    window.location.replace(url.toString());
  };

  if (paramErr) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 space-y-3">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              <h1 className="font-mono text-sm font-semibold">Invalid OAuth Request</h1>
            </div>
            <p className="text-xs text-muted-foreground font-mono">{paramErr}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (authLoading || !user || !params) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  // Best-effort: extract a clean hostname from the redirect_uri for display
  let clientHost = params.redirect_uri;
  try { clientHost = new URL(params.redirect_uri).host; } catch { /* ignore */ }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-md w-full">
        <CardContent className="p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="font-mono text-sm font-semibold text-foreground">Authorize Connection</h1>
              <p className="text-[10px] text-muted-foreground font-mono">Xpeed MCP Server</p>
            </div>
          </div>

          <div className="space-y-2 text-xs font-mono text-muted-foreground">
            <p>
              <span className="text-foreground font-semibold">{clientHost}</span> is requesting access
              to your Xpeed vehicle data via the MCP API.
            </p>
            <p>This will allow it to:</p>
            <ul className="list-disc list-inside space-y-1 ml-2 text-[11px]">
              <li>List your vehicle profiles</li>
              <li>Read your diagnostic sessions and AI analyses</li>
              <li>Read maintenance logs and diagnostic flags</li>
            </ul>
            <p className="text-[10px] pt-1">
              Access is <strong>read-only</strong> and tied to your account ({user.email}).
              You can revoke access at any time.
            </p>
          </div>

          <div className="text-[10px] font-mono text-muted-foreground bg-muted/30 rounded p-2 space-y-1">
            <div className="flex items-center gap-1 text-foreground">
              <ExternalLink className="w-3 h-3" />
              <span className="font-semibold">Redirect target</span>
            </div>
            <code className="break-all">{params.redirect_uri}</code>
          </div>

          {errorMsg && (
            <Alert variant="destructive">
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription className="text-xs font-mono">{errorMsg}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={handleDeny} disabled={submitting}>
              Deny
            </Button>
            <Button className="flex-1" onClick={handleApprove} disabled={submitting}>
              {submitting && <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />}
              Approve
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
