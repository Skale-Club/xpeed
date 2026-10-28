import { useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Car } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { useBrand, isDefaultBrand } from '@/hooks/use-brand';

export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // S02: only allow in-app paths; reject protocol-relative (`//evil.com`) and absolute URLs.
  const rawNext = searchParams.get('next');
  const nextPath = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null;
  const { signIn, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const brand = useBrand();
  const useCustomLogo = !isDefaultBrand(brand);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await signIn(email, password);
      // Honor ?next=... for return-to flows (e.g. OAuth authorize)
      navigate(nextPath ?? '/');
    } catch (err: unknown) {
      let errorMessage = err instanceof Error ? err.message : t('auth.signInFailed', "We couldn't sign you in. Please try again.");

      // Provide helpful error messages
      if (errorMessage.includes('Invalid login')) {
        errorMessage = t('auth.wrongEmailOrPassword', 'Wrong email or password. Please check and try again.');
      } else if (errorMessage.includes('Email not confirmed')) {
        errorMessage = t('auth.emailNotConfirmed', "Your email isn't confirmed yet. Open the link we sent to your inbox, then sign in again.");
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setGoogleLoading(true);

    try {
      await signInWithGoogle();
      // OAuth redirect will handle navigation
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.googleSignInFailed', "We couldn't sign you in with Google. Please try again."));
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center space-y-2">
          <div className="w-16 h-16 flex items-center justify-center bg-primary/10 rounded-full overflow-hidden">
            {useCustomLogo ? (
              <img src={brand.logo_url} alt={t('auth.logoAlt', 'Logo')} className="w-12 h-12 object-contain" />
            ) : (
              <Car className="w-8 h-8 text-primary" />
            )}
          </div>
          <h1 className="text-2xl font-bold text-foreground">Xpeed</h1>
          <p className="text-sm text-muted-foreground">{t('auth.signInSubtitle', 'Sign in to your account')}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('auth.welcomeBack', 'Welcome back')}</CardTitle>
            <CardDescription>
              {t('auth.signInDescription', 'Enter your email and password to see your car.')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email', 'Email')}</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder={t('auth.emailPlaceholder', 'you@example.com')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password', 'Password')}</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t('auth.signingIn', 'Signing in…')}
                  </>
                ) : (
                  t('auth.signIn', 'Sign in')
                )}
              </Button>
            </form>

            {/* Google OAuth — hidden until configured */}

            <div className="mt-4 text-center text-sm">
              <span className="text-muted-foreground">{t('auth.noAccount', "Don't have an account?")} </span>
              <Link to="/signup" className="text-primary hover:underline">
                {t('auth.signUp', 'Sign up')}
              </Link>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          {t('auth.signInTerms', 'By signing in, you agree to our Terms of Service and Privacy Policy.')}
        </p>
      </div>
    </div>
  );
}
