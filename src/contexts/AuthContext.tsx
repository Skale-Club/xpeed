import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import * as google from '@/lib/auth/google';
import { setCurrentUser, type AppUser } from '@/lib/auth/session';
import { queryClient } from '@/lib/query-client';

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  error: string | null;
  sendPhoneCode: (phone: string) => Promise<void>;
  verifyPhoneCode: (phone: string, code: string) => Promise<void>;
  signInWithGoogle: (nextPath?: string) => Promise<void>;
  signInWithGoogleIdToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  updateName: (name: string) => Promise<void>;
}

const AuthContext: React.Context<AuthContextType | undefined> =
  import.meta.hot?.data.AuthContext ?? createContext<AuthContextType | undefined>(undefined);
if (import.meta.hot) import.meta.hot.data.AuthContext = AuthContext;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const identityUid = useRef<string | null>(null);
  const registration = useRef<{ uid: string; promise: Promise<AppUser> } | null>(null);

  const synchronize = async (identity: google.IdentityUser | null) => {
    const version = ++generation.current;
    if (!identity) {
      queryClient.clear();
      identityUid.current = null; registration.current = null;
      setCurrentUser(null); setUser(null); setLoading(false); setError(null); return;
    }
    if (identityUid.current !== identity.uid) {
      queryClient.clear();
      identityUid.current = identity.uid;
      setCurrentUser(null); setUser(null); setLoading(true);
    }
    try {
      if (registration.current?.uid !== identity.uid) {
        const promise = (async () => {
          const { data, error: dbError } = await supabase.rpc('register_google_user' as never);
          if (dbError) throw dbError;
          return data as unknown as AppUser;
        })();
        registration.current = { uid: identity.uid, promise };
      }
      const request = registration.current;
      const account = await request.promise;
      if (registration.current === request) registration.current = null;
      if (!account?.id) throw new Error('Account could not be loaded');
      if (version !== generation.current) return;
      setCurrentUser(account); setUser(account); setError(null);
    } catch (cause) {
      if (registration.current?.uid === identity.uid) registration.current = null;
      if (version === generation.current) { setCurrentUser(null); setUser(null); setError(cause instanceof Error ? cause.message : 'Account could not be loaded'); }
      throw cause;
    } finally { if (version === generation.current) setLoading(false); }
  };

  useEffect(() => {
    const lifecycle = generation;
    let unsubscribe: (() => void) | undefined;
    const failed = (cause: Error) => {
      ++lifecycle.current;
      registration.current = null; identityUid.current = null;
      setCurrentUser(null); setUser(null); setError(cause.message); setLoading(false);
    };
    try {
      unsubscribe = google.observeGoogleUser(
        (identity) => { void synchronize(identity).catch(() => {}); },
        failed,
      );
    } catch (cause) { failed(cause instanceof Error ? cause : new Error('Authentication unavailable')); }
    return () => { ++lifecycle.current; unsubscribe?.(); setCurrentUser(null); };
  }, []);

  const verifyPhoneCode = async (phone: string, code: string) => { await synchronize(await google.verifyPhoneCode(phone, code)); };
  const signInWithGoogle = async () => { await synchronize(await google.signInWithGoogle()); };
  const signInWithGoogleIdToken = async (token: string) => { await synchronize(await google.signInWithGoogleIdToken(token)); };
  const signOut = async () => { await google.signOutGoogle(); await synchronize(null); };
  const updateName = async (name: string) => {
    const { error: dbError } = await supabase.rpc('update_account_name' as never, { p_name: name } as never);
    if (dbError) throw dbError;
    await google.updateDisplayName(name);
    setUser((previous) => {
      const updated = previous ? { ...previous, user_metadata: { ...previous.user_metadata, full_name: name } } : null;
      setCurrentUser(updated); return updated;
    });
  };

  return <AuthContext.Provider value={{ user, loading, error, sendPhoneCode: google.sendPhoneCode, verifyPhoneCode, signInWithGoogle, signInWithGoogleIdToken, signOut, updateName }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
