import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatAppDate } from '@/lib/app-date';
import { formatLapTime } from '@/lib/sim/analysis';
import { DEMO_USER_ID, isDemoMode, useDemoMode } from '@/lib/sim/demo/mode';
import { sessionPath } from '@/lib/sim/routes';
import {
  attachSetupVersion, createSetupVersion, deleteSetupVersion, listSetupVersions, SetupRequestError, type SetupFailure,
} from '@/lib/sim/setup-client';
import {
  compareSetupParameters, formatSetupValue, MAX_SETUP_PARAMETERS, normalizeSetupDraft,
  type SetupLibrary, type SetupParameter, type SetupVersion, type SetupVersionDraft,
} from '@/lib/sim/setup-types';
import type { TrainingMeasurement } from '@/lib/sim/training-types';
import { useConditions } from './use-session-text';

interface SessionSetupsProps {
  userId: string;
  sessionId: string;
}

interface ParameterRow extends SetupParameter { rowId: number }
type SetupEditorDraft = Omit<SetupVersionDraft, 'parameters'> & { parameters: ParameterRow[] };
type SetupMutation =
  | { action: 'create'; draft: SetupVersionDraft }
  | { action: 'attach'; versionId: string | null }
  | { action: 'delete'; versionId: string };
type SetupNotice = 'created' | 'attached' | 'detached' | 'deleted';

const key = (label: string) => `modes.setups.${label}`;
const emptyParameter: SetupParameter = { name: '', value: '', unit: '' };
const selectStyle = 'h-11 w-full rounded-xl border border-input bg-background/60 px-3.5 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm';

export default function SessionSetups(props: SessionSetupsProps) {
  const demo = useDemoMode();
  if (demo || !props.userId || props.userId === DEMO_USER_ID) return null;
  return <SetupPanel key={`${props.userId}:${props.sessionId}`} {...props} />;
}

function displayDate(iso: string, language?: string) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? formatAppDate(date, language, { dateStyle: 'medium', timeStyle: 'short' }) : null;
}

function SetupPanel({ userId, sessionId }: SessionSetupsProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const fieldId = useId();
  const [library, setLibrary] = useState<SetupLibrary | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [viewId, setViewId] = useState('');
  const [useDraftId, setUseDraftId] = useState<string | null>(null);
  const [editor, setEditor] = useState<SetupEditorDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SetupVersion | null>(null);
  const [notice, setNotice] = useState<SetupNotice | null>(null);
  const [error, setError] = useState<SetupFailure | 'refresh' | null>(null);
  const nextRowId = useRef(1);
  const pending = useRef<AbortController | null>(null);

  useLayoutEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const run = useCallback(async (mutation?: SetupMutation) => {
    if (pending.current || isDemoMode()) return;
    const controller = new AbortController();
    const { signal } = controller;
    const current = () => !signal.aborted && !isDemoMode();
    pending.current = controller;
    let result: SetupNotice | null = null;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      if (mutation?.action === 'create') {
        const id = await createSetupVersion(userId, sessionId, mutation.draft, signal);
        if (!current()) return;
        setEditor(null);
        setViewId(id);
        result = 'created';
      } else if (mutation?.action === 'attach') {
        await attachSetupVersion(userId, sessionId, mutation.versionId, signal);
        if (!current()) return;
        setUseDraftId(null);
        result = mutation.versionId === null ? 'detached' : 'attached';
      } else if (mutation?.action === 'delete') {
        await deleteSetupVersion(userId, mutation.versionId, signal);
        if (!current()) return;
        result = 'deleted';
      }
      if (result) setStale(true);
      const next = await listSetupVersions(userId, sessionId, signal);
      if (!current()) return;
      setLibrary(next);
      setViewId((id) => next.versions.some((version) => version.id === id) ? id : '');
      setUseDraftId((id) => id && !next.versions.some((version) => version.id === id) ? null : id);
      setStale(false);
      setNotice(result);
    } catch (cause) {
      if (!current()) return;
      setError(result ? 'refresh' : cause instanceof SetupRequestError ? cause.kind : 'unavailable');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        if (current()) setLoading(false);
      }
    }
  }, [userId, sessionId]);

  useEffect(() => { void run(); }, [run]);

  const selectedVersion = library?.versions.find((version) => version.id === viewId);
  const parentId = selectedVersion?.parentId;
  const parent = parentId ? library?.versions.find((version) => version.id === parentId) : undefined;
  const attachedId = library?.selectedVersionId ?? '';
  const attached = library?.versions.find((version) => version.id === attachedId);
  const usageChoice = useDraftId ?? attachedId;
  const atLimit = Boolean(library && library.versions.length >= library.limit);
  const disabled = loading || stale;
  const options = library?.versions.map((version) => {
    const date = displayDate(version.createdAt, i18n.resolvedLanguage);
    return <option key={version.id} value={version.id}>{date ? `${version.label} · ${date}` : version.label}</option>;
  });
  const openEditor = (source?: SetupVersion) => {
    const parameters = (source?.parameters ?? [emptyParameter]).map((row) => ({ ...row, rowId: nextRowId.current++ }));
    setEditor({ label: '', notes: source?.notes ?? '', parentId: source?.id ?? null, parameters });
    setError(null);
    setNotice(null);
  };
  const saveUsage = () => {
    if (disabled || usageChoice === attachedId) return;
    void run({ action: 'attach', versionId: usageChoice || null });
  };

  return (
    <section aria-labelledby={headingId} className="space-y-4 border-t border-border p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 id={headingId} className="text-base font-semibold">{t(key('title'))}</h3>
          <p className="text-sm text-muted-foreground">{t(key('intro'))}</p>
        </div>
        {library && <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void run()}>{t(key('refresh'))}</Button>
          {!editor && <Button size="sm" variant="outline" disabled={disabled || atLimit} onClick={() => openEditor()}>{t(key('newRoot'))}</Button>}
        </div>}
      </div>

      {loading && <p role="status" className="text-sm text-muted-foreground">{t('common.loading', 'Loading…')}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{t(key(`error.${error}`))}</p>}
      {error && !library && <Button size="sm" variant="outline" disabled={loading} onClick={() => void run()}>{t(key('refresh'))}</Button>}
      {notice && <p role="status" className="text-sm">{t(key(notice))}</p>}
      {atLimit && library && <p className="text-sm text-muted-foreground">{t(key('limit'), { limit: library.limit })}</p>}

      {library && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold">{t(key('usedInSession'))}</h4>
            <p className="break-words text-sm">{attached ? t(key('recordedVersion'), { label: attached.label }) : t(key('noneRecorded'))}</p>
            <p className="text-xs text-muted-foreground" id={`${fieldId}-use-help`}>{t(key('associationHint'))}</p>
          </div>
          {!!library.versions.length && (
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); saveUsage(); }}>
              <div className="min-w-0 flex-1 basis-48 space-y-1.5">
                <Label htmlFor={`${fieldId}-used`}>{t(key('sessionVersion'))}</Label>
                <select className={selectStyle} id={`${fieldId}-used`} value={usageChoice} disabled={disabled}
                  aria-describedby={`${fieldId}-use-help`} onChange={(event) => setUseDraftId(event.target.value)}>
                  <option value="">{t(key('noSetup'))}</option>
                  {options}
                </select>
              </div>
              <Button type="submit" size="sm" disabled={disabled || usageChoice === attachedId}>{t(key('saveUse'))}</Button>
            </form>
          )}
        </div>
      )}

      {editor && (
        <SetupEditor draft={editor} previousLabel={library?.versions.find((version) => version.id === editor.parentId)?.label}
          disabled={disabled || atLimit} onChange={setEditor} newRow={() => ({ ...emptyParameter, rowId: nextRowId.current++ })}
          onSave={(draft) => void run({ action: 'create', draft })} onCancel={() => { setEditor(null); setError(null); }} />
      )}

      {library && !library.versions.length && <p className="text-sm text-muted-foreground">{t(key('empty'))}</p>}
      {!!library?.versions.length && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-view`}>{t(key('viewVersion'))}</Label>
            <select className={selectStyle} id={`${fieldId}-view`} value={viewId} onChange={(event) => setViewId(event.target.value)}>
              <option value="">{t(key('chooseVersion'))}</option>
              {options}
            </select>
          </div>
          {selectedVersion && (
            <div className="space-y-4 rounded-lg border border-border p-3">
              <VersionDetails version={selectedVersion} parent={parent} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={disabled || atLimit || Boolean(editor)} onClick={() => openEditor(selectedVersion)}>
                  {t(key('copyVersion'))}
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive" disabled={disabled || Boolean(editor)}
                  onClick={() => setDeleteTarget(selectedVersion)}>{t(key('deleteVersion'))}</Button>
              </div>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t(key('deleteTitle'))} description={t(key('deleteBody'), { label: deleteTarget?.label ?? '' })}
        confirmLabel={t(key('deleteVersion'))} onConfirm={() => {
          if (deleteTarget) void run({ action: 'delete', versionId: deleteTarget.id });
        }} />
    </section>
  );
}

function SetupEditor({ draft, previousLabel, disabled, newRow, onChange, onSave, onCancel }: {
  draft: SetupEditorDraft;
  previousLabel?: string;
  disabled: boolean;
  newRow: () => ParameterRow;
  onChange: (draft: SetupEditorDraft) => void;
  onSave: (draft: SetupVersionDraft) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const field = useId();
  const normalized = normalizeSetupDraft(draft);
  const hasCompleteDraft = draft.label.trim() && draft.parameters.every((row) => row.name.trim() && row.value.trim());
  const editParameter = (rowId: number, field: keyof SetupParameter, value: string) =>
    onChange({ ...draft, parameters: draft.parameters.map((row) => row.rowId === rowId ? { ...row, [field]: value } : row) });
  return (
    <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => {
      event.preventDefault();
      if (!disabled && normalized) onSave(normalized);
    }}>
      <h4 className="break-words text-sm font-semibold">
        {draft.parentId ? t(key('draftChild'), { label: previousLabel ?? t(key('parentUnavailable')) }) : t(key('draftRoot'))}
      </h4>
      <fieldset disabled={disabled} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-label`}>{t(key('versionName'))}</Label>
          <Input id={`${field}-label`} required maxLength={120} value={draft.label} onChange={(event) => onChange({ ...draft, label: event.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-notes`}>{t(key('notes'))}</Label>
          <Textarea id={`${field}-notes`} maxLength={1000} rows={2} value={draft.notes} onChange={(event) => onChange({ ...draft, notes: event.target.value })} />
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t(key('parameters'))}</legend>
          <p className="text-xs text-muted-foreground">{t(key('parameterHint'), { limit: MAX_SETUP_PARAMETERS })}</p>
          {draft.parameters.map((row, index) => {
            const id = `${field}-${row.rowId}`;
            return (
              <div key={row.rowId} className="grid grid-cols-2 items-end gap-2 border-b border-border pb-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,5rem)_auto]">
                <div className="col-span-2 min-w-0 space-y-1.5 sm:col-span-1">
                  <Label htmlFor={`${id}-name`}>{t(key('parameterName'))}</Label>
                  <Input id={`${id}-name`} required maxLength={60} value={row.name} onChange={(event) => editParameter(row.rowId, 'name', event.target.value)} />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`${id}-value`}>{t(key('parameterValue'))}</Label>
                  <Input id={`${id}-value`} required maxLength={80} value={row.value} onChange={(event) => editParameter(row.rowId, 'value', event.target.value)} />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`${id}-unit`}>{t(key('parameterUnit'))}</Label>
                  <Input id={`${id}-unit`} maxLength={20} value={row.unit} onChange={(event) => editParameter(row.rowId, 'unit', event.target.value)} />
                </div>
                <Button type="button" size="sm" variant="ghost" className="col-span-2 justify-self-start sm:col-span-1"
                  aria-label={t(key('removeParameterAt'), { index: index + 1 })} disabled={draft.parameters.length === 1}
                  onClick={() => onChange({ ...draft, parameters: draft.parameters.filter((entry) => entry.rowId !== row.rowId) })}>
                  {t(key('removeParameter'))}
                </Button>
              </div>
            );
          })}
          <Button type="button" size="sm" variant="outline" disabled={draft.parameters.length >= MAX_SETUP_PARAMETERS}
            onClick={() => onChange({ ...draft, parameters: [...draft.parameters, newRow()] })}>{t(key('addParameter'))}</Button>
        </fieldset>
        {hasCompleteDraft && !normalized && <p role="alert" className="text-sm text-destructive">{t(key('error.invalid_setup'))}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" type="submit" disabled={!normalized}>{t(key('saveVersion'))}</Button>
          <Button size="sm" type="button" variant="ghost" onClick={onCancel}>{t('common.cancel', 'Cancel')}</Button>
        </div>
      </fieldset>
    </form>
  );
}

function VersionDetails({ version, parent }: { version: SetupVersion; parent?: SetupVersion }) {
  const { t, i18n } = useTranslation();
  const timestamp = displayDate(version.createdAt, i18n.resolvedLanguage);
  const changes = parent ? compareSetupParameters(parent.parameters, version.parameters) : [];
  return (
    <>
      <div className="space-y-1">
        <h4 className="break-words text-sm font-semibold">{version.label}</h4>
        {timestamp && <time className="block text-xs text-muted-foreground" dateTime={version.createdAt}>{timestamp}</time>}
        <p className="break-words text-sm text-muted-foreground">
          {parent ? t(key('derivedFrom'), { label: parent.label }) : t(key(version.parentId ? 'parentUnavailable' : 'noParent'))}
        </p>
        {version.notes && <p className="whitespace-pre-wrap break-words text-sm">{version.notes}</p>}
      </div>

      <div className="space-y-2">
        <h5 className="text-sm font-semibold">{t(key('parameters'))}</h5>
        <dl className="divide-y divide-border rounded-md bg-muted/30 px-2.5 text-sm">
          {version.parameters.map((parameter) => (
            <div key={parameter.name} className="grid grid-cols-2 gap-2 py-1.5">
              <dt className="min-w-0 break-words">{parameter.name}</dt>
              <dd className="min-w-0 break-words font-mono">{formatSetupValue(parameter)}</dd>
            </div>
          ))}
        </dl>
      </div>

      {parent && <div className="space-y-2">
        <h5 className="text-sm font-semibold">{t(key('parentDiff'))}</h5>
        {changes.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {changes.map((change) => <li key={change.name} className="min-w-0 space-y-1 break-words rounded-md bg-muted/30 p-2.5 text-sm">
              <p className="font-medium">{change.name}</p>
              <p className="text-muted-foreground">{t(key('before'), { value: change.before ?? t(key('absent')) })}</p>
              <p>{t(key('after'), { value: change.after ?? t(key('absent')) })}</p>
            </li>)}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{t(key('noParameterChanges'))}</p>}
      </div>}

      <div className="space-y-2">
        <h5 className="text-sm font-semibold">{t(key('attachedRuns'))}</h5>
        <p className="text-xs text-muted-foreground">{t(key('runCaveat'))}</p>
        {version.runs.length ? (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {version.runs.map((run) => <SetupRun key={run.sessionId} run={run} />)}
          </ul>
        ) : <p className="text-sm text-muted-foreground">{t(key('noRuns'))}</p>}
      </div>
    </>
  );
}

function SetupRun({ run }: { run: TrainingMeasurement }) {
  const { t, i18n } = useTranslation();
  const conditions = useConditions()(run);
  const timestamp = displayDate(run.startedAt, i18n.resolvedLanguage);
  const kind = ['practice', 'qualifying', 'race'].includes(run.kind) ? t(`modes.sessions.kind.${run.kind}`) : t(key('unknownKind'));
  return (
    <li className="min-w-0 space-y-1 rounded-md bg-muted/30 p-2.5 text-sm">
      <Link className="font-medium text-primary underline-offset-2 hover:underline" to={sessionPath(run.sessionId)}>
        {timestamp ? t(key('runSessionAt'), { date: timestamp }) : t(key('runSession'))}
      </Link>
      <p className="text-xs text-muted-foreground">{kind}</p>
      <p className="font-mono tabular-nums">{run.value === null ? t(key('unmeasured')) : t(key('bestLap'), { time: formatLapTime(run.value) })}</p>
      <p className="text-xs text-muted-foreground">{t(key('coverage'), { usable: run.lapsUsed, total: run.totalLaps })}</p>
      <p className="break-words text-xs text-muted-foreground">{conditions || t(key('unknownConditions'))}</p>
      {run.partial && <p className="text-xs font-medium">{t(key('partial'))}</p>}
    </li>
  );
}
