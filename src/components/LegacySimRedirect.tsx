import { Navigate, useLocation } from 'react-router-dom';
import { legacyPathTarget } from '@/lib/legacy-paths';

/** Old /sim addresses (installed Companion 0.2.0, saved links) go to their new address; path rest, query and hash are kept. */
export default function LegacySimRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${legacyPathTarget(pathname) ?? '/virtual'}${search}${hash}`} replace />;
}
