//! The words the program shows (tray menu, balloons, questions), in the language of Windows.
//! The command line stays in English.

/// The program speaks English unless the person picks another language in the tray menu (owner decision,
/// 2026-11-12: English first; Portuguese and Spanish only when chosen).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lang {
    #[default]
    En,
    Pt,
    Es,
}

impl Lang {
    pub const ALL: [Lang; 3] = [Lang::En, Lang::Pt, Lang::Es];

    /// How it is kept in the settings file.
    pub fn code(self) -> &'static str {
        match self {
            Lang::En => "en",
            Lang::Pt => "pt",
            Lang::Es => "es",
        }
    }

    /// From the settings file; anything else is English.
    pub fn from_code(code: &str) -> Lang {
        match code.trim() {
            "pt" => Lang::Pt,
            "es" => Lang::Es,
            _ => Lang::En,
        }
    }

    /// The language's own name, the same in every menu.
    pub fn name(self) -> &'static str {
        match self {
            Lang::En => "English",
            Lang::Pt => "Português",
            Lang::Es => "Español",
        }
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
    MenuPanel,
    MenuLanguage,
    PanelTabDash,
    PanelTabMonitor,
    PanelOnTop,
    PanelFullScreen,
    PanelExitFullScreen,
    PanelWaitingTitle,
    PanelWaiting,
    PanelLapTime,
    PanelTrack,
    PanelOpenXpeed,
    PanelTyres,
    PanelLapProgress,
    PanelNotDriving,
    PanelLap(i32),
    PanelLastLap,
    PanelBestLap,
    PanelDelta,
    PanelFuel,
    PanelThrottle,
    PanelBrake,
    PanelClutch,
    PanelSteer,
    PanelPits,
    PanelGames,
    PanelAccount,
    PanelLaps,
    PanelActivity,
    PanelRecentLaps,
    PanelNoLapsYet,
    PanelFastest,
    PanelMapSoon,
    PanelNoTyres,
    /// The waiting screen when a game is open: `{name} is open` (no data yet) or `{name} connected`.
    FocusOpen(String),
    FocusConnected(String),
    FocusGetInCar,
    FocusPaused,
    FocusUnsupported,
    FocusAutoConnect,
    /// How to switch on the data of the game of this id.
    Setup(&'static str),
    StateSilent,
    GameSilent,
    PanelNoActivity,
    ActivityGameConnected(String),
    ActivityGameClosed(String),
    ActivityGameUnsupported(String),
    PanelNoLaps,
    PanelLapsCount(u32),
    PanelHint,
    StateWaiting,
    StateConnected,
    StateRecording(u32),
    StatePaused,
    StateUnsupported,
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
        MenuPanel => t(s("Open the panel"), s("Abrir o painel"), s("Abrir el panel")),
        MenuLanguage => t(s("Language"), s("Idioma"), s("Idioma")),
        PanelTabDash => t(s("Dashboard"), s("Painel"), s("Panel")),
        PanelTabMonitor => t(s("Monitor"), s("Monitor"), s("Monitor")),
        PanelOnTop => t(s("Always on top"), s("Sempre por cima"), s("Siempre encima")),
        PanelFullScreen => t(s("Full screen"), s("Tela cheia"), s("Pantalla completa")),
        PanelExitFullScreen => t(s("Exit full screen"), s("Sair da tela cheia"), s("Salir de pantalla completa")),
        PanelWaitingTitle => t(s("Waiting for a game"), s("Esperando um jogo"), s("Esperando un juego")),
        PanelWaiting => t(
            s("Start one of these games and get in the car."),
            s("Abra um destes jogos e entre no carro."),
            s("Abre uno de estos juegos y súbete al coche."),
        ),
        PanelLapTime => t(s("Lap time"), s("Tempo da volta"), s("Tiempo de vuelta")),
        PanelTrack => t(s("Track"), s("Pista"), s("Pista")),
        PanelOpenXpeed => t(s("Open Xpeed"), s("Abrir o Xpeed"), s("Abrir Xpeed")),
        PanelTyres => t(s("Tyres"), s("Pneus"), s("Neumáticos")),
        PanelLapProgress => t(s("Lap"), s("Volta"), s("Vuelta")),
        PanelNotDriving => t(
            s("In the menu or the garage"),
            s("No menu ou na garagem"),
            s("En el menú o el garaje"),
        ),
        PanelLap(n) => t(format!("Lap {n}"), format!("Volta {n}"), format!("Vuelta {n}")),
        PanelLastLap => t(s("Last"), s("Última"), s("Última")),
        PanelBestLap => t(s("Best"), s("Melhor"), s("Mejor")),
        PanelDelta => t(s("Delta to best"), s("Diferença p/ melhor"), s("Diferencia c/ mejor")),
        PanelFuel => t(s("Fuel"), s("Combustível"), s("Combustible")),
        PanelThrottle => t(s("Throttle"), s("Acelerador"), s("Acelerador")),
        PanelBrake => t(s("Brake"), s("Freio"), s("Freno")),
        PanelClutch => t(s("Clutch"), s("Embreagem"), s("Embrague")),
        PanelSteer => t(s("Wheel"), s("Volante"), s("Volante")),
        PanelPits => t(s("In the pits"), s("No pit"), s("En boxes")),
        PanelGames => t(s("Games"), s("Jogos"), s("Juegos")),
        PanelAccount => t(s("Account"), s("Conta"), s("Cuenta")),
        PanelLaps => t(s("Laps saved"), s("Voltas gravadas"), s("Vueltas guardadas")),
        PanelActivity => t(s("Activity"), s("Atividade"), s("Actividad")),
        PanelRecentLaps => t(s("Recent laps"), s("Últimas voltas"), s("Últimas vueltas")),
        PanelNoLapsYet => t(
            s("Your laps show here as you complete them."),
            s("Suas voltas aparecem aqui conforme você completa."),
            s("Tus vueltas aparecen aquí a medida que las completas."),
        ),
        PanelFastest => t(s("fastest"), s("mais rápida"), s("más rápida")),
        PanelMapSoon => t(
            s("The track draws itself as you drive."),
            s("A pista vai sendo desenhada enquanto você dirige."),
            s("La pista se dibuja mientras conduces."),
        ),
        PanelNoTyres => t(
            s("This game does not share tyre data."),
            s("Este jogo não compartilha dados dos pneus."),
            s("Este juego no comparte datos de los neumáticos."),
        ),
        FocusOpen(name) => t(format!("{name} is open"), format!("{name} está aberto"), format!("{name} está abierto")),
        FocusConnected(name) => t(format!("{name} connected"), format!("{name} conectado"), format!("{name} conectado")),
        FocusGetInCar => t(
            s("Get in the car: the dashboard starts on track."),
            s("Entre no carro: o painel começa na pista."),
            s("Súbete al coche: el panel empieza en la pista."),
        ),
        FocusPaused => t(
            s("Recording is paused (tray icon menu, Resume recording)."),
            s("A gravação está pausada (menu do ícone da bandeja, Retomar a gravação)."),
            s("La grabación está en pausa (menú del icono de la bandeja, Reanudar la grabación)."),
        ),
        FocusUnsupported => t(
            s("This version of the game cannot be read yet."),
            s("Esta versão do jogo ainda não pode ser lida."),
            s("Esta versión del juego aún no se puede leer."),
        ),
        FocusAutoConnect => t(
            s("Xpeed Sim connects by itself as soon as the data arrives."),
            s("O Xpeed Sim conecta sozinho assim que os dados chegarem."),
            s("Xpeed Sim se conecta solo en cuanto lleguen los datos."),
        ),
        Setup(id) => match *id {
            // Automobilista 2's own menu (seen in the game, 2026-11-12): System > Use Shared Memory, Yes or No.
            "ams2" => t(
                s("Switch the data on in the game: Options > System > Use Shared Memory > Yes, then Save."),
                s("Ligue os dados no jogo: Options > System > Use Shared Memory > Yes e depois Save."),
                s("Activa los datos en el juego: Options > System > Use Shared Memory > Yes y luego Save."),
            ),
            "pcars2" | "pcars3" => t(
                s("Switch the data on in the game's options: Shared Memory, in the Project CARS 2 format."),
                s("Ligue os dados nas opções do jogo: Shared Memory, no formato Project CARS 2."),
                s("Activa los datos en las opciones del juego: Shared Memory, en el formato Project CARS 2."),
            ),
            "f1" | "f124" | "f123" => t(
                s("Switch the data on in the game: Settings > Telemetry Settings > UDP Telemetry On, port 20777, format of the game's year."),
                s("Ligue os dados no jogo: Settings > Telemetry Settings > UDP Telemetry On, porta 20777, formato do ano do jogo."),
                s("Activa los datos en el juego: Settings > Telemetry Settings > UDP Telemetry On, puerto 20777, formato del año del juego."),
            ),
            "fm" | "fm7" | "fh4" | "fh5" => t(
                s("Switch the data on in the game: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, port 5301."),
                s("Ligue os dados no jogo: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, porta 5301."),
                s("Activa los datos en el juego: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, puerto 5301."),
            ),
            "wreckfest2" => t(
                s("Switch the data on in the game's telemetry config.json: set \"enabled\" to 1 (IP 127.0.0.1, port 23123), then restart the game."),
                s("Ligue os dados no config.json de telemetria do jogo: coloque \"enabled\" em 1 (IP 127.0.0.1, porta 23123) e abra o jogo de novo."),
                s("Activa los datos en el config.json de telemetría del juego: pon \"enabled\" en 1 (IP 127.0.0.1, puerto 23123) y vuelve a abrir el juego."),
            ),
            "lmu" => t(
                s("Switch the data on in the game: Settings > Gameplay > Enable external plugins."),
                s("Ligue os dados no jogo: Settings > Gameplay > Enable external plugins."),
                s("Activa los datos en el juego: Settings > Gameplay > Enable external plugins."),
            ),
            "rfactor1" | "ams1" | "rf1" => t(
                s("Put the rFactorSharedMemoryMap plugin in the game's Plugins folder, then start the game again."),
                s("Coloque o plugin rFactorSharedMemoryMap na pasta Plugins do jogo e abra o jogo de novo."),
                s("Pon el plugin rFactorSharedMemoryMap en la carpeta Plugins del juego y vuelve a abrirlo."),
            ),
            _ => t(
                s("The game shares its data once it has loaded: get on track."),
                s("O jogo compartilha os dados depois de carregar: vá para a pista."),
                s("El juego comparte sus datos cuando termina de cargar: sal a la pista."),
            ),
        },
        StateSilent => t(s("no data"), s("sem dados"), s("sin datos")),
        GameSilent => t(s("Open, no data yet"), s("Aberto, sem dados ainda"), s("Abierto, sin datos todavía")),
        PanelNoActivity => t(
            s("Nothing yet. Start a game and drive a lap."),
            s("Nada ainda. Abra um jogo e dê uma volta."),
            s("Nada todavía. Abre un juego y da una vuelta."),
        ),
        ActivityGameConnected(name) => t(
            format!("{name} connected"),
            format!("{name} conectado"),
            format!("{name} conectado"),
        ),
        ActivityGameClosed(name) => t(format!("{name} closed"), format!("{name} fechado"), format!("{name} cerrado")),
        ActivityGameUnsupported(name) => t(
            format!("{name}: this version cannot be read yet"),
            format!("{name}: esta versão ainda não pode ser lida"),
            format!("{name}: esta versión aún no se puede leer"),
        ),
        PanelNoLaps => t(
            s("No lap saved since Xpeed Sim started."),
            s("Nenhuma volta gravada desde que o Xpeed Sim abriu."),
            s("Ninguna vuelta guardada desde que se abrió Xpeed Sim."),
        ),
        PanelLapsCount(n) => t(
            format!("{n} lap(s) saved since Xpeed Sim started"),
            format!("{n} volta(s) gravada(s) desde que o Xpeed Sim abriu"),
            format!("{n} vuelta(s) guardada(s) desde que se abrió Xpeed Sim"),
        ),
        PanelHint => t(
            s("Keys: 1 dashboard · 2 monitor · F11 full screen · T always on top"),
            s("Teclas: 1 painel · 2 monitor · F11 tela cheia · T sempre por cima"),
            s("Teclas: 1 panel · 2 monitor · F11 pantalla completa · T siempre encima"),
        ),
        StateWaiting => t(s("waiting"), s("esperando"), s("esperando")),
        StateConnected => t(s("connected"), s("conectado"), s("conectado")),
        StateRecording(lap) => t(
            format!("recording lap {lap}"),
            format!("gravando a volta {lap}"),
            format!("grabando la vuelta {lap}"),
        ),
        StatePaused => t(s("paused"), s("pausado"), s("en pausa")),
        StateUnsupported => t(s("version not supported"), s("versão não suportada"), s("versión no compatible")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaks_english_unless_another_language_was_picked() {
        assert_eq!(Lang::default(), Lang::En);
        for lang in Lang::ALL {
            assert_eq!(Lang::from_code(lang.code()), lang);
        }
        assert_eq!(Lang::from_code(" pt\n"), Lang::Pt);
        assert_eq!(Lang::from_code("fr"), Lang::En);
        assert_eq!(Lang::from_code(""), Lang::En);
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
            Msg::MenuPanel,
            Msg::MenuLanguage,
            Msg::PanelTabDash,
            Msg::PanelTabMonitor,
            Msg::PanelOnTop,
            Msg::PanelFullScreen,
            Msg::PanelExitFullScreen,
            Msg::PanelWaitingTitle,
            Msg::PanelWaiting,
            Msg::PanelLapTime,
            Msg::PanelTrack,
            Msg::PanelOpenXpeed,
            Msg::PanelTyres,
            Msg::PanelLapProgress,
            Msg::PanelNotDriving,
            Msg::PanelLap(3),
            Msg::PanelLastLap,
            Msg::PanelBestLap,
            Msg::PanelDelta,
            Msg::PanelFuel,
            Msg::PanelThrottle,
            Msg::PanelBrake,
            Msg::PanelClutch,
            Msg::PanelSteer,
            Msg::PanelPits,
            Msg::PanelGames,
            Msg::PanelAccount,
            Msg::PanelLaps,
            Msg::PanelActivity,
            Msg::PanelRecentLaps,
            Msg::PanelNoLapsYet,
            Msg::PanelFastest,
            Msg::PanelMapSoon,
            Msg::PanelNoTyres,
            Msg::FocusOpen("Automobilista 2".into()),
            Msg::FocusConnected("Automobilista 2".into()),
            Msg::FocusGetInCar,
            Msg::FocusPaused,
            Msg::FocusUnsupported,
            Msg::FocusAutoConnect,
            Msg::Setup("ams2"),
            Msg::Setup("f1"),
            Msg::Setup("fm"),
            Msg::Setup("wreckfest2"),
            Msg::Setup("lmu"),
            Msg::Setup("rfactor1"),
            Msg::Setup("ac"),
            Msg::StateSilent,
            Msg::GameSilent,
            Msg::PanelNoActivity,
            Msg::ActivityGameConnected("Assetto Corsa".into()),
            Msg::ActivityGameClosed("Assetto Corsa".into()),
            Msg::ActivityGameUnsupported("Stock Car Extreme".into()),
            Msg::PanelNoLaps,
            Msg::PanelLapsCount(2),
            Msg::PanelHint,
            Msg::StateWaiting,
            Msg::StateConnected,
            Msg::StateRecording(2),
            Msg::StatePaused,
            Msg::StateUnsupported,
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
