import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle2, RotateCcw, EyeOff, ExternalLink, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import {
  getIssuesForCar, resolveIssue, ignoreIssue, reopenIssue,
  type VehicleIssue, type IssueStatus, type IssueSeverity,
} from '@/lib/db-issues';

const SEVERITY_ORDER: IssueSeverity[] = ['critical', 'serious', 'warning', 'easy_fix'];

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical: 'Critical',
  serious: 'Serious',
  warning: 'Warning',
  easy_fix: 'Easy Fix',
};

const SEVERITY_CLASS: Record<IssueSeverity, string> = {
  critical: 'bg-red-500/15 text-red-500 border-red-500/30',
  serious: 'bg-orange-500/15 text-orange-500 border-orange-500/30',
  warning: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
  easy_fix: 'bg-blue-500/15 text-blue-500 border-blue-500/30',
};

const STATUS_TABS: { key: IssueStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'recurred', label: 'Recurred' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'ignored', label: 'Ignored' },
];

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function IssuesPage() {
  const { selectedCar } = useCarsContext();
  const { toast } = useToast();

  const [issues, setIssues] = useState<VehicleIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<IssueStatus | 'all'>('active');
  const [actingOn, setActingOn] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedCar) return;
    setLoading(true);
    try {
      const data = await getIssuesForCar(selectedCar.id);
      setIssues(data);
    } catch (err) {
      toast({ title: 'Could not load issues', description: String(err), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [selectedCar, toast]);

  useEffect(() => { load(); }, [load]);

  const handleResolve = async (issue: VehicleIssue) => {
    setActingOn(issue.id);
    try {
      await resolveIssue(issue.id);
      setIssues((prev) =>
        prev.map((i) =>
          i.id === issue.id
            ? { ...i, status: 'resolved', resolved_at: new Date().toISOString() }
            : i
        )
      );
      toast({ title: 'Issue resolved' });
    } catch (err) {
      toast({ title: 'Failed to resolve issue', description: String(err), variant: 'destructive' });
    } finally {
      setActingOn(null);
    }
  };

  const handleIgnore = async (issue: VehicleIssue) => {
    setActingOn(issue.id);
    try {
      await ignoreIssue(issue.id);
      setIssues((prev) =>
        prev.map((i) => (i.id === issue.id ? { ...i, status: 'ignored' } : i))
      );
      toast({ title: 'Issue ignored' });
    } catch (err) {
      toast({ title: 'Failed to ignore issue', description: String(err), variant: 'destructive' });
    } finally {
      setActingOn(null);
    }
  };

  const handleReopen = async (issue: VehicleIssue) => {
    setActingOn(issue.id);
    try {
      await reopenIssue(issue.id);
      setIssues((prev) =>
        prev.map((i) =>
          i.id === issue.id
            ? { ...i, status: 'active', resolved_at: null, resolved_note: null }
            : i
        )
      );
      toast({ title: 'Issue reopened' });
    } catch (err) {
      toast({ title: 'Failed to reopen issue', description: String(err), variant: 'destructive' });
    } finally {
      setActingOn(null);
    }
  };

  const visible = issues.filter((i) => tab === 'all' || i.status === tab);

  const counts = {
    all: issues.length,
    active: issues.filter((i) => i.status === 'active').length,
    recurred: issues.filter((i) => i.status === 'recurred').length,
    resolved: issues.filter((i) => i.status === 'resolved').length,
    ignored: issues.filter((i) => i.status === 'ignored').length,
  };

  const activeAndRecurred = counts.active + counts.recurred;

  // Group visible issues by severity
  const grouped = SEVERITY_ORDER.reduce<Record<IssueSeverity, VehicleIssue[]>>(
    (acc, sev) => {
      acc[sev] = visible.filter((i) => i.severity === sev);
      return acc;
    },
    { critical: [], serious: [], warning: [], easy_fix: [] }
  );

  if (!selectedCar) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground font-mono text-sm">
        Select a vehicle to view its issues.
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-mono font-bold">Issues</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {selectedCar.year} {selectedCar.make} {selectedCar.model}
            {activeAndRecurred > 0 && (
              <span className="ml-2 text-red-500 font-mono">
                {activeAndRecurred} active
              </span>
            )}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading} className="font-mono text-xs">
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-mono transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {counts[t.key] > 0 && (
              <span className="ml-1.5 px-1 py-0.5 rounded text-[10px] bg-muted">
                {counts[t.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="text-center py-10 text-muted-foreground font-mono text-sm animate-pulse">
          Loading issues…
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground font-mono text-sm">
          {tab === 'active' ? 'No active issues — looks healthy.' : `No ${tab} issues.`}
        </div>
      ) : (
        <div className="space-y-6">
          {SEVERITY_ORDER.map((sev) => {
            const group = grouped[sev];
            if (group.length === 0) return null;
            return (
              <div key={sev} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full border ${SEVERITY_CLASS[sev]}`}>
                    {SEVERITY_LABEL[sev]}
                  </span>
                  <span className="text-xs text-muted-foreground">{group.length}</span>
                </div>
                {group.map((issue) => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    acting={actingOn === issue.id}
                    onResolve={handleResolve}
                    onIgnore={handleIgnore}
                    onReopen={handleReopen}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface IssueCardProps {
  issue: VehicleIssue;
  acting: boolean;
  onResolve: (i: VehicleIssue) => void;
  onIgnore: (i: VehicleIssue) => void;
  onReopen: (i: VehicleIssue) => void;
}

function IssueCard({ issue, acting, onResolve, onIgnore, onReopen }: IssueCardProps) {
  const isActive = issue.status === 'active' || issue.status === 'recurred';
  const isResolved = issue.status === 'resolved';
  const isIgnored = issue.status === 'ignored';

  return (
    <Card className={`border-border transition-opacity ${isResolved || isIgnored ? 'opacity-60' : ''}`}>
      <CardContent className="pt-4 pb-4 px-4">
        <div className="flex items-start gap-3">
          {/* Status icon */}
          <div className="mt-0.5 shrink-0">
            {isResolved ? (
              <CheckCircle2 className="w-4 h-4 text-green-500" />
            ) : issue.status === 'recurred' ? (
              <RotateCcw className="w-4 h-4 text-orange-400" />
            ) : isIgnored ? (
              <EyeOff className="w-4 h-4 text-muted-foreground" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-500" />
            )}
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-mono font-medium leading-snug">{issue.title}</p>
              {issue.status === 'recurred' && (
                <Badge variant="outline" className="text-[10px] shrink-0 border-orange-400/50 text-orange-400">
                  Recurred {issue.recurrence_count}×
                </Badge>
              )}
            </div>

            {/* Timestamps */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground font-mono">
              <span>First: {fmtDate(issue.first_seen_at)}</span>
              <span>Last: {fmtDate(issue.last_seen_at)}</span>
              {isResolved && issue.resolved_at && (
                <span className="text-green-600">Resolved: {fmtDate(issue.resolved_at)}</span>
              )}
            </div>

            {/* Session link */}
            {issue.last_session_id && (
              <Link
                to={`/session/${issue.last_session_id}`}
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-mono"
              >
                View last session <ExternalLink className="w-3 h-3" />
              </Link>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              {isActive && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={acting}
                    onClick={() => onResolve(issue)}
                    className="h-7 text-xs font-mono"
                  >
                    <CheckCircle2 className="w-3 h-3 mr-1" /> Mark Resolved
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={acting}
                    onClick={() => onIgnore(issue)}
                    className="h-7 text-xs font-mono text-muted-foreground"
                  >
                    Ignore
                  </Button>
                </>
              )}
              {(isResolved || isIgnored) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={acting}
                  onClick={() => onReopen(issue)}
                  className="h-7 text-xs font-mono text-muted-foreground"
                >
                  <RotateCcw className="w-3 h-3 mr-1" /> Reopen
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
