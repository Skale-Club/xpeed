import { Navigate, Outlet } from 'react-router-dom';
import { useModes } from '@/contexts/ModesContext';
import { MODE_HOME, type Mode } from '@/lib/modes';

/**
 * Layout route for the screens of one mode. Someone who did not choose that
 * mode never sees its screens: a link or bookmark lands on the mode they have.
 * (The server refuses the Virtual API the same way once accounts store the choice.)
 */
export function ModeGate({ mode }: { mode: Mode }) {
  const { modes } = useModes();
  return modes.includes(mode) ? <Outlet /> : <Navigate to={MODE_HOME[modes[0] ?? 'real']} replace />;
}
