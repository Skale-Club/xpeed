# The site inside the Companion (contract)

Decision: the site and the Companion are one mirror. Every page of the site's Virtual menu is built once, on the site, and
the Companion shows that same page inside its window (WebView2) instead of opening the browser. Live in-game screens
(Dashboard, Monitor) stay native in the Companion. Nobody re-draws a site page in `xpeed-sim/src/panel`.
Journal: XPD-150 ("Next"), 2026-11-21.

## How the site knows it is inside the Companion

Either signal turns the site's **shell mode** on:

1. The user agent contains `XpeedCompanion/` (the Companion appends ` XpeedCompanion/<version>` to WebView2's own user
   agent). This is the main signal: it survives reloads, sign-in redirects and links.
2. The address has `?shell=companion` (for checking in a normal browser). The site remembers it in `sessionStorage`
   (`xpeed.shell`) for the rest of that tab, and `?shell=off` clears it.

## What shell mode changes on the site

- No sidebar, no top bar (page trail, Go to, Companion status), no phone tab bar, no install prompt, no PWA update banner, no
  Real | Virtual switch: the Companion draws its own header and menu around the page.
- The page content keeps its padding; the Virtual example banner and the racing assistant bubble stay (they are page
  features, so they mirror).
- Virtual only (owner rule: Real and Virtual never mixed; RC never shown): a Real route redirects to `/virtual`.
- Everything else (pages, data, sign-in page) is the normal site. A page change ships to the Companion with the site's deploy.

## What the Companion does

- A click on a site place in the sidebar shows `{server}{place.to}` in the content area (right of the sidebar, under the
  header). The Companion's header and sidebar stay native. Dashboard, Monitor and Settings stay native screens.
- The sidebar marks the place the page is on, from the WebView's current address (longest matching place path; `/virtual`
  only on itself), so navigating inside the page moves the highlight.
- Only the configured server's origin loads in place. A link or new window to another origin opens in the person's
  browser, except the sign-in hosts the site's login needs as pop-ups (`accounts.google.com`, `*.google.com`,
  `*.firebaseapp.com`, `*.web.app`, `www.recaptcha.net`), which WebView2 opens as its own pop-up window.
- Its WebView2 profile lives in `%APPDATA%\Xpeed Companion\WebView` (the sign-in is kept there; never delete it without
  the owner's OK).
- Memory: the WebView is made on the first click, hidden on a native screen, and closed when the panel window closes or
  after 5 minutes on native screens; it is made again on the next click.
- No WebView2 runtime, or it fails to start: the place opens in the browser, as before, and the log says why.

## Sign-in

Stage 1 (now): the person signs in once inside the Companion with the site's own login; WebView2 keeps the session.
Stage 2 (needs the owner): the Companion trades its device key for a one-time code and the site signs in with a Firebase
custom token, so no second login. It needs a Firebase service-account key in the server's environment, which does not
exist yet.
