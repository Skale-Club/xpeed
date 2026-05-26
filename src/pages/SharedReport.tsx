import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { getSharedReport } from '@/lib/db-extras';
import { Car, AlertCircle, Printer, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import DTCPanel from '@/components/DTCPanel';
import FlagsPanel from '@/components/FlagsPanel';
import { useBrand, isDefaultBrand } from '@/hooks/use-brand';

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
  const { id } = useParams<{ id: string }>();
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const brand = useBrand();
  const useCustomLogo = !isDefaultBrand(brand);

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
            <h2 className="text-base font-mono font-semibold text-foreground">Report unavailable</h2>
            <p className="text-sm text-muted-foreground mt-2">
              This link may have expired or been revoked. Ask the vehicle owner for a new link.
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
    (car.year && car.make && car.model) ? `${car.year} ${car.make} ${car.model}` : (car.name as string | undefined) || 'Vehicle'
  ) : 'Vehicle';

  const sessionDate = session?.session_start || session?.uploaded_at;
  const sessionFilename = (session?.source_filename as string) || 'Session';

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-4 sm:p-6 lg:p-8 print:p-0">
        {/* Header */}
        <header className="mb-6 print:mb-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                {useCustomLogo ? (
                  <img src={brand.logo_url} alt="Logo" className="w-7 h-7 object-contain" />
                ) : (
                  <Car className="w-5 h-5 text-primary" />
                )}
              </div>
              <div>
                <h1 className="text-xl font-mono font-bold text-foreground">{carHeadline as string}</h1>
                <p className="text-xs text-muted-foreground font-mono">
                  Diagnostic Report — {sessionDate ? new Date(sessionDate as string).toLocaleString() : 'unknown date'}
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
              Print / Save PDF
            </Button>
          </div>
        </header>

        {/* Vehicle facts */}
        <Card className="mb-4 border-border print:border-black print:break-inside-avoid">
          <CardContent className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground font-mono uppercase">VIN</div>
              <div className="text-foreground font-mono mt-0.5">{(car?.vin as string) || '—'}</div>
            </div>
            <div>
              <div className="text-muted-foreground font-mono uppercase">Trim</div>
              <div className="text-foreground font-mono mt-0.5">{(car?.trim as string) || '—'}</div>
            </div>
            <div>
              <div className="text-muted-foreground font-mono uppercase">Session</div>
              <div className="text-foreground font-mono mt-0.5 truncate" title={sessionFilename}>{sessionFilename}</div>
            </div>
            <div>
              <div className="text-muted-foreground font-mono uppercase">Duration</div>
              <div className="text-foreground font-mono mt-0.5">{session?.duration_seconds ? `${Math.round((session.duration_seconds as number) / 60)} min` : '—'}</div>
            </div>
          </CardContent>
        </Card>

        {/* DTCs section */}
        <section className="mb-4 print:break-inside-avoid">
          <h2 className="text-sm font-mono font-semibold text-foreground mb-2">Active Trouble Codes</h2>
          <DTCPanel codes={dtcs} />
        </section>

        {/* Flags section */}
        <section className="mb-4 print:break-inside-avoid">
          <h2 className="text-sm font-mono font-semibold text-foreground mb-2">Detected Anomalies</h2>
          <FlagsPanel flags={flags} />
        </section>

        <footer className="mt-8 pt-4 border-t border-border flex items-center justify-center gap-2 text-[10px] text-muted-foreground font-mono">
          {useCustomLogo && (
            <img src={brand.logo_url} alt="" className="w-3.5 h-3.5 object-contain opacity-70" />
          )}
          <span>Generated by Xpeed · Read-only diagnostic report</span>
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
