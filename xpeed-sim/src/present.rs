//! How the state is shown to the person: the colour of the icon, the tooltip, the words of each balloon.
//! Pure, so it is tested without a screen.

use crate::icon::Light;
use crate::status::{Cloud, Game, Notice, Snapshot};
use crate::text::{text, Lang, Msg};

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
            Notice::LapSaved(label) => Msg::NoticeLapSaved(label.clone()),
            Notice::LapsSent(n) => Msg::NoticeLapsSent(*n),
            Notice::Paired(name) => Msg::NoticePaired(name.clone()),
            Notice::NotPaired => Msg::NoticeNotPaired,
            Notice::Refused => Msg::NoticeRefused,
        },
    );
    ("Xpeed Sim".to_owned(), body)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn balloons_have_a_title_and_a_sentence_in_the_language() {
        assert_eq!(
            notice_text(Lang::En, &Notice::LapSaved("Lap 3  1:42.318".into())),
            ("Xpeed Sim".into(), "Lap saved: Lap 3  1:42.318".into())
        );
        assert_eq!(notice_text(Lang::Es, &Notice::Paired("RIG".into())).1, "Conectado como RIG");
        assert!(notice_text(Lang::Pt, &Notice::NotPaired).1.contains("botão direito"));
    }
}
