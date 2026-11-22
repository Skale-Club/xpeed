//! The sidebar's buttons, mirrored from the website's menu (`shared/design/nav.json`, read in at build time by `site`): the
//! Dashboard first, then the site's Virtual places in their groups and order, then Monitor and Settings (Monitor second to last,
//! the owner's order of 2026-11-22), a line between groups. A screen opens in the panel; a website place shows the site's own page inside the panel (`webview`; the
//! browser opens it only when WebView2 is not available). Names and icons come from the site, so a change there shows here.

use super::site::{WebPlace, SCREEN_ICONS, SETTINGS_ICON, WEB_PLACES};
use super::*;

/// What a sidebar button opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SideItem {
    /// One of the panel's screens.
    Screen(Tab),
    /// A place of the website.
    Web(WebPlace),
}

impl SideItem {
    /// Its Lucide icon, by name (`shared/design/icons.json`).
    pub(super) fn icon(self) -> &'static str {
        let screen = |id: &str| SCREEN_ICONS.iter().find(|(i, _)| *i == id).map_or("", |(_, name)| *name);
        match self {
            SideItem::Screen(Tab::Dash) => screen("dashboard"),
            SideItem::Screen(Tab::Monitor) => screen("monitor"),
            SideItem::Screen(Tab::Settings) => SETTINGS_ICON,
            SideItem::Web(place) | SideItem::Screen(Tab::Web(place)) => place.icon,
        }
    }

    /// The button of the screen or page that is open: the one the sidebar marks.
    pub(super) fn of_tab(tab: Tab) -> SideItem {
        match tab {
            Tab::Web(place) => SideItem::Web(place),
            screen => SideItem::Screen(screen),
        }
    }

    /// Its name in `lang`, for the tooltip: the panel's own words for a screen, the site's for a place of the site.
    pub(super) fn label(self, lang: Lang) -> String {
        match self {
            SideItem::Screen(Tab::Dash) => text(lang, &Msg::PanelTabDash),
            SideItem::Screen(Tab::Monitor) => text(lang, &Msg::PanelTabMonitor),
            SideItem::Screen(Tab::Settings) => text(lang, &Msg::PanelTabSettings),
            SideItem::Web(place) | SideItem::Screen(Tab::Web(place)) => {
                place.label[Lang::ALL.iter().position(|l| *l == lang).unwrap_or(0)].to_owned()
            }
        }
    }
}

/// The icon's side in a sidebar button (design pixels): the site's menu icons are 16 px (`[&>svg]:size-4`).
pub(super) const SIDEBAR_ICON: f32 = 16.0;

/// The gap between two buttons of one group (design pixels): the site's menu (`gap-1`).
pub(super) const SIDEBAR_GAP: f32 = 4.0;

/// The room between two groups (design pixels), with a line across the middle where the site has a group's title.
pub(super) const SIDEBAR_GROUP_GAP: f32 = 13.0;

/// Where the first button's top sits (design pixels): its middle level with the header's buttons.
const SIDEBAR_TOP: f32 = 16.0;

/// The sidebar's buttons (pixels) and the lines between its groups (the top of each line, pixels).
pub(super) struct SidebarLayout {
    pub buttons: Vec<(SideItem, RECT)>,
    pub dividers: Vec<i32>,
}

/// The buttons in their groups: Dashboard, the site's Virtual groups in the site's order, then Monitor and Settings.
pub(super) fn sidebar_groups() -> Vec<Vec<SideItem>> {
    let mut groups = vec![vec![SideItem::Screen(Tab::Dash)]];
    let mut last: Option<&str> = None;
    for place in WEB_PLACES {
        if last == Some(place.group) {
            if let Some(group) = groups.last_mut() {
                group.push(SideItem::Web(*place));
            }
        } else {
            groups.push(vec![SideItem::Web(*place)]);
        }
        last = Some(place.group);
    }
    groups.push(vec![SideItem::Screen(Tab::Monitor), SideItem::Screen(Tab::Settings)]);
    groups
}

/// Where each sidebar button is (pixels): squares centred in the sidebar's width, top to bottom.
pub(super) fn sidebar_layout(scale: f32) -> SidebarLayout {
    let p = |v: f32| (v * scale).round() as i32;
    let left = p((SIDEBAR_W - SIDEBAR_BUTTON) / 2.0);
    let side = p(SIDEBAR_BUTTON);
    let (mut buttons, mut dividers) = (Vec::new(), Vec::new());
    let mut y = SIDEBAR_TOP;
    for (n, group) in sidebar_groups().into_iter().enumerate() {
        if n > 0 {
            dividers.push(p(y + (SIDEBAR_GROUP_GAP - 1.0) / 2.0));
            y += SIDEBAR_GROUP_GAP;
        }
        for (i, item) in group.into_iter().enumerate() {
            if i > 0 {
                y += SIDEBAR_GAP;
            }
            let top = p(y);
            buttons.push((item, rect(left, top, left + side, top + side)));
            y += SIDEBAR_BUTTON;
        }
    }
    SidebarLayout { buttons, dividers }
}

/// The button under the point (pixels), if any.
pub(super) fn sidebar_hit(scale: f32, x: i32, y: i32) -> Option<SideItem> {
    sidebar_layout(scale)
        .buttons
        .into_iter()
        .find(|(_, r)| inside(r, x, y))
        .map(|(item, _)| item)
}

#[cfg(test)]
mod nav_tests {
    use super::*;

    #[test]
    fn mirrors_the_site_menu_in_its_order_and_groups() {
        let groups = sidebar_groups();
        assert_eq!(groups.first(), Some(&vec![SideItem::Screen(Tab::Dash)]));
        // Monitor is second to last, right above Settings (owner, 2026-11-22).
        assert_eq!(
            groups.last(),
            Some(&vec![SideItem::Screen(Tab::Monitor), SideItem::Screen(Tab::Settings)])
        );
        let all: Vec<SideItem> = groups.iter().flatten().copied().collect();
        assert_eq!(all[all.len() - 2], SideItem::Screen(Tab::Monitor));
        let web: Vec<&str> = groups
            .iter()
            .flatten()
            .filter_map(|i| if let SideItem::Web(p) = i { Some(p.to) } else { None })
            .collect();
        assert_eq!(
            web,
            WEB_PLACES.iter().map(|p| p.to).collect::<Vec<_>>(),
            "every Virtual place of the site, in its order"
        );
        // The site's groups today: Driving, Community, Garage, two places each.
        let sizes: Vec<usize> = groups[1..groups.len() - 1].iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![2, 2, 2]);
        assert_eq!(WEB_PLACES[0].to, "/virtual");
        // Named in the site's own words, in each language.
        assert_eq!(WEB_PLACES[0].label, ["Overview", "Painel", "Panel"]);
        assert_eq!(SideItem::Web(WEB_PLACES[0]).label(Lang::Pt), "Painel");
    }

    #[test]
    fn fits_the_smallest_window_without_overlaps() {
        let layout = sidebar_layout(1.0);
        let last = layout.buttons.last().unwrap().1;
        assert!(
            last.bottom <= MIN_HEIGHT - 16,
            "the last button ends inside the smallest window: {}",
            last.bottom
        );
        for pair in layout.buttons.windows(2) {
            assert!(pair[1].1.top >= pair[0].1.bottom + 4, "a gap between buttons");
        }
        assert_eq!(layout.dividers.len(), sidebar_groups().len() - 1);
        for (item, r) in &layout.buttons {
            assert_eq!(
                (r.right - r.left, r.bottom - r.top),
                (32, 32),
                "{item:?}: the site's 32 px icon button"
            );
            assert!(r.right <= content_left(1.0));
        }
        assert_eq!(sidebar_hit(1.0, 24, 32), Some(SideItem::Screen(Tab::Dash)));
    }
}
