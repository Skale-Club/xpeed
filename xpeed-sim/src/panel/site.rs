//! What the panel takes from the website at build time (`build.rs`, `site_design`), so the two stay one design: the site's
//! colours (`src/index.css`, as `SITE_*`), its Virtual menu (`shared/design/nav.json`) with the names the site gives each place,
//! and the icons of the Companion's own screens and of Settings. Change them there, not here.

// Every colour of the site's `:root` comes in; the panel uses only the ones it mirrors.
#![allow(dead_code)]

/// One place of the website's Virtual menu: its path on the site, its group, its Lucide icon (`shared/design/icons.json`) and
/// its name in English, Portuguese and Spanish (the order of `Lang::ALL`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct WebPlace {
    pub to: &'static str,
    pub group: &'static str,
    pub icon: &'static str,
    pub label: [&'static str; 3],
}

include!(concat!(env!("OUT_DIR"), "/site_design.rs"));
