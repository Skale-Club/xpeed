/**
 * Old addresses (Xpeed Companion 0.2.0 and saved links open them) and where each one lives now.
 * `/sim/connect/<id>` -> `/companion/connect/<id>`, `/sim/app` -> `/virtual/companion`,
 * `/sim/<x>` -> `/virtual/<x>`, `/sim` -> `/virtual`. Returns null for any other path.
 */
export function legacyPathTarget(pathname: string): string | null {
  if (pathname === '/sim' || pathname === '/sim/') return '/virtual';
  if (!pathname.startsWith('/sim/')) return null;
  const rest = pathname.slice('/sim'.length); // "/connect/<id>", "/app", "/sessions", ...
  if (rest === '/app' || rest === '/app/') return '/virtual/companion';
  if (rest.startsWith('/connect/')) return `/companion${rest}`;
  return `/virtual${rest}`;
}

/** A stored route (path plus optional query/hash) translated to its current address; unchanged if already current. */
export function currentRoute(route: string): string {
  const cut = route.search(/[?#]/);
  const path = cut === -1 ? route : route.slice(0, cut);
  const tail = cut === -1 ? '' : route.slice(cut);
  const target = legacyPathTarget(path);
  return target ? target + tail : route;
}
