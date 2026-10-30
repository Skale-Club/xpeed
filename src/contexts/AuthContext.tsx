import { queryClient } from '@/lib/query-client';
import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { User, Session } from '@supabase/supabase-js';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** Email + password, kept for accounts created before phone sign-in. */
  signIn: (email: string, password: string) => Promise<void>;
  /** Text a 6-digit code to this E.164 number; a new number gets an account. */
  sendPhoneCode: (phone: string) => Promise<void>;
  /** Check the texted code; signs in on success. */
  verifyPhoneCode: (phone: string, code: string) => Promise<void>;
  /** Google sign-in; comes back to `nextPath` (default: home). */
  signInWithGoogle: (nextPath?: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
}

// Same context object when the dev server reloads this file: otherwise screens
// reloaded with it look for a provider that is no longer the one on screen.
const AuthContext: React.Context<AuthContextType | undefined> =
  import.meta.hot?.data.AuthContext ?? createContext<AuthContextType | undefined>(undefined);
if (import.meta.hot) import.meta.hot.data.AuthContext = AuthContext;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let owner: string | null | undefined;
    const accept = (next: Session | null) => {
      if (owner !== next?.user.id) queryClient.clear();
      owner = next?.user.id;
      setSession(next); setUser(next?.user ?? null); setLoading(false);
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      accept(nextSession);
    });

    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      accept(initialSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const sendPhoneCode = async (phone: string) => {
    const { error } = await supabase.auth.signInWithOtp({ phone });
    if (error) throw error;
  };

  const verifyPhoneCode = async (phone: string, code: string) => {
    const { error } = await supabase.auth.verifyOtp({ phone, token: code, type: 'sms' });
    if (error) throw error;
  };

  const signInWithGoogle = async (nextPath = '/') => {
    // Back to this same site (the production domain or a preview), which must
    // be in the Supabase Auth redirect URL list.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${nextPath}` },
    });
    if (error) {
      console.error('Google OAuth error:', error.message);
      throw error;
    }
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  const resetPassword = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) throw error;
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, sendPhoneCode, verifyPhoneCode, signInWithGoogle, signOut, resetPassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
