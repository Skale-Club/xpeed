import type { TrainingMeasurement } from './training-types.ts';

export const MAX_SETUP_PARAMETERS = 32;

export interface SetupParameter {
  name: string;
  value: string;
  unit: string;
}

export interface SetupVersionDraft {
  label: string;
  notes: string;
  parameters: SetupParameter[];
  parentId: string | null;
}

export interface SetupVersion extends SetupVersionDraft {
  id: string;
  createdAt: string;
  runs: TrainingMeasurement[];
}

export interface SetupLibrary {
  versions: SetupVersion[];
  selectedVersionId: string | null;
  limit: number;
}

export interface SetupParameterChange {
  name: string;
  before: string | null;
  after: string | null;
}

const keyFor = (name: string) => name.trim().toLowerCase();

function hasControlCharacter(text: string) {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

export function normalizeSetupDraft(draft: SetupVersionDraft): SetupVersionDraft | null {
  const label = draft.label.trim();
  const notes = draft.notes.trim();
  if (!label || label.length > 120 || draft.notes.length > 1_000 || hasControlCharacter(label)) return null;
  if (draft.parameters.length < 1 || draft.parameters.length > MAX_SETUP_PARAMETERS) return null;
  const parameters: SetupParameter[] = [];
  const names = new Set<string>();
  for (const row of draft.parameters) {
    if ([row.name, row.value, row.unit].some(hasControlCharacter)) return null;
    const name = row.name.trim(), value = row.value.trim(), unit = row.unit.trim();
    const key = keyFor(name);
    if (!name || name.length > 60 || !value || value.length > 80 || unit.length > 20 || names.has(key)) return null;
    names.add(key);
    parameters.push({ name, value, unit });
  }
  return { label, notes, parameters, parentId: draft.parentId };
}

export const formatSetupValue = ({ value, unit }: SetupParameter) => unit ? `${value} ${unit}` : value;

/** List changes in parent order, followed by additions in the current version's order. */
export function compareSetupParameters(parent: readonly SetupParameter[], current: readonly SetupParameter[]): SetupParameterChange[] {
  const before = new Map(parent.map((row) => [keyFor(row.name), row]));
  const after = new Map(current.map((row) => [keyFor(row.name), row]));
  const names = new Set([...before.keys(), ...after.keys()]);
  const changes: SetupParameterChange[] = [];
  for (const key of names) {
    const previous = before.get(key), next = after.get(key);
    const previousValue = previous ? formatSetupValue(previous) : null;
    const nextValue = next ? formatSetupValue(next) : null;
    const parameter = next ?? previous;
    if (parameter && previousValue !== nextValue) {
      changes.push({ name: parameter.name, before: previousValue, after: nextValue });
    }
  }
  return changes;
}
