import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { getSharedReport } from '@/lib/db-extras';
import { Car, AlertCircle, Printer, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import DTCPanel from '@/components/DTCPanel';
import { describeProblem } from '@/lib/problems';
import { formatDuration, tripProblems, tripTitle } from '@/lib/trips';
import type { Session, SessionFlag } from '@/types/session';
import { BrandLogo } from '@/components/BrandLogo';

interface ReportPayload {
  session?: Record<string, unknown> | null;
  car?: Record<string, unknown> | null;
  flags?: Array<Record<string, unknown>>;
  active_dtcs?: string[];
}

/**
 * Public read-only view of a shared diagnostic report.
 * Route: /share/:id   (anon-accessible via RPC bypassing RLS)
 */
export default function SharedReport() {
  const { t, i18n } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!id) {
      setError(true);
      setLoading(false);
      return;
    }
    (async () => {
      const data = await getSharedReport(id);
      if (!data) setError(true);
      else setReport(data as ReportPayload);
      setLoading(false);
    })();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full border-border">
          <CardContent className="p-6 text-center">
            <AlertCircle className="w-10 h-10 text-destructive mx-auto mb-3" />
            <h2 className="text-base font-semibold text-foreground">{t('sharedReport.unavailableTitle', 'Report unavailable')}</h2>
            <p className="text-sm text-muted-foreground mt-2">
              {t('sharedReport.unavailableBody', 'This link may have expired or been turned off. Ask the car owner for a new link.')}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const session = report.session as Record<string, unknown> | null;
  const car = report.car as Record<string, unknown> | null;
  const flags = (report.flags || []) as unknown as Array<{ severity: string; canonical_key: string; parameter_key: string; message: string; evidence?: Record<string, unknown> }>;
  const dtcs = report.active_dtcs || [];

  const carHeadline = car ? (
    (car.year && car.make && car.model) ? `${car.year} ${car.make} ${car.model}` : (car.name as string | undefined) || t('sharedReport.carFallback', 'Car')
  ) : t('sharedReport.carFallback', 'Car');

  const sessionDate = session?.session_start || session?.uploaded_at;
  const tripName = session ? tripTitle(session as unknown as Session, t) : t('sharedReport.tripFallback', 'Trip recording');
  // Same plain-language wording as the app, with the numbers for the mechanic.
  const readings = tripProblems(flags as unknown as SessionFlag[], []).map((p) => {
    const evidence = flags.find((f) => f.canonical_key === p.canonical_key)?.evidence ?? {};
    const numbers = (['max', 'avg', 'min'] as const)
      .filter((k) => typeof evidence[k] === 'number')
      .map((k) => `${k} ${(evidence[k] as number).toFixed(1)}`);
    return { ...p, text: describeProblem(p, t), numbers };
  });

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 print:p-0">
        {/* Header */}
        <header className="mb-6 print:mb-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <BrandLogo className="h-10 w-10" alt={t('sharedReport.logoAlt', 'Logo')} />
              <div>
                <h1 className="text-xl font-bold text-foreground">{carHeadline as string}</h1>
                <p className="text-xs text-muted-foreground font-mono">
                  {t('sharedReport.subtitle', 'Diagnostic report — {{date}}', {
                    date: sessionDate
                      ? new Date(sessionDate as string).toLocaleString(i18n.resolvedLanguage || undefined)
                      : t('sharedReport.unknownDate', 'date unknown'),
                  })}
                </p>
              </div>
            </div>
            <Button
              onClick={() => window.print()}
              variant="outline"
              size="sm"
              className="print:hidden"
            >
              <Printer className="w-3.5 h-3.5 mr-2" />
              {t('sharedReport.print', 'Print / Save as PDF')}
            </Button>
          </div>
        </header>

        {/* Vehicle facts */}
        <Card className="mb-4 border-border print:border-black print:break-inside-avoid">
          <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground font-mono uppercase">{t('sharedReport.vin', 'VIN (chassis number)')}</div>
              <div className="text-foreground font-mono mt-0.5">{(car?.vin as string) || '—'}</div>
            </div>
            <div>
              <div className="text-muted-foreground font-mono uppercase">{t('sharedReport.trim', 'Version')}</div>
              <div className="text-foreground font-mono mt-0.5">{(car?.trim as string) || '—'}</div>
            </div>
            <div>
              <div className="text-muted-foreground font-mono uppercase">{t('sharedReport.trip', 'Trip')}</div>
              <div className="text-foreground font-mono mt-0.5 truncate" title={tripName}>{tripName}</div>
            </div>
            <div>
              <div className="text-muted-foreground font-mono uppercase">{t('sharedReport.duration', 'Duration')}</div>
              <div className="text-foreground font-mono mt-0.5">{formatDuration(session?.duration_seconds as number | undefined) ?? '—'}</div>
            </div>
          </CardContent>
        </Card>

        {/* DTCs section */}
        <section className="mb-4 print:break-inside-avoid">
          <h2 className="text-sm font-semibold text-foreground mb-2">{t('sharedReport.faultCodes', 'Fault codes found')}</h2>
          <DTCPanel codes={dtcs} />
        </section>

        {/* Flags section */}
        <section className="mb-4 print:break-inside-avoid">
          <h2 className="text-sm font-semibold text-foreground mb-2">{t('sharedReport.unusualReadings', 'Unusual readings')}</h2>
          {readings.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('sharedReport.noReadings', 'Nothing unusual in this trip.')}</p>
          ) : (
            <div className="space-y-2">
              {readings.map((r) => (
                <Card key={r.canonical_key} className="border-border print:border-black">
                  <CardContent className="p-3">
                    <p className="text-sm font-medium flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${r.severity === 'critical' ? 'bg-destructive' : 'bg-warn'}`} />
                      {r.text.title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{r.text.meaning}</p>
                    <p className="text-[11px] text-muted-foreground font-mono mt-1">
                      {[r.text.code, ...r.numbers].join(' · ')}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        <footer className="mt-8 pt-4 border-t border-border flex items-center justify-center gap-2 text-[10px] text-muted-foreground font-mono">
          <BrandLogo className="h-3.5 w-3.5 opacity-70" alt="" />
          <span>{t('sharedReport.footer', 'Made with Xpeed · View-only diagnostic report')}</span>
        </footer>
      </div>

      <style>{`
        @media print {
          body { background: white !important; color: black !important; }
          .print\\:hidden { display: none !important; }
          .print\\:break-inside-avoid { break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
