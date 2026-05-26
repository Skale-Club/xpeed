import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import SessionKPIs from '@/components/SessionKPIs';
import FlagsPanel from '@/components/FlagsPanel';
import SessionCharts from '@/components/SessionCharts';
import { getSessions, getSessionFlags, getSessionRows, deleteSession, updateSession, downloadSessionCSV } from '@/lib/db';
import { DEFAULT_PRIUS_RULES } from '@/lib/default-rules';
import { useCarsContext } from '@/contexts/CarsContext';
import { useSettings } from '@/contexts/SettingsContext';
import { PageLoader } from '@/components/PageLoader';
import { AlertTriangle, AlertCircle, CheckCircle, ChevronRight, ChevronLeft, History as HistoryIcon, Car, ArrowRight, Trash2, Pencil, Check, X, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Session, SessionFlag, SessionRow, SessionSummary } from '@/types/session';

// Lightweight rule shape consumed by the SessionCharts component. The full
// schema lives in lib/default-rules.ts; we only need a structural alias here
// to avoid leaking `any` into component props.
type ChartRule = Record<string, unknown>;

export default function HistoryPage() {
  const navigate = useNavigate();
  const { selectedCarId, selectedCar } = useCarsContext();
  const { timezone } = useSettings();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [flagCounts, setFlagCounts] = useState<Record<string, { attention: number; critical: number }>>({});
  const [loading, setLoading] = useState(true);
  const [deleteSessionId, setDeleteSessionId] = useState<string | null>(null);

  // Session navigation state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [displayedSession, setDisplayedSession] = useState<Session | null>(null);
  const [flags, setFlags] = useState<SessionFlag[]>([]);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [rules, setRules] = useState<ChartRule[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);

  // Editing state
  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [downloadingCsv, setDownloadingCsv] = useState(false);

  // Reset editing when session changes
  useEffect(() => {
    setIsEditingName(false);
    setNewName('');
  }, [selectedIndex, displayedSession?.id]);

  const handleSaveName = async () => {
    if (!displayedSession || !newName.trim()) return;
    try {
      await updateSession(displayedSession.id, { source_filename: newName.trim() });
      
      // Update local state
      const updatedSession = { ...displayedSession, source_filename: newName.trim() };
      setDisplayedSession(updatedSession);
      setSessions(prev => prev.map(s => s.id === displayedSession.id ? updatedSession : s));
      
      toast.success('Session renamed successfully');
      setIsEditingName(false);
    } catch (error) {
      console.error('Failed to rename session:', error);
      toast.error('Failed to rename session');
    }
  };

  const handleDownloadSessionCsv = async (session: Session & { source_csv?: string | null }) => {
    setDownloadingCsv(true);
    try {
      await downloadSessionCSV(session.source_file_path, session.source_filename, session.source_csv, session.id);
    } catch (error) {
      console.error('Failed to download CSV:', error);
      toast.error('Failed to download CSV');
    } finally {
      setDownloadingCsv(false);
    }
  };

  // Load session list
  useEffect(() => {
    (async () => {
      setLoading(true);
      if (!selectedCarId) {
        setLoading(false);
        return;
      }

      const s = (await getSessions(selectedCarId)) as unknown as Session[];
      setSessions(s);
      setSelectedIndex(0);

      // Load flag counts for history list
      const counts: Record<string, { attention: number; critical: number }> = {};
      await Promise.all(
        s.slice(0, 50).map(async (session) => {
          const flagsForSession = await getSessionFlags(session.id);
          counts[session.id] = {
            attention: flagsForSession.filter((f) => f.severity === 'attention').length,
            critical: flagsForSession.filter((f) => f.severity === 'critical').length,
          };
        })
      );
      setFlagCounts(counts);
      setLoading(false);
    })();
  }, [selectedCarId]);

  // Load details for selected session
  useEffect(() => {
    (async () => {
      if (sessions.length === 0 || selectedIndex < 0 || selectedIndex >= sessions.length) {
        setDisplayedSession(null);
        return;
      }

      setDetailsLoading(true);
      const session = sessions[selectedIndex];
      setDisplayedSession(session);
      
      try {
        const [f, r] = await Promise.all([
          getSessionFlags(session.id),
          getSessionRows(session.id),
        ]);
        setFlags(f as unknown as SessionFlag[]);
        setRows(r as unknown as SessionRow[]);
        setRules(DEFAULT_PRIUS_RULES as unknown as ChartRule[]);
      } catch (error) {
        console.error("Error loading session details:", error);
      } finally {
        setDetailsLoading(false);
      }
    })();
  }, [selectedIndex, sessions, selectedCarId]);

  const formatDuration = (s: number | null) => {
    if (!s) return '-';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const summary = displayedSession?.summary as (SessionSummary & { headerMapping?: Record<string, string> }) | null | undefined;
  const headerMapping = summary?.headerMapping || {};
  const summaries = summary?.summaries || [];

  const handleDeleteSession = async () => {
    if (!deleteSessionId) return;
    
    try {
      await deleteSession(deleteSessionId);
      setSessions(prev => prev.filter(s => s.id !== deleteSessionId));
      if (displayedSession?.id === deleteSessionId) {
        setDisplayedSession(null);
        setSelectedIndex(0);
      }
      toast.success('Session deleted successfully');
    } catch (error) {
      console.error('Failed to delete session:', error);
      toast.error('Failed to delete session');
    } finally {
      setDeleteSessionId(null);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-8">
        {/* Session Details Panel — 2-column layout:
            left (2/3): header + filename + KPIs + Key Parameters
            right (1/3): stacked action buttons (top) + Insights panel */}
        {displayedSession && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left column */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <HistoryIcon className="w-5 h-5 text-primary" />
                  <h2 className="text-lg font-mono font-bold text-foreground">Session Details</h2>
                </div>

                {sessions.length > 1 && (
                  <div className="flex items-center gap-1 bg-muted/30 rounded-md p-0.5 border border-border/50">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={selectedIndex >= sessions.length - 1}
                      onClick={() => setSelectedIndex(i => i + 1)}
                      title="Older Session"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>
                    <span className="text-xs font-mono text-muted-foreground px-2 min-w-[3rem] text-center select-none">
                      {selectedIndex + 1} / {sessions.length}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      disabled={selectedIndex <= 0}
                      onClick={() => setSelectedIndex(i => i - 1)}
                      title="Newer Session"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>

              <div>
                {isEditingName ? (
                  <div className="flex items-center gap-1 mb-1">
                    <Input
                      className="h-7 w-[250px] text-xs font-mono"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Session Name"
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleSaveName}>
                      <Check className="h-3.5 w-3.5 text-success" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setIsEditingName(false)}>
                      <X className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group/name mb-1">
                    <h3 className="text-sm font-bold font-mono text-foreground">{displayedSession.source_filename}</h3>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 opacity-0 group-hover/name:opacity-100 transition-opacity"
                      onClick={() => {
                        setNewName(displayedSession.source_filename);
                        setIsEditingName(true);
                      }}
                    >
                      <Pencil className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                )}
                <div className="text-xs text-muted-foreground font-mono">
                  {new Date(displayedSession.session_start || displayedSession.uploaded_at).toLocaleString(undefined, { timeZone: timezone })}
                </div>
              </div>

              {detailsLoading ? (
                <div className="h-[400px] flex items-center justify-center border border-dashed border-border rounded-lg">
                  <PageLoader fullScreen={false} />
                </div>
              ) : (
                <>
                  <SessionKPIs
                    duration={displayedSession.duration_seconds}
                    rowCount={displayedSession.row_count}
                    parameterCount={summaries.length}
                    attentionCount={flags.filter((f) => f.severity === 'attention').length}
                    criticalCount={flags.filter((f) => f.severity === 'critical').length}
                  />

                  <div>
                    <h3 className="text-sm font-mono font-semibold text-foreground mb-3">Key Parameters</h3>
                    <SessionCharts rows={rows} headerMapping={headerMapping} rules={rules} />
                  </div>
                </>
              )}
            </div>

            {/* Right column — stacked action buttons + Insights */}
            <div className="space-y-4">
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs justify-start"
                  onClick={() => handleDownloadSessionCsv(displayedSession)}
                  disabled={downloadingCsv}
                >
                  {downloadingCsv ? (
                    <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                  ) : (
                    <Download className="w-3 h-3 mr-2" />
                  )}
                  Download CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate(`/session/${displayedSession.id}`)}
                  className="text-xs text-primary hover:text-primary justify-start"
                >
                  Full Analysis <ArrowRight className="w-3 h-3 ml-2" />
                </Button>
              </div>

              {!detailsLoading && (
                <div>
                  <h3 className="text-sm font-mono font-semibold text-foreground mb-3">Insights</h3>
                  <FlagsPanel flags={flags} limit={5} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* History List */}
        <div className="space-y-4 pt-4 border-t border-border/50">
          <div className="flex items-center gap-2">
            <HistoryIcon className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-mono font-bold text-foreground">Session History</h2>
          </div>
          
          {loading && <PageLoader fullScreen={false} className="h-64" />}

          {!loading && !selectedCarId && (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <Car className="w-12 h-12 text-primary/30 mx-auto mb-4" />
              <h3 className="text-sm font-mono font-semibold text-foreground mb-2">No Vehicle Selected</h3>
              <p className="text-xs text-muted-foreground mb-4">
                Please select a vehicle to view its session history.
              </p>
              <Button size="sm" onClick={() => navigate('/cars')}>
                Manage Vehicles
              </Button>
            </CardContent>
          </Card>
        )}

        {selectedCarId && !loading && sessions.length === 0 && (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground text-sm">No sessions for {selectedCar?.name} yet.</p>
            </CardContent>
          </Card>
        )}

        <div className="space-y-2">
          {sessions.map(session => {
            const counts = flagCounts[session.id] || { attention: 0, critical: 0 };
            const hasIssues = counts.attention > 0 || counts.critical > 0;

            return (
              <Card
                key={session.id}
                className="bg-card border-border hover:border-primary/30 transition-colors cursor-pointer group"
                onClick={() => navigate(`/session/${session.id}`)}
              >
                <CardContent className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${
                      counts.critical > 0 ? 'bg-destructive' :
                      counts.attention > 0 ? 'bg-warn' : 'bg-success'
                    }`} />
                    <div>
                      <p className="text-sm font-medium text-foreground">{session.source_filename}</p>
                      <p className="text-xs text-muted-foreground font-mono">
                        {new Date(session.session_start || session.uploaded_at).toLocaleDateString(undefined, { timeZone: timezone })} · {session.row_count} rows · {formatDuration(session.duration_seconds)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {counts.critical > 0 && (
                      <span className="flex items-center gap-1 text-xs text-destructive">
                        <AlertCircle className="w-3 h-3" /> {counts.critical}
                      </span>
                    )}
                    {counts.attention > 0 && (
                      <span className="flex items-center gap-1 text-xs text-warn">
                        <AlertTriangle className="w-3 h-3" /> {counts.attention}
                      </span>
                    )}
                    {!hasIssues && <CheckCircle className="w-4 h-4 text-success" />}
                    
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteSessionId(session.id);
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>

                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
      
      <AlertDialog open={!!deleteSessionId} onOpenChange={(open) => !open && setDeleteSessionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the session and all associated data.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteSession} className="bg-destructive hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}
