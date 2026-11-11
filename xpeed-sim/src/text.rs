//! The words the program shows (tray menu, balloons, questions), in the language of Windows.
//! The command line stays in English.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    Pt,
    Es,
}

/// From the primary language id Windows reports (`0x16` Portuguese, `0x0A` Spanish).
pub fn lang_from_id(primary: u16) -> Lang {
    match primary {
        0x16 => Lang::Pt,
        0x0A => Lang::Es,
        _ => Lang::En,
    }
}

pub enum Msg {
    GameWaiting,
    GameConnected,
    GameRecording(u32),
    GamePaused,
    GameUnsupported,
    CloudNotPaired,
    CloudIdle(String),
    CloudWaiting(usize),
    CloudRefused,
    MenuConnect,
    MenuOpenLaps,
    MenuPause,
    MenuResume,
    MenuAutostart,
    MenuQuit,
    NoticeLapSaved(String),
    NoticeLapsSent(u32),
    NoticePaired(String),
    NoticeNotPaired,
    NoticeRefused,
    AskPairTitle,
    AskPair(String),
    PairFailedTitle,
    PairFailed(String),
}

pub fn text(lang: Lang, msg: &Msg) -> String {
    use Msg::*;
    let t = |en: String, pt: String, es: String| match lang {
        Lang::En => en,
        Lang::Pt => pt,
        Lang::Es => es,
    };
    let s = |x: &str| x.to_owned();
    match msg {
        GameWaiting => t(
            s("Game: waiting for a racing game"),
            s("Jogo: esperando um jogo de corrida"),
            s("Juego: esperando un juego de carreras"),
        ),
        GameConnected => t(s("Game: connected"), s("Jogo: conectado"), s("Juego: conectado")),
        GameRecording(lap) => t(
            format!("Recording lap {lap}"),
            format!("Gravando a volta {lap}"),
            format!("Grabando la vuelta {lap}"),
        ),
        GamePaused => t(s("Recording paused"), s("Gravação pausada"), s("Grabación en pausa")),
        GameUnsupported => t(
            s("Game: this version is not supported yet"),
            s("Jogo: esta versão ainda não é suportada"),
            s("Juego: esta versión aún no es compatible"),
        ),
        CloudNotPaired => t(
            s("Not connected to your account"),
            s("Não conectado à sua conta"),
            s("No conectado a tu cuenta"),
        ),
        CloudIdle(name) => t(
            format!("Connected as {name}"),
            format!("Conectado como {name}"),
            format!("Conectado como {name}"),
        ),
        CloudWaiting(n) => t(
            format!("{n} lap(s) waiting to be sent"),
            format!("{n} volta(s) esperando envio"),
            format!("{n} vuelta(s) esperando envío"),
        ),
        CloudRefused => t(
            s("Your account no longer accepts this computer"),
            s("Sua conta não aceita mais este computador"),
            s("Tu cuenta ya no acepta este ordenador"),
        ),
        MenuConnect => t(
            s("Connect to your account…"),
            s("Conectar à sua conta…"),
            s("Conectar a tu cuenta…"),
        ),
        MenuOpenLaps => t(
            s("Open the laps folder"),
            s("Abrir a pasta das voltas"),
            s("Abrir la carpeta de vueltas"),
        ),
        MenuPause => t(s("Pause recording"), s("Pausar a gravação"), s("Pausar la grabación")),
        MenuResume => t(s("Resume recording"), s("Retomar a gravação"), s("Reanudar la grabación")),
        MenuAutostart => t(s("Start with Windows"), s("Iniciar com o Windows"), s("Iniciar con Windows")),
        MenuQuit => t(s("Quit Xpeed Sim"), s("Sair do Xpeed Sim"), s("Salir de Xpeed Sim")),
        NoticeLapSaved(label) => t(
            format!("Lap saved: {label}"),
            format!("Volta gravada: {label}"),
            format!("Vuelta guardada: {label}"),
        ),
        NoticeLapsSent(n) => t(
            format!("{n} lap(s) sent to your account"),
            format!("{n} volta(s) enviada(s) à sua conta"),
            format!("{n} vuelta(s) enviada(s) a tu cuenta"),
        ),
        NoticePaired(name) => t(
            format!("Connected as {name}"),
            format!("Conectado como {name}"),
            format!("Conectado como {name}"),
        ),
        NoticeNotPaired => t(
            s("Right-click the icon and choose Connect to your account."),
            s("Clique com o botão direito no ícone e escolha Conectar à sua conta."),
            s("Haz clic derecho en el icono y elige Conectar a tu cuenta."),
        ),
        NoticeRefused => t(
            s("Connect again to send your laps. They are still saved here."),
            s("Conecte de novo para enviar suas voltas. Elas continuam salvas aqui."),
            s("Vuelve a conectar para enviar tus vueltas. Siguen guardadas aquí."),
        ),
        AskPairTitle => t(
            s("Connect this computer?"),
            s("Conectar este computador?"),
            s("¿Conectar este ordenador?"),
        ),
        AskPair(host) => t(
            format!(
                "Connect this computer to your Xpeed account at {host}?\n\nOnly say yes if you just asked for this in the Xpeed website."
            ),
            format!("Conectar este computador à sua conta Xpeed em {host}?\n\nSó diga sim se você acabou de pedir isso no site do Xpeed."),
            format!("¿Conectar este ordenador a tu cuenta Xpeed en {host}?\n\nDi que sí solo si acabas de pedirlo en el sitio de Xpeed."),
        ),
        PairFailedTitle => t(s("Could not connect"), s("Não foi possível conectar"), s("No se pudo conectar")),
        PairFailed(why) => t(why.clone(), why.clone(), why.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_language_of_windows() {
        assert_eq!(lang_from_id(0x16), Lang::Pt);
        assert_eq!(lang_from_id(0x0A), Lang::Es);
        assert_eq!(lang_from_id(0x09), Lang::En);
        assert_eq!(lang_from_id(0x00), Lang::En);
    }

    #[test]
    fn every_message_has_words_in_every_language() {
        let all = [
            Msg::GameWaiting,
            Msg::GameConnected,
            Msg::GameRecording(4),
            Msg::GamePaused,
            Msg::GameUnsupported,
            Msg::CloudNotPaired,
            Msg::CloudIdle("RIG".into()),
            Msg::CloudWaiting(2),
            Msg::CloudRefused,
            Msg::MenuConnect,
            Msg::MenuOpenLaps,
            Msg::MenuPause,
            Msg::MenuResume,
            Msg::MenuAutostart,
            Msg::MenuQuit,
            Msg::NoticeLapSaved("Lap 3".into()),
            Msg::NoticeLapsSent(2),
            Msg::NoticePaired("RIG".into()),
            Msg::NoticeNotPaired,
            Msg::NoticeRefused,
            Msg::AskPairTitle,
            Msg::AskPair("xpeed.skale.club".into()),
            Msg::PairFailedTitle,
            Msg::PairFailed("boom".into()),
        ];
        for msg in &all {
            for lang in [Lang::En, Lang::Pt, Lang::Es] {
                assert!(!text(lang, msg).trim().is_empty());
            }
        }
        // The question names the server, so a link cannot hide where it connects.
        for lang in [Lang::En, Lang::Pt, Lang::Es] {
            assert!(text(lang, &Msg::AskPair("xpeed.skale.club".into())).contains("xpeed.skale.club"));
        }
    }

    #[test]
    fn a_tooltip_fits_what_windows_allows() {
        // A tray tooltip holds 127 characters.
        let tip = [Msg::GameRecording(12), Msg::CloudWaiting(120)]
            .map(|m| text(Lang::Pt, &m))
            .join("\n");
        assert!(tip.chars().count() < 127);
    }
}
