# shared/design

What the website and the Xpeed Companion must show alike. Change it here once and both follow, so they never drift apart.

| File | Read by the site | Read by the Companion |
|---|---|---|
| `nav.json`: the menus (places, order, groups, icons, label keys) | `src/lib/mode-nav.ts` | `xpeed-sim/build.rs` → `panel/site.rs`, `panel/nav.rs` (the Virtual menu, Settings and its own screens' icons) |
| `icons.json`: the Lucide shapes of the icons the Companion draws | (it uses `lucide-react` itself) | `panel/icons.rs` |
| `companion-shell.md`: how the site's own Virtual pages show inside the Companion (shell mode, WebView2) | `src/lib/companion-shell.ts` | `panel/webview.rs` |

The Companion also takes from the site at build time:

- the colours of `src/index.css` (`:root`), as `site::SITE_*`, used by `panel/tokens.rs`;
- the menu labels from `src/locales/{en,pt-BR,es-ES}.json` (the keys named in `nav.json`).

After changing an icon in `nav.json` or upgrading `lucide-react`, run `npm run design:icons`. `src/lib/shared-design.test.ts`
fails until `icons.json` matches.

## On purpose, not mirrored (owner decisions)

Kept the Companion's own and pinned by its tests:

- the near-square corner `R_CORNER` (2.5 px, 2026-11-12) instead of the site's radii;
- the Chakra Petch typeface;
- the brand yellow `#F5E663` (the site's `--primary` HSL rounds to `#f5e661`).
