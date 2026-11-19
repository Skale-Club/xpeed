//! How the state is shown to the person: the colour of the icon, the tooltip, the words of each balloon.
//! Pure, so it is tested without a screen.

use crate::icon::Light;
use crate::status::{Cloud, Game, Notice, Snapshot};
use crate::text::{text, Lang, Msg};
use crate::update::{CheckState, UpdateState};

pub fn light_of(snapshot: &Snapshot) -> Light {
    match (&snapshot.cloud, &snapshot.game) {
        (Cloud::Refused, _) | (_, Game::Unsupported) => Light::Red,
        (_, Game::Paused) => Light::Grey,
        (_, Game::Waiting | Game::Silent | Game::Loading) => Light::Amber,
        (_, Game::Connected | Game::Recording(_)) => Light::Green,
    }
}

/// The state of the game, and which game when one is connected (`Recording lap 3 · Assetto Corsa`).
pub fn game_line_of(lang: Lang, snapshot: &Snapshot) -> String {
    let line = game_line(lang, &snapshot.game);
    match snapshot.title {
        Some(title) => format!("{line} · {title}"),
        None => line,
    }
}

pub fn game_line(lang: Lang, game: &Game) -> String {
    text(
        lang,
        &match game {
            Game::Waiting => Msg::GameWaiting,
            Game::Connected => Msg::GameConnected,
            Game::Recording(lap) => Msg::GameRecording(*lap),
            Game::Paused => Msg::GamePaused,
            Game::Unsupported => Msg::GameUnsupported,
            Game::Silent => Msg::GameSilent,
            Game::Loading => Msg::GameLoading,
        },
    )
}

pub fn cloud_line(lang: Lang, cloud: &Cloud, device: Option<&str>) -> String {
    text(
        lang,
        &match cloud {
            Cloud::NotPaired => Msg::CloudNotPaired,
            Cloud::Idle => Msg::CloudIdle(device.unwrap_or("?").to_owned()),
            Cloud::Waiting(n) => Msg::CloudWaiting(*n),
            Cloud::Refused => Msg::CloudRefused,
        },
    )
}

/// The tooltip over the icon. Windows keeps 127 characters; longer text is cut with an ellipsis.
pub fn tooltip(lang: Lang, snapshot: &Snapshot, device: Option<&str>) -> String {
    let full = format!("{}\n{}", game_line_of(lang, snapshot), cloud_line(lang, &snapshot.cloud, device));
    if full.encode_utf16().count() <= 127 {
        return full;
    }
    let mut cut: String = full.chars().take(126).collect();
    cut.push('…');
    cut
}

/// The title and the text of a balloon.
pub fn notice_text(lang: Lang, notice: &Notice) -> (String, String) {
    let body = text(
        lang,
        &match notice {
            Notice::LapSaved(lap) => Msg::NoticeLapSaved(lap.clone()),
            Notice::LapsSent(n) => Msg::NoticeLapsSent(*n),
            Notice::Paired(name) => Msg::NoticePaired(name.clone()),
            Notice::NotPaired => Msg::NoticeNotPaired,
            Notice::Refused => Msg::NoticeRefused,
            Notice::Updated(version) => Msg::NoticeUpdated(version.clone()),
            Notice::UpdateBlocked(version) => Msg::NoticeUpdateBlocked(version.clone()),
            Notice::UpToDate(version) => Msg::NoticeUpToDate(version.clone()),
            Notice::UpdateCheckFailed => Msg::NoticeUpdateCheckFailed,
            Notice::NeedsSetup { id, name } => Msg::NoticeNeedsSetup(id, name),
        },
    );
    ("Xpeed Companion".to_owned(), body)
}

/// The title and the text of the balloon for a lap that could not be saved (`reason` is short).
pub fn save_alert_text(lang: Lang, reason: &str) -> (String, String) {
    ("Xpeed Companion".to_owned(), text(lang, &Msg::NoticeLapNotSaved(reason.to_owned())))
}

/// What the Monitor tab and the tray menu say about a new version.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateLine {
    /// `Update available: 0.6.0`, `Downloading the update…`...
    pub headline: String,
    /// The running version is older than the server's minimum: shown more prominently.
    pub required: bool,
    /// "Update now" can be clicked (not while it downloads, nor while it waits for a game to close).
    pub button: bool,
}

pub fn update_line(lang: Lang, state: &UpdateState) -> Option<UpdateLine> {
    let (msg, required, button) = match state {
        UpdateState::Nothing => return None,
        UpdateState::Downloading { .. } => (Msg::UpdateDownloading, false, false),
        UpdateState::Available {
            version,
            held: true,
            required,
        } => (Msg::UpdateHeld(version.clone()), *required, false),
        UpdateState::Available {
            version,
            required: true,
            held: false,
        } => (Msg::UpdateRequired(version.clone()), true, true),
        UpdateState::Available { version, .. } => (Msg::UpdateAvailable(version.clone()), false, true),
    };
    Some(UpdateLine {
        headline: text(lang, &msg),
        required,
        button,
    })
}

/// The Monitor tab's update card, always shown (as Xdeck's Updates area): what is going on in one line, the colour of
/// its dot, the bar under it and the one button that fits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateCard {
    pub status: String,
    pub tone: CardTone,
    pub bar: CardBar,
    pub button: Option<CardButton>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardTone {
    /// Nothing to report.
    Quiet,
    /// Up to date.
    Good,
    /// A new version, or one coming.
    Brand,
    /// A look that got no answer.
    Warn,
    /// The running version must be replaced.
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardBar {
    None,
    /// Something is under way and how far is not known: a sliding bar.
    Busy,
    /// This share of a download has arrived.
    Percent(u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardButton {
    /// "Update now" (yellow).
    UpdateNow,
    /// "Check now".
    CheckNow,
    /// "Try again", after a look that got no answer.
    TryAgain,
}

impl CardButton {
    pub fn label(self, lang: Lang) -> String {
        text(
            lang,
            &match self {
                CardButton::UpdateNow => Msg::UpdateNow,
                CardButton::CheckNow => Msg::UpdateCheckNow,
                CardButton::TryAgain => Msg::UpdateTryAgain,
            },
        )
    }
}

/// "just now", "5 min ago", "3 h ago", "2 d ago" from `then` to `now` (Unix ms).
pub fn ago(lang: Lang, then_ms: i64, now_ms: i64) -> String {
    let minutes = (now_ms - then_ms).max(0) as u64 / 60_000;
    text(
        lang,
        &match minutes {
            0 => Msg::AgoJustNow,
            m if m < 60 => Msg::AgoMinutes(m),
            m if m < 24 * 60 => Msg::AgoHours(m / 60),
            m => Msg::AgoDays(m / (24 * 60)),
        },
    )
}

/// The card for `running` (this version): a version waiting or downloading says so first; otherwise what the last
/// look said.
pub fn update_card(lang: Lang, running: &str, state: &UpdateState, check: &CheckState, percent: Option<u8>, now_ms: i64) -> UpdateCard {
    let card = |status: Msg, tone, bar, button| UpdateCard {
        status: text(lang, &status),
        tone,
        bar,
        button,
    };
    match (state, check) {
        (UpdateState::Downloading { version }, _) => match percent {
            Some(p) => card(
                Msg::UpdateDownloadingPercent(version.clone(), p),
                CardTone::Brand,
                CardBar::Percent(p),
                None,
            ),
            None => card(Msg::UpdateDownloading, CardTone::Brand, CardBar::Busy, None),
        },
        (
            UpdateState::Available {
                version,
                held: true,
                required,
            },
            _,
        ) => card(
            Msg::UpdateHeld(version.clone()),
            if *required { CardTone::Danger } else { CardTone::Brand },
            CardBar::None,
            None,
        ),
        (
            UpdateState::Available {
                version, required: true, ..
            },
            _,
        ) => card(
            Msg::UpdateRequired(version.clone()),
            CardTone::Danger,
            CardBar::None,
            Some(CardButton::UpdateNow),
        ),
        (UpdateState::Available { version, .. }, _) => card(
            Msg::UpdateAvailable(version.clone()),
            CardTone::Brand,
            CardBar::None,
            Some(CardButton::UpdateNow),
        ),
        (UpdateState::Nothing, CheckState::Checking) => card(Msg::UpdateChecking, CardTone::Quiet, CardBar::Busy, None),
        (UpdateState::Nothing, CheckState::UpToDate { at_ms }) => card(
            Msg::UpdateUpToDate(running.to_owned(), ago(lang, *at_ms, now_ms)),
            CardTone::Good,
            CardBar::None,
            Some(CardButton::CheckNow),
        ),
        (UpdateState::Nothing, CheckState::Failed) => {
            card(Msg::UpdateCheckFailed, CardTone::Warn, CardBar::None, Some(CardButton::TryAgain))
        }
        (UpdateState::Nothing, CheckState::Idle) => card(
            Msg::UpdateChecksOnItsOwn(running.to_owned()),
            CardTone::Quiet,
            CardBar::None,
            Some(CardButton::CheckNow),
        ),
    }
}

/// The tray menu's "Check for updates", or "Checking for updates…" (grayed) while a look is under way.
pub fn check_menu_line(lang: Lang, check: &CheckState) -> (String, bool) {
    match check {
        CheckState::Checking => (text(lang, &Msg::UpdateChecking), false),
        _ => (text(lang, &Msg::MenuCheckUpdates), true),
    }
}

/// The tray menu's line: `Update available: 0.6.0 · Update now` (clickable), or the plain headline (grayed).
pub fn update_menu_line(lang: Lang, state: &UpdateState) -> Option<(String, bool)> {
    update_line(lang, state).map(|line| {
        if line.button {
            (format!("{} · {}", line.headline, text(lang, &Msg::UpdateNow)), true)
        } else {
            (line.headline, false)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_update_card_says_what_xdeck_says_with_the_one_button_that_fits() {
        use crate::update::{CheckState, UpdateState};
        let now = 10 * 60 * 60 * 1000;
        let card = |state: &UpdateState, check: &CheckState, percent| update_card(Lang::En, "0.13.1", state, check, percent, now);
        let nothing = UpdateState::Nothing;

        let idle = card(&nothing, &CheckState::Idle, None);
        assert_eq!(idle.status, "Version 0.13.1 · checks for updates on its own");
        assert_eq!(
            (idle.tone, idle.bar, idle.button),
            (CardTone::Quiet, CardBar::None, Some(CardButton::CheckNow))
        );

        let checking = card(&nothing, &CheckState::Checking, None);
        assert_eq!(checking.status, "Checking for updates…");
        assert_eq!((checking.bar, checking.button), (CardBar::Busy, None));

        let fresh = card(&nothing, &CheckState::UpToDate { at_ms: now - 5 * 60_000 }, None);
        assert_eq!(fresh.status, "Version 0.13.1 is up to date · checked 5 min ago");
        assert_eq!((fresh.tone, fresh.button), (CardTone::Good, Some(CardButton::CheckNow)));

        let failed = card(&nothing, &CheckState::Failed, None);
        assert_eq!(failed.status, "Couldn't check for updates");
        assert_eq!((failed.tone, failed.button), (CardTone::Warn, Some(CardButton::TryAgain)));

        // A version waiting or downloading says so whatever the last look said.
        let downloading = UpdateState::Downloading { version: "0.14.0".into() };
        let bar = card(&downloading, &CheckState::Idle, Some(42));
        assert_eq!(bar.status, "Downloading 0.14.0… 42%");
        assert_eq!((bar.bar, bar.button), (CardBar::Percent(42), None));
        assert_eq!(card(&downloading, &CheckState::Failed, None).bar, CardBar::Busy);
        let available = |required, held| UpdateState::Available {
            version: "0.14.0".into(),
            required,
            held,
        };
        let new = card(&available(false, false), &CheckState::Failed, None);
        assert_eq!((new.tone, new.button), (CardTone::Brand, Some(CardButton::UpdateNow)));
        let required = card(&available(true, false), &CheckState::Idle, None);
        assert_eq!((required.tone, required.button), (CardTone::Danger, Some(CardButton::UpdateNow)));
        assert_eq!(
            card(&available(false, true), &CheckState::Idle, None).button,
            None,
            "held: waits for the game"
        );

        // Portuguese too, and the button labels.
        let pt = update_card(Lang::Pt, "0.13.1", &nothing, &CheckState::UpToDate { at_ms: now }, None, now);
        assert_eq!(pt.status, "Versão 0.13.1 está atualizada · verificado agora mesmo");
        assert_eq!(CardButton::CheckNow.label(Lang::Pt), "Verificar agora");
        assert_eq!(CardButton::TryAgain.label(Lang::Pt), "Tentar de novo");
    }

    #[test]
    fn ago_steps_from_minutes_to_hours_to_days() {
        let now = 100 * 24 * 60 * 60 * 1000;
        let ago_min = |m: i64| ago(Lang::En, now - m * 60_000, now);
        assert_eq!(ago_min(0), "just now");
        assert_eq!(ago_min(59), "59 min ago");
        assert_eq!(ago_min(60), "1 h ago");
        assert_eq!(ago_min(24 * 60 - 1), "23 h ago");
        assert_eq!(ago_min(3 * 24 * 60), "3 d ago");
        assert_eq!(
            ago(Lang::En, now + 60_000, now),
            "just now",
            "a clock that moved back is not the future"
        );
    }

    #[test]
    fn the_tray_menu_check_is_grayed_while_a_look_is_under_way() {
        use crate::update::CheckState;
        assert_eq!(check_menu_line(Lang::En, &CheckState::Idle), ("Check for updates".to_owned(), true));
        assert_eq!(
            check_menu_line(Lang::En, &CheckState::Failed),
            ("Check for updates".to_owned(), true)
        );
        assert_eq!(
            check_menu_line(Lang::Pt, &CheckState::Checking),
            ("Verificando atualizações…".to_owned(), false)
        );
    }

    fn snapshot(game: Game, cloud: Cloud) -> Snapshot {
        Snapshot {
            game,
            title: None,
            cloud,
            laps_saved: 0,
            last_lap: None,
        }
    }

    #[test]
    fn the_icon_light_tells_what_needs_a_look() {
        assert_eq!(light_of(&snapshot(Game::Waiting, Cloud::Idle)), Light::Amber);
        assert_eq!(light_of(&snapshot(Game::Connected, Cloud::Idle)), Light::Green);
        assert_eq!(light_of(&snapshot(Game::Recording(3), Cloud::Waiting(2))), Light::Green);
        assert_eq!(light_of(&snapshot(Game::Paused, Cloud::Idle)), Light::Grey);
        assert_eq!(light_of(&snapshot(Game::Unsupported, Cloud::Idle)), Light::Red);
        // A refused key is red whatever the game does, because laps pile up unsent.
        assert_eq!(light_of(&snapshot(Game::Recording(3), Cloud::Refused)), Light::Red);
        assert_eq!(light_of(&snapshot(Game::Paused, Cloud::Refused)), Light::Red);
    }

    #[test]
    fn the_tooltip_says_the_game_then_the_account() {
        let tip = tooltip(Lang::En, &snapshot(Game::Recording(7), Cloud::Waiting(2)), Some("RIG"));
        assert_eq!(tip, "Recording lap 7\n2 lap(s) waiting to be sent");
        let tip = tooltip(Lang::Pt, &snapshot(Game::Waiting, Cloud::Idle), Some("MEU-PC"));
        assert_eq!(tip, "Jogo: esperando um jogo de corrida\nConectado como MEU-PC");
    }

    #[test]
    fn the_line_names_the_game_when_one_is_connected() {
        let mut shot = snapshot(Game::Recording(7), Cloud::Idle);
        shot.title = Some("Assetto Corsa");
        assert_eq!(game_line_of(Lang::En, &shot), "Recording lap 7 · Assetto Corsa");
        assert_eq!(
            tooltip(Lang::En, &shot, Some("RIG")),
            "Recording lap 7 · Assetto Corsa
Connected as RIG"
        );
        assert_eq!(
            game_line_of(Lang::En, &snapshot(Game::Waiting, Cloud::Idle)),
            "Game: waiting for a racing game"
        );
    }

    #[test]
    fn a_very_long_device_name_cannot_break_the_tooltip() {
        let tip = tooltip(Lang::En, &snapshot(Game::Waiting, Cloud::Idle), Some(&"N".repeat(200)));
        assert_eq!(tip.encode_utf16().count(), 127);
        assert!(tip.ends_with('…'));
    }

    #[test]
    fn says_what_an_update_waiting_means_in_each_language() {
        let available = UpdateState::Available {
            version: "0.6.0".into(),
            required: false,
            held: false,
        };
        let line = update_line(Lang::En, &available).unwrap();
        assert_eq!(
            (line.headline.as_str(), line.required, line.button),
            ("Update available: 0.6.0", false, true)
        );
        assert_eq!(
            update_menu_line(Lang::En, &available),
            Some(("Update available: 0.6.0 · Update now".into(), true))
        );
        assert_eq!(
            update_menu_line(Lang::Pt, &available),
            Some(("Atualização disponível: 0.6.0 · Atualizar agora".into(), true))
        );
        assert_eq!(
            update_menu_line(Lang::Es, &available),
            Some(("Actualización disponible: 0.6.0 · Actualizar ahora".into(), true))
        );
        // Required: more prominent, and the same button.
        let required = UpdateState::Available {
            version: "0.6.0".into(),
            required: true,
            held: false,
        };
        let line = update_line(Lang::En, &required).unwrap();
        assert_eq!(
            (line.headline.as_str(), line.required, line.button),
            ("Update required: 0.6.0", true, true)
        );
        // Waiting for the game to close: no button. Downloading: the words of the spec, no button, and then nothing.
        let held = UpdateState::Available {
            version: "0.6.0".into(),
            required: false,
            held: true,
        };
        let line = update_line(Lang::En, &held).unwrap();
        assert!(!line.button && line.headline.contains("0.6.0") && line.headline.contains("no game"));
        assert_eq!(update_menu_line(Lang::En, &held).map(|(_, clickable)| clickable), Some(false));
        let downloading = UpdateState::Downloading { version: "0.6.0".into() };
        assert_eq!(
            update_menu_line(Lang::En, &downloading),
            Some(("Downloading the update…".into(), false))
        );
        assert_eq!(update_line(Lang::En, &UpdateState::Nothing), None);
        // The balloon after an update.
        assert_eq!(
            notice_text(Lang::En, &Notice::Updated("0.6.0".into())),
            ("Xpeed Companion".into(), "Xpeed Companion was updated to 0.6.0".into())
        );
    }

    #[test]
    fn the_balloon_for_a_game_without_data_says_which_game_and_what_to_switch_on() {
        let notice = Notice::NeedsSetup {
            id: "ams2",
            name: "Automobilista 2",
        };
        let (title, body) = notice_text(Lang::En, &notice);
        assert_eq!(title, "Xpeed Companion");
        assert!(body.starts_with("Automobilista 2 is open but not sharing data yet."), "{body}");
        assert!(body.contains("Options > System > Use Shared Memory"), "{body}");
        assert!(notice_text(Lang::Pt, &notice).1.contains("não compartilha"));
        assert!(notice_text(Lang::Es, &notice).1.contains("no comparte"));
    }

    #[test]
    fn balloons_have_a_title_and_a_sentence_in_the_language() {
        assert_eq!(
            notice_text(Lang::En, &Notice::LapSaved(crate::status::saved_lap(3, 102_318))),
            ("Xpeed Companion".into(), "Lap saved: Lap 3  1:42.318".into())
        );
        assert_eq!(
            notice_text(Lang::Pt, &Notice::LapSaved(crate::status::saved_lap(3, 102_318))).1,
            "Volta gravada: Volta 3  1:42.318",
            "the lap's own words are in the person's language too"
        );
        assert_eq!(notice_text(Lang::Es, &Notice::Paired("RIG".into())).1, "Conectado como RIG");
        assert!(notice_text(Lang::Pt, &Notice::NotPaired).1.contains("botão direito"));
    }
}
