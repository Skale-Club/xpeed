// Only bundled by vite.harness.config.ts; never used by production.
import { supabase } from './fake-supabase';
export interface IdentityUser { uid: string }
export async function getAccessToken() { return (await supabase.auth.getSession()).data.session?.access_token ?? null; }
export function observeGoogleUser(callback: (user: IdentityUser | null) => void) {
  let active = true;
  const emit = async () => { const { data } = await supabase.auth.getUser(); if (active) callback(data.user ? { uid: data.user.id } : null); };
  const { data: { subscription } } = supabase.auth.onAuthStateChange(() => { void emit(); });
  void emit();
  return () => { active = false; subscription.unsubscribe(); };
}
export async function sendPhoneCode(phone: string) { await supabase.auth.signInWithOtp(); void phone; }
export async function verifyPhoneCode(phone: string, code: string) {
  const { data, error } = await supabase.auth.verifyOtp({ token: code });
  if (error) throw Object.assign(new Error(error.message), { code: 'auth/invalid-verification-code' });
  void phone;
  return { uid: data.user!.id };
}
export async function signInWithGoogle() { throw new Error('Use test SMS code 123456 in the harness'); }
export async function signOutGoogle() { await supabase.auth.signOut(); }
export function cancelPhoneChallenge() {}
export async function updateDisplayName(name: string) { await supabase.auth.updateUser({ data: { full_name: name } }); }

export async function signInWithGoogleIdToken() { throw new Error('Use the simulated SMS flow'); }
