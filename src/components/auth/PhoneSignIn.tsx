import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Loader2, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CountryFlag } from '@/components/auth/CountryFlag';
import { useAuth } from '@/contexts/AuthContext';
import { PHONE_COUNTRIES, formatPhone, maskPhoneInput, normalizePhone, phoneCountryCodeFromLocales } from '@/lib/phone';

// Sign in (or sign up: a new number just gets an account) with a code texted
// to the phone, the same flow as Xpot: number → 6-digit code, which is checked
// as soon as the last digit is typed.

const RESEND_AFTER_MS = 30_000;

type ErrorKind = 'invalid_phone' | 'wait' | 'sms_failed' | 'unavailable' | 'wrong_code' | 'generic';

/** Map a Supabase auth error to something a person can act on. */
function errorKind(err: unknown): { kind: ErrorKind; seconds?: number } {
  const e = err as { code?: string; status?: number; message?: string };
  const message = e?.message ?? '';
  const wait = /after (\d+) seconds?/i.exec(message);
  if (wait) return { kind: 'wait', seconds: Number(wait[1]) };
  if (e?.code === 'over_sms_send_rate_limit' || e?.code === 'over_request_rate_limit' || e?.status === 429) return { kind: 'wait', seconds: 60 };
  if (e?.code === 'phone_provider_disabled' || /phone (signups|provider).*(disabled|not enabled)|unsupported phone provider/i.test(message)) return { kind: 'unavailable' };
  if (e?.code === 'otp_expired' || /token has expired or is invalid|invalid otp/i.test(message)) return { kind: 'wrong_code' };
  if (e?.code === 'sms_send_failed' || /error sending (sms|confirmation)/i.test(message)) return { kind: 'sms_failed' };
  if (/invalid phone/i.test(message)) return { kind: 'invalid_phone' };
  return { kind: 'generic' };
}

export function PhoneSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const { t, i18n } = useTranslation();
  const { sendPhoneCode, verifyPhoneCode } = useAuth();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  // The app's language first (pt-BR → +55), then the browser's.
  const [countryCode, setCountryCode] = useState(() => phoneCountryCodeFromLocales([
    ...(i18n.resolvedLanguage ? [i18n.resolvedLanguage] : []),
    ...(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]),
  ]));
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const codeRef = useRef<HTMLInputElement>(null);

  // Resend countdown.
  useEffect(() => {
    if (step !== 'code') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (step === 'code') window.setTimeout(() => codeRef.current?.focus(), 50);
  }, [step]);

  const showError = (err: unknown) => {
    const { kind, seconds } = errorKind(err);
    const messages: Record<ErrorKind, string> = {
      invalid_phone: t('auth.phone.errInvalidPhone', 'Enter a valid phone number.'),
      wait: t('auth.phone.errWait', 'Wait {{seconds}}s before asking for another code.', { seconds: seconds ?? 30 }),
      sms_failed: t('auth.phone.errSmsFailed', "We couldn't send the SMS. Check the number and try again."),
      unavailable: t('auth.phone.errUnavailable', 'Signing in by phone is not available yet. Use Google for now.'),
      wrong_code: t('auth.phone.errWrongCode', 'Wrong or expired code. Check the SMS or ask for a new one.'),
      generic: t('auth.phone.errGeneric', 'Something went wrong. Try again.'),
    };
    setError(messages[kind]);
  };

  const sendCode = async (target: string) => {
    setBusy(true);
    setError('');
    try {
      await sendPhoneCode(target);
      setPhone(target);
      setCode('');
      setResendAt(Date.now() + RESEND_AFTER_MS);
      setNow(Date.now());
      setStep('code');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const submitPhone = (e: FormEvent) => {
    e.preventDefault();
    const e164 = normalizePhone(phoneInput, countryCode);
    if (!e164) return setError(t('auth.phone.errInvalidPhone', 'Enter a valid phone number.'));
    void sendCode(e164);
  };

  const verify = async (value: string) => {
    setBusy(true);
    setError('');
    try {
      await verifyPhoneCode(phone, value);
      onSignedIn();
    } catch (err) {
      setCode('');
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const onCode = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !busy) void verify(digits);
  };

  const restart = () => {
    setStep('phone');
    setCode('');
    setError('');
  };

  const errorBox = error && (
    <Alert variant="destructive" data-testid="signin-error">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );

  if (step === 'code') {
    const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) void verify(code);
        }}
        className="space-y-4"
        data-testid="signin-code"
      >
        <button type="button" onClick={restart} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('auth.phone.changeNumber', 'Use another number')}
        </button>
        <div>
          <p className="text-lg font-semibold">{t('auth.phone.codeTitle', 'Enter the code')}</p>
          <p className="text-sm text-muted-foreground">{t('auth.phone.codeSent', 'We texted a 6-digit code to {{phone}}.', { phone: formatPhone(phone) })}</p>
        </div>
        {errorBox}
        <Input
          ref={codeRef}
          value={code}
          onChange={(e) => onCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          aria-label={t('auth.phone.codeLabel', '6-digit code')}
          placeholder="••••••"
          className="h-12 text-center font-mono text-2xl tracking-[0.5em]"
          data-testid="input-code"
        />
        <Button type="submit" size="lg" className="w-full" disabled={busy || code.length !== 6}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('auth.phone.verify', 'Continue')}
        </Button>
        <button
          type="button"
          disabled={busy || wait > 0}
          onClick={() => void sendCode(phone)}
          className="w-full text-sm text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
        >
          {wait > 0 ? t('auth.phone.resendIn', 'New code in {{seconds}}s', { seconds: wait }) : t('auth.phone.resend', 'Send a new code')}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitPhone} className="space-y-4" data-testid="signin-phone">
      {errorBox}
      <div className="space-y-2">
        <Label htmlFor="signin-phone">{t('auth.phone.phoneLabel', 'Phone number')}</Label>
        <div className="flex h-12 gap-2">
          <Select
            value={countryCode}
            onValueChange={(next) => {
              setCountryCode(next);
              setPhoneInput((current) => maskPhoneInput(current, next));
            }}
          >
            <SelectTrigger className="h-12 w-auto gap-2" aria-label={t('auth.phone.country', 'Country')} data-testid="select-country-code">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PHONE_COUNTRIES.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  <span className="flex items-center gap-2">
                    <CountryFlag iso={c.iso} />
                    <span className="tabular-nums">+{c.code}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="signin-phone"
              value={phoneInput}
              onChange={(e) => setPhoneInput(maskPhoneInput(e.target.value, countryCode))}
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder={countryCode === '55' ? '(11) 98765-4321' : countryCode === '1' ? '(508) 555-0100' : ''}
              autoFocus
              required
              className="h-12 pl-10 text-base"
              data-testid="input-phone"
            />
          </div>
        </div>
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={busy || phoneInput.replace(/\D/g, '').length < 7} data-testid="button-send-code">
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('auth.phone.sendCode', 'Send code')}
        {!busy && <ArrowRight className="ml-2 h-4 w-4" />}
      </Button>
    </form>
  );
}
