//! The example: the dashboards on made-up driving, opened from the waiting screen while no game is on (a cover shows that
//! game's dashboard, with only the cards it can fill; "See the dashboards" shows every card). It can be edited like the real
//! one, and what is saved is the same `dashboards.json`, so it is there when the game comes.
//!
//! The made-up driving goes into a `Shared` of its own, which nothing else reads: no lap is written, nothing is sent to the
//! server or to the phone, the heartbeat still says no game is on, and the log and the tray hear nothing. The dashboard chosen
//! in the example (the workspace menu, `D`) is kept here, not in the driver's choices. A game that starts driving closes it.

use super::demo::feed;
use super::*;

pub(super) struct Preview {
    /// Where the made-up driving goes; only the panel reads it, and only while this is open.
    pub(super) shared: Arc<Shared>,
    /// The game whose dashboard is shown (its id and name), or `None` for every card.
    pub(super) game: Option<(&'static str, &'static str)>,
    /// The dashboard picked in the example (none picked: the race one), forgotten when it closes.
    pub(super) choices: Choices,
    feeder: Option<std::thread::JoinHandle<()>>,
}

/// The id the example drives as when it shows every card.
pub(super) const PREVIEW_ALL: (&str, &str) = ("demo", "Demo");

impl Preview {
    /// Opens the example for `game` (its id and name, as the covers list it), or for every card.
    pub(super) fn open(game: Option<(&'static str, &'static str)>) -> Preview {
        let shared = Shared::new(false);
        let caps = game.and_then(|(id, _)| crate::games::caps_of_game(id));
        let drive_as = game.unwrap_or(PREVIEW_ALL);
        let mut choices = Choices::default();
        // A race shows the most: the field, the place, the time left.
        choices.set(drive_as.1, Some(DashboardId::Race));
        let feeder = {
            let shared = shared.clone();
            std::thread::Builder::new()
                .name("panel example".into())
                .spawn(move || feed(&shared, drive_as, caps, false))
                .ok()
        };
        Preview {
            shared,
            game,
            choices,
            feeder,
        }
    }

    /// The words of the header's pill: "Example · Assetto Corsa", or "Example · All cards".
    pub(super) fn label(&self, lang: Lang) -> String {
        let what = self
            .game
            .map_or_else(|| text(lang, &Msg::PanelPreviewAll), |(_, name)| name.to_owned());
        format!("{} · {what}", text(lang, &Msg::PanelPreviewTag))
    }
}

impl Drop for Preview {
    fn drop(&mut self) {
        self.shared.quit();
        if let Some(feeder) = self.feeder.take() {
            let _ = feeder.join();
        }
    }
}
