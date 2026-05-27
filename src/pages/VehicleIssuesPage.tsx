import { useEffect, useState, useCallback, useMemo } from 'react';
import AppLayout from '@/components/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCarsContext } from '@/contexts/CarsContext';
import { useToast } from '@/hooks/use-toast';
import {
  listVehicleIssues, createVehicleIssue, updateVehicleIssue, deleteVehicleIssue,
  type VehicleIssue, type IssueSeverity, type IssueStatus,
} from '@/lib/db-extras';
import StatCard from '@/components/StatCard';
import {
  AlertTriangle, AlertCircle, Activity, CheckCircle, Plus, Loader2,
  Trash2, MoreVertical, Info, Clock, ChevronDown,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

// ── helpers ──────────────────────────────────────────────────────────────────

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  critical:  'Critical',
  attention: 'Attention',
  info:      'Info',
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  open:       'Open',
  monitoring: 'Monitoring',
  resolved:   'Resolved',
  dismissed:  'Dismissed',
};

const SEVERITY_BADGE: Record<IssueSeverity, string> = {
  critical:  'bg-destructive/15 text-destructive border-destructive/30',
  attention: 'bg-warn/15 text-warn border-warn/30',
  info:      'bg-primary/10 text-primary border-primary/20',
};

const SEVERITY_BORDER: Record<IssueSeverity, string> = {
  critical:  'border-l-destructive',
  attention: 'border-l-warn',
  info:      'border-l-primary',
};

const STATUS_BADGE: Record<IssueStatus, string> = {
  open:       'bg-warn/10 text-warn border-warn/30',
  monitoring: 'bg-primary/10 text-primary border-primary/20',
  resolved:   'bg-success/10 text-success border-success/30',
  dismissed:  'bg-muted/50 text-muted-foreground border-border',
};

const NEXT_STATUSES: Record<IssueStatus, IssueStatus[]> = {
  open:       ['monitoring', 'resolved', 'dismissed'],
  monitoring: ['open', 'resolved', 'dismissed'],
  resolved:   ['open', 'monitoring'],
  dismissed:  ['open'],
};

type FilterTab = 'all' | IssueStatus;
const TABS: { value: FilterTab; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'open',      label: 'Open' },
  { value: 'monitoring',label: 'Monitoring' },
  { value: 'resolved',  label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

// ── component ─────────────────────────────────────────────────────────────────

export default function VehicleIssuesPage() {
  const { selectedCar, selectedCarId } = useCarsContext();
  const { toast } = useToast();

  const [issues, setIssues]     = useState<VehicleIssue[]>([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState<FilterTab>('all');

  // New issue form
  const [isAddOpen, setIsAddOpen]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [title, setTitle]           = useState('');
  const [severity, setSeverity]     = useState<IssueSeverity>('attention');
  const [dtcCode, setDtcCode]       = useState('');
  const [description, setDescription] = useState('');

  // Resolve dialog
  const [resolveIssue, setResolveIssue] = useState<VehicleIssue | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolving, setResolving] = useState(false);

  // ── data ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    if (!selectedCarId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await listVehicleIssues(selectedCarId);
      setIssues(data);
    } catch (err) {
      toast({ title: 'Error', description: 'Failed to load issues', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [selectedCarId, toast]);

  useEffect(() => { void load(); }, [load]);

  // ── stats ─────────────────────────────────────────────────────────────────

  const stats = useMemo(() => ({
    open:       issues.filter(i => i.status === 'open').length,
    critical:   issues.filter(i => i.severity === 'critical' && i.status !== 'dismissed').length,
    monitoring: issues.filter(i => i.status === 'monitoring').length,
    resolved:   issues.filter(i => i.status === 'resolved').length,
  }), [issues]);

  const filtered = useMemo(() =>
    tab === 'all' ? issues : issues.filter(i => i.status === tab),
  [issues, tab]);

  // ── actions ───────────────────────────────────────────────────────────────

  const handleAdd = async () => {
    if (!selectedCarId || !title.trim()) return;
    setSaving(true);
    try {
      const issue = await createVehicleIssue({
        car_profile_id: selectedCarId,
        title: title.trim(),
        severity,
        dtc_code: dtcCode.trim().toUpperCase() || null,
        description: description.trim() || null,
      });
      setIssues(prev => [issue, ...prev]);
      toast({ title: 'Issue reported' });
      setIsAddOpen(false);
      setTitle(''); setSeverity('attention'); setDtcCode(''); setDescription('');
    } catch (err) {
      toast({ title: 'Error', description: String(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (issue: VehicleIssue, status: IssueStatus) => {
    if (status === 'resolved') {
      setResolveIssue(issue);
      setResolutionNote('');
      return;
    }
    try {
      const updated = await updateVehicleIssue(issue.id, { status });
      setIssues(prev => prev.map(i => i.id === updated.id ? updated : i));
    } catch (err) {
      toast({ title: 'Error', description: String(err), variant: 'destructive' });
    }
  };

  const handleResolve = async () => {
    if (!resolveIssue) return;
    setResolving(true);
    try {
      const updated = await updateVehicleIssue(resolveIssue.id, {
        status: 'resolved',
        resolution_note: resolutionNote.trim() || null,
      });
      setIssues(prev => prev.map(i => i.id === updated.id ? updated : i));
      toast({ title: 'Issue marked as resolved' });
      setResolveIssue(null);
    } catch (err) {
      toast({ title: 'Error', description: String(err), variant: 'destructive' });
    } finally {
      setResolving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteVehicleIssue(id);
      setIssues(prev => prev.filter(i => i.id !== id));
    } catch (err) {
      toast({ title: 'Error', description: String(err), variant: 'destructive' });
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <AppLayout>
      <div className="space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-mono font-bold text-foreground">
              Issues
              {selectedCar && (
                <span className="text-muted-foreground font-normal"> — {selectedCar.name}</span>
              )}
            </h2>
          </div>
          <Button size="sm" disabled={!selectedCarId} onClick={() => setIsAddOpen(true)}>
            <Plus className="w-3.5 h-3.5 mr-2" />
            Report Issue
          </Button>
        </div>

        {!selectedCarId ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Select a vehicle to view its issues.
            </CardContent>
          </Card>
        ) : loading ? (
          <Card className="bg-card border-border">
            <CardContent className="p-6 text-center">
              <Loader2 className="w-5 h-5 text-primary animate-spin mx-auto" />
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard
                label="Open"
                value={stats.open}
                icon={AlertTriangle}
                tone={stats.open > 0 ? 'warn' : 'default'}
                onClick={() => setTab('open')}
              />
              <StatCard
                label="Critical"
                value={stats.critical}
                icon={AlertCircle}
                tone={stats.critical > 0 ? 'critical' : 'default'}
                onClick={() => setTab('all')}
              />
              <StatCard
                label="Monitoring"
                value={stats.monitoring}
                icon={Activity}
                tone="default"
                onClick={() => setTab('monitoring')}
              />
              <StatCard
                label="Resolved"
                value={stats.resolved}
                icon={CheckCircle}
                tone={stats.resolved > 0 ? 'success' : 'default'}
                onClick={() => setTab('resolved')}
              />
            </div>

            {/* Filter tabs */}
            <div className="flex gap-1 flex-wrap">
              {TABS.map(t => {
                const count = t.value === 'all'
                  ? issues.length
                  : issues.filter(i => i.status === t.value).length;
                return (
                  <button
                    key={t.value}
                    onClick={() => setTab(t.value)}
                    className={`px-3 py-1 rounded-md text-xs font-mono transition-colors ${
                      tab === t.value
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    {t.label}
                    {count > 0 && (
                      <span className={`ml-1.5 text-[10px] ${tab === t.value ? 'opacity-70' : 'opacity-60'}`}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* List */}
            {filtered.length === 0 ? (
              <Card className="bg-card border-border">
                <CardContent className="py-12 text-center">
                  <AlertTriangle className="w-12 h-12 text-primary/30 mx-auto mb-4" />
                  <h3 className="text-sm font-mono font-semibold text-foreground mb-2">
                    {tab === 'all' ? 'No issues recorded' : `No ${tab} issues`}
                  </h3>
                  <p className="text-xs text-muted-foreground mb-4">
                    {tab === 'all'
                      ? 'Issues detected during analysis will appear here. You can also report one manually.'
                      : `Switch to "All" to see issues in other states.`}
                  </p>
                  {tab === 'all' && (
                    <Button size="sm" onClick={() => setIsAddOpen(true)}>
                      <Plus className="w-3.5 h-3.5 mr-2" />
                      Report First Issue
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {filtered.map(issue => (
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    onStatusChange={handleStatusChange}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* New Issue Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report an issue</DialogTitle>
            <DialogDescription>
              Manually log a problem for tracking. The AI assistant will also surface issues automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-4">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="i-title">Title *</Label>
              <Input
                id="i-title"
                placeholder="e.g. Coolant temp spikes above normal"
                value={title}
                onChange={e => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="i-severity">Severity *</Label>
              <Select value={severity} onValueChange={v => setSeverity(v as IssueSeverity)}>
                <SelectTrigger id="i-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="attention">Attention</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="i-dtc">DTC code</Label>
              <Input
                id="i-dtc"
                placeholder="e.g. P0420"
                value={dtcCode}
                onChange={e => setDtcCode(e.target.value)}
                className="font-mono uppercase"
                maxLength={6}
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="i-desc">Description</Label>
              <Textarea
                id="i-desc"
                placeholder="Optional details about when this happens or what you've noticed..."
                value={description}
                onChange={e => setDescription(e.target.value)}
                rows={3}
                className="resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={saving || !title.trim()}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resolve Dialog */}
      <Dialog open={!!resolveIssue} onOpenChange={open => !open && setResolveIssue(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as resolved</DialogTitle>
            <DialogDescription>
              Optionally add a note about what fixed it — useful for future reference.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-1.5">
            <Label htmlFor="r-note">Resolution note</Label>
            <Textarea
              id="r-note"
              placeholder="e.g. Replaced thermostat, issue has not recurred."
              value={resolutionNote}
              onChange={e => setResolutionNote(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveIssue(null)}>Cancel</Button>
            <Button onClick={handleResolve} disabled={resolving}>
              {resolving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Mark Resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

// ── IssueCard ─────────────────────────────────────────────────────────────────

interface IssueCardProps {
  issue: VehicleIssue;
  onStatusChange: (issue: VehicleIssue, status: IssueStatus) => void;
  onDelete: (id: string) => void;
}

function IssueCard({ issue, onStatusChange, onDelete }: IssueCardProps) {
  const nextStatuses = NEXT_STATUSES[issue.status];

  return (
    <Card className={`bg-card border-border border-l-4 ${SEVERITY_BORDER[issue.severity]}`}>
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start gap-3">

          {/* Severity icon */}
          <div className="flex-shrink-0 mt-0.5">
            {issue.severity === 'critical'
              ? <AlertCircle className="w-4 h-4 text-destructive" />
              : issue.severity === 'attention'
              ? <AlertTriangle className="w-4 h-4 text-warn" />
              : <Info className="w-4 h-4 text-primary" />}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-mono font-semibold text-foreground">{issue.title}</span>

              {issue.dtc_code && (
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border bg-muted/50 text-muted-foreground">
                  {issue.dtc_code}
                </span>
              )}

              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${SEVERITY_BADGE[issue.severity]}`}>
                {SEVERITY_LABEL[issue.severity]}
              </span>

              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${STATUS_BADGE[issue.status]}`}>
                {STATUS_LABEL[issue.status]}
              </span>
            </div>

            {issue.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{issue.description}</p>
            )}

            {issue.resolution_note && issue.status === 'resolved' && (
              <p className="text-xs text-success/80 mt-1 italic">"{issue.resolution_note}"</p>
            )}

            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                <Clock className="w-3 h-3" />
                First seen {formatDistanceToNow(new Date(issue.first_seen_at), { addSuffix: true })}
              </span>
              {issue.first_seen_at !== issue.last_seen_at && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  · Last seen {formatDistanceToNow(new Date(issue.last_seen_at), { addSuffix: true })}
                </span>
              )}
              {issue.resolved_at && (
                <span className="text-[10px] text-success/70 font-mono">
                  · Resolved {formatDistanceToNow(new Date(issue.resolved_at), { addSuffix: true })}
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {nextStatuses.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 px-2">
                    {STATUS_LABEL[issue.status]}
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {nextStatuses.map(s => (
                    <DropdownMenuItem key={s} onClick={() => onStatusChange(issue, s)}>
                      {STATUS_LABEL[s]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                  <MoreVertical className="w-3.5 h-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDelete(issue.id)}
                >
                  <Trash2 className="w-3.5 h-3.5 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
