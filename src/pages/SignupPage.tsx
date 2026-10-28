import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Loader2, Car, CheckCircle } from 'lucide-react';
import { useBrand, isDefaultBrand } from '@/hooks/use-brand';

export default function SignupPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signUp, signInWithGoogle } = useAuth();
  const brand = useBrand();
  const useCustomLogo = !isDefaultBrand(brand);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError(t('auth.passwordsDontMatch', "The two passwords don't match."));
      return;
    }

    if (password.length < 6) {
      setError(t('auth.passwordTooShort', 'Your password needs at least 6 characters.'));
      return;
    }

    setLoading(true);

    try {
      const { data } = await signUp(email, password);
      
      // If a session is returned, email confirmation is disabled or not required
      if (data.session) {
        navigate('/');
      } else {
        setSuccess(true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        message.includes('already registered')
          ? t('auth.alreadyRegistered', 'There is already an account with this email. Try signing in instead.')
          : message || t('auth.signUpFailed', "We couldn't create your account. Please try again."),
      );
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    setError('');
    setGoogleLoading(true);

    try {
      await signInWithGoogle();
      // OAuth redirect will handle navigation
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.googleSignUpFailed', "We couldn't sign you up with Google. Please try again."));
      setGoogleLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-md space-y-6">
          <div className="flex flex-col items-center space-y-2">
            <div className="w-16 h-16 flex items-center justify-center bg-success/10 rounded-full">
              <CheckCircle className="w-8 h-8 text-success" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">{t('auth.accountCreated', 'Account created!')}</h1>
          </div>

          <Card>
            <CardContent className="pt-6 text-center space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('auth.checkEmail', 'Check your email and open the link we sent to confirm your account. Then you can sign in.')}
              </p>
              <Button onClick={() => navigate('/login')} className="w-full">
                {t('auth.goToSignIn', 'Go to sign in')}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

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
          <p className="text-sm text-muted-foreground">{t('auth.signUpSubtitle', 'Create your account')}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t('auth.createAccount', 'Create account')}</CardTitle>
            <CardDescription>
              {t('auth.signUpDescription', "Start keeping an eye on your car's health.")}
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
                <p className="text-xs text-muted-foreground">
                  {t('auth.passwordHint', 'At least 6 characters')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t('auth.confirmPassword', 'Confirm password')}</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
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
                    {t('auth.creatingAccount', 'Creating your account…')}
                  </>
                ) : (
                  t('auth.createAccount', 'Create account')
                )}
              </Button>
            </form>

            {/* Google OAuth — hidden until configured */}

            <div className="mt-4 text-center text-sm">
              <span className="text-muted-foreground">{t('auth.haveAccount', 'Already have an account?')} </span>
              <Link to="/login" className="text-primary hover:underline">
                {t('auth.signIn', 'Sign in')}
              </Link>
            </div>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          {t('auth.signUpTerms', 'By creating an account, you agree to our Terms of Service and Privacy Policy.')}
        </p>
      </div>
    </div>
  );
}
