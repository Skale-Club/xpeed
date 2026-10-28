import type { TFunction } from 'i18next';
import { ADAPTER_VOLTAGE, pidHex, type PidDef } from './pids';

/**
 * A reading's name in the app language: standard PIDs are translated under
 * pids.<hex> (English from the PID table as the fallback), the adapter's own
 * voltage under pids.battery, and custom PIDs keep the name their owner gave.
 */
export function channelLabel(channel: { name: string; def: PidDef | null; custom?: unknown }, t: TFunction): string {
  if (channel.custom) return channel.name;
  if (channel.def) return t(`pids.${pidHex(channel.def.pid)}`, channel.def.name);
  if (channel.name === ADAPTER_VOLTAGE.name) return t('pids.battery', channel.name);
  return channel.name;
}
