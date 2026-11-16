//! The words the program shows (tray menu, balloons, questions), in the language of Windows.
//! The command line stays in English.

use crate::status::SavedLap;

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
    ConnectWaiting,
    ConnectWaitingHint,
    ConnectOpenAgain,
    ConnectCancel,
    ConnectedAs(String),
    /// Connected, with the account not known yet.
    ConnectedPlain,
    ConnectNoteCancelled,
    ConnectNoteExpired,
    /// The key saved on this computer cannot be opened by this Windows user: connect again.
    ConnectNoteReconnect,
    /// Under the waiting headline: the code the connection page shows, to compare.
    ConnectCodeHint(String),
    /// The Monitor tab's button that copies the support text.
    DiagnosticsCopy,
    DiagnosticsCopied,
    /// A background part (named in English) hit an error and starts again / was given up on.
    ActivityWorkerRestarting(String),
    ActivityWorkerFailed(String),
    /// The parts (named in English, joined) that stopped for good.
    WorkersFailed(String),
    MenuOpenLaps,
    MenuPause,
    MenuResume,
    MenuAutostart,
    MenuQuit,
    NoticeLapSaved(SavedLap),

    /// A lap could not be written to the laps folder (short reason); Xpeed Companion tries again.
    NoticeLapNotSaved(String),
    NoticeLapsSent(u32),
    NoticePaired(String),
    NoticeNotPaired,
    NoticeRefused,
    MenuPanel,
    MenuLanguage,
    MenuCheckUpdates,
    MenuAutoUpdate,
    /// The button that installs the new version, and the card it is on.
    UpdateNow,
    PanelUpdate,
    /// The new version, as the person is told of it (the number already written).
    UpdateAvailable(String),
    UpdateRequired(String),
    UpdateDownloading,
    /// The update waits for the games to close.
    UpdateHeld(String),
    NoticeUpdated(String),
    NoticeUpdateBlocked(String),
    NoticeUpToDate(String),
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
    PanelNotDriving,
    /// The dashboard has had no frames for a while but the game is still connected.
    PanelNoGameData,
    /// The game is paused.
    PanelPaused,
    PanelLap(i32),
    PanelLastLap,
    PanelBestLap,
    PanelFuel,
    PanelThrottle,
    PanelBrake,
    PanelClutch,
    PanelPits,
    PanelGames,
    PanelAccount,
    PanelLaps,
    PanelActivity,
    PanelRecentLaps,
    PanelNoLapsYet,
    PanelInvalid,
    PanelWater,
    PanelOil,
    PanelBias,
    PanelDmgBody,
    PanelDmgEngine,
    PanelDmgGearbox,
    PanelDmgSusp,
    /// The units menu: its title, and the name of each kind of value in it.
    MenuUnits,
    MenuUnitSpeed,
    MenuUnitTemperature,
    MenuUnitPressure,
    MenuUnitFuel,
    PanelAlerts,
    PanelNoAlerts,
    PanelEngine,
    /// The word after the laps of fuel left (`9.4 laps`).
    PanelLapsWord,
    /// Beside the litres: `of 60 L`, the tank's size already written with its unit.
    PanelOfTank(String),
    /// Under the tank bar: `2.6 L per lap, each tick = 1 lap`, the use per lap already written with its unit.
    PanelFuelPerLapTick(String),
    /// Under the tank bar when it has no ticks: `2.6 L per lap`.
    PanelFuelPerLapPlain(String),
    /// On the first lap, where the delta will be.
    PanelDeltaFirstLap,
    PanelVsBest,
    PanelSessionPractice,
    PanelSessionQualifying,
    PanelSessionRace,
    PanelFlagGreen,
    PanelFlagYellow,
    PanelFlagBlue,
    PanelFlagWhite,
    PanelFlagBlack,
    PanelFlagChequered,
    /// The words of the alerts that are lit.
    AlertAbs,
    AlertTc,
    AlertDrsAvailable,
    AlertDrsOpen,
    AlertPit,
    AlertEngine,
    AlertFuel,
    AlertHandbrake,
    AlertHeadlights,
    /// The short name of a tyre's corner: 0 front left, 1 front right, 2 rear left, 3 rear right.
    PanelTyreCorner(u8),
    PanelTyreCold,
    PanelTyreOk,
    PanelTyreHot,
    PanelTyreOver,
    /// The laps table's column heads.
    PanelColLap,
    PanelColTime,
    PanelColGap,
    /// Under the track map: `64% of the lap`, the number already written.
    PanelPercentOfLap(String),
    PanelDamageNone,
    /// `Damage: Body 12%, Susp 40%`, the parts already written.
    PanelDamage(String),
    /// A pedal's name when the full one does not fit over its bar.
    PanelThrottleShort,
    PanelBrakeShort,
    PanelClutchShort,
    /// The waiting screen when a game is open: `{name} is open` (no data yet) or `{name} connected`.
    FocusOpen(String),
    FocusConnected(String),
    FocusGetInCar,
    FocusPaused,
    FocusUnsupported,
    FocusAutoConnect,
    /// The open-game screen's line while the game is still loading.
    FocusLoading,
    /// How to switch on the data of the game of this id.
    Setup(&'static str),
    /// The balloon for a game open without data: its id and name, then what to switch on.
    NoticeNeedsSetup(&'static str, &'static str),
    StateSilent,
    GameSilent,
    StateLoading,
    GameLoading,
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

/// The name of the game of this id as the person knows it (`Assetto Corsa`), for the lines that name it.
fn game_title(id: &str) -> &'static str {
    crate::games::PROGRAMS
        .iter()
        .find(|(_, game, _)| *game == id)
        .map_or("The game", |(_, _, name)| *name)
}

/// A saved lap as one line in the person's language: `Lap 3  1:42.318`, and after the time the word for a lap that did
/// not count (`Volta 3  1:42.318 (inválida)`).
pub fn lap_label(lang: Lang, lap: &SavedLap) -> String {
    let (word, invalid) = match lang {
        Lang::En => ("Lap", " (not valid)"),
        Lang::Pt => ("Volta", " (inválida)"),
        Lang::Es => ("Vuelta", " (no válida)"),
    };
    format!(
        "{word} {}  {}{}",
        lap.number,
        crate::util::clock(lap.time_ms),
        if lap.valid { "" } else { invalid }
    )
}

/// What the panel says once it gave up drawing (the recording goes on). A constant table, not a `Msg`: the failure screen
/// runs when the rest of the panel could not be trusted, so it looks nothing up and builds nothing.
pub const fn draw_failed(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Something went wrong drawing the panel. Recording continues.",
        Lang::Pt => "Algo deu errado ao desenhar o painel. A gravação continua.",
        Lang::Es => "Algo salió mal al dibujar el panel. La grabación continúa.",
    }
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
        ConnectWaiting => t(
            s("Confirm in your browser"),
            s("Confirme no navegador"),
            s("Confirma en el navegador"),
        ),
        ConnectWaitingHint => t(
            s("Click Connect on the page that opened. Waiting…"),
            s("Clique em Conectar na página que abriu. Aguardando…"),
            s("Haz clic en Conectar en la página que se abrió. Esperando…"),
        ),
        ConnectOpenAgain => t(s("Open the page again"), s("Abrir a página de novo"), s("Abrir la página otra vez")),
        ConnectCancel => t(s("Cancel"), s("Cancelar"), s("Cancelar")),
        ConnectedPlain => t(s("Connected"), s("Conectado"), s("Conectado")),
        ConnectedAs(who) => t(
            format!("Connected as {who}"),
            format!("Conectado como {who}"),
            format!("Conectado como {who}"),
        ),
        ConnectNoteCancelled => t(
            s("The request was cancelled."),
            s("O pedido foi cancelado."),
            s("La solicitud fue cancelada."),
        ),
        ConnectNoteExpired => t(
            s("Took too long. Click Connect again."),
            s("Demorou demais. Clique em Conectar de novo."),
            s("Tardó demasiado. Haz clic en Conectar otra vez."),
        ),
        ConnectNoteReconnect => t(
            s("Reconnect this computer."),
            s("Reconecte este computador."),
            s("Vuelve a conectar este ordenador."),
        ),
        ConnectCodeHint(code) => t(
            format!("The page should show the code {code}"),
            format!("A página deve mostrar o código {code}"),
            format!("La página debe mostrar el código {code}"),
        ),
        DiagnosticsCopy => t(s("Copy diagnostics"), s("Copiar diagnóstico"), s("Copiar diagnóstico")),
        DiagnosticsCopied => t(s("Copied"), s("Copiado"), s("Copiado")),
        ActivityWorkerRestarting(name) => t(
            format!("A background part ({name}) hit an error and is starting again"),
            format!("Uma parte em segundo plano ({name}) deu erro e está reiniciando"),
            format!("Una parte en segundo plano ({name}) tuvo un error y se reinicia"),
        ),
        ActivityWorkerFailed(name) => t(
            format!("A background part ({name}) stopped after repeated errors"),
            format!("Uma parte em segundo plano ({name}) parou após erros repetidos"),
            format!("Una parte en segundo plano ({name}) se detuvo tras errores repetidos"),
        ),
        WorkersFailed(names) => t(
            format!("Stopped after errors: {names}. Restart Xpeed Companion."),
            format!("Parou após erros: {names}. Reinicie o Xpeed Companion."),
            format!("Se detuvo tras errores: {names}. Reinicia Xpeed Companion."),
        ),
        MenuOpenLaps => t(
            s("Open the laps folder"),
            s("Abrir a pasta das voltas"),
            s("Abrir la carpeta de vueltas"),
        ),
        MenuPause => t(s("Pause recording"), s("Pausar a gravação"), s("Pausar la grabación")),
        MenuResume => t(s("Resume recording"), s("Retomar a gravação"), s("Reanudar la grabación")),
        MenuAutostart => t(s("Start with Windows"), s("Iniciar com o Windows"), s("Iniciar con Windows")),
        MenuQuit => t(s("Quit Xpeed Companion"), s("Sair do Xpeed Companion"), s("Salir de Xpeed Companion")),
        NoticeLapSaved(lap) => t(
            format!("Lap saved: {}", lap_label(Lang::En, lap)),
            format!("Volta gravada: {}", lap_label(Lang::Pt, lap)),
            format!("Vuelta guardada: {}", lap_label(Lang::Es, lap)),
        ),

        NoticeLapNotSaved(reason) => t(
            format!("A lap could not be saved: {reason}. Xpeed Companion will try again."),
            format!("Uma volta não pôde ser gravada: {reason}. O Xpeed Companion vai tentar de novo."),
            format!("No se pudo guardar una vuelta: {reason}. Xpeed Companion lo intentará de nuevo."),
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
        MenuPanel => t(s("Open the panel"), s("Abrir o painel"), s("Abrir el panel")),
        MenuLanguage => t(s("Language"), s("Idioma"), s("Idioma")),
        MenuCheckUpdates => t(
            s("Check for updates"),
            s("Verificar atualizações"),
            s("Buscar actualizaciones"),
        ),
        MenuAutoUpdate => t(
            s("Update automatically"),
            s("Atualizar automaticamente"),
            s("Actualizar automáticamente"),
        ),
        UpdateNow => t(s("Update now"), s("Atualizar agora"), s("Actualizar ahora")),
        PanelUpdate => t(s("Update"), s("Atualização"), s("Actualización")),
        UpdateAvailable(version) => t(
            format!("Update available: {version}"),
            format!("Atualização disponível: {version}"),
            format!("Actualización disponible: {version}"),
        ),
        UpdateRequired(version) => t(
            format!("Update required: {version}"),
            format!("Atualização necessária: {version}"),
            format!("Actualización necesaria: {version}"),
        ),
        UpdateDownloading => t(
            s("Downloading the update…"),
            s("Baixando a atualização…"),
            s("Descargando la actualización…"),
        ),
        UpdateHeld(version) => t(
            format!("Update {version} installs when no game is running"),
            format!("A atualização {version} é instalada quando nenhum jogo estiver aberto"),
            format!("La actualización {version} se instala cuando no haya ningún juego abierto"),
        ),
        NoticeUpdated(version) => t(
            format!("Xpeed Companion was updated to {version}"),
            format!("O Xpeed Companion foi atualizado para {version}"),
            format!("Xpeed Companion se actualizó a {version}"),
        ),
        NoticeUpdateBlocked(version) => t(
            format!("Close your game to update to {version}. Nothing is lost."),
            format!("Feche o jogo para atualizar para {version}. Nada é perdido."),
            format!("Cierra el juego para actualizar a {version}. No se pierde nada."),
        ),
        NoticeUpToDate(version) => t(
            format!("Xpeed Companion is up to date ({version})"),
            format!("O Xpeed Companion está atualizado ({version})"),
            format!("Xpeed Companion está al día ({version})"),
        ),
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
        PanelNotDriving => t(
            s("In the menu or the garage"),
            s("No menu ou na garagem"),
            s("En el menú o el garaje"),
        ),
        PanelLap(n) => t(format!("Lap {n}"), format!("Volta {n}"), format!("Vuelta {n}")),
        PanelLastLap => t(s("Last"), s("Última"), s("Última")),
        PanelBestLap => t(s("Best"), s("Melhor"), s("Mejor")),
        PanelFuel => t(s("Fuel"), s("Combustível"), s("Combustible")),
        PanelThrottle => t(s("Throttle"), s("Acelerador"), s("Acelerador")),
        PanelBrake => t(s("Brake"), s("Freio"), s("Freno")),
        PanelClutch => t(s("Clutch"), s("Embreagem"), s("Embrague")),
        PanelNoGameData => t(
            s("No data from the game"),
            s("Sem dados do jogo"),
            s("Sin datos del juego"),
        ),
        PanelPaused => t(s("Paused"), s("Pausado"), s("En pausa")),
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
        PanelInvalid => t(s("invalid"), s("inválida"), s("inválida")),
        PanelWater => t(s("Water"), s("Água"), s("Agua")),
        PanelOil => t(s("Oil"), s("Óleo"), s("Aceite")),
        PanelBias => t(s("Bias"), s("Balanço"), s("Balance")),
        PanelDmgBody => t(s("Body"), s("Carr"), s("Carr")),
        PanelDmgEngine => t(s("Eng"), s("Mot"), s("Mot")),
        PanelDmgGearbox => t(s("Gbx"), s("Câmb"), s("Caja")),
        PanelDmgSusp => t(s("Susp"), s("Susp"), s("Susp")),
        MenuUnits => t(s("Units"), s("Unidades"), s("Unidades")),
        MenuUnitSpeed => t(s("Speed"), s("Velocidade"), s("Velocidad")),
        MenuUnitTemperature => t(s("Temperature"), s("Temperatura"), s("Temperatura")),
        MenuUnitPressure => t(s("Pressure"), s("Pressão"), s("Presión")),
        MenuUnitFuel => t(s("Fuel"), s("Combustível"), s("Combustible")),
        PanelAlerts => t(s("Alerts"), s("Avisos"), s("Avisos")),
        PanelNoAlerts => t(s("No alerts"), s("Sem avisos"), s("Sin avisos")),
        PanelEngine => t(s("Engine"), s("Motor"), s("Motor")),
        PanelLapsWord => t(s("laps"), s("voltas"), s("vueltas")),
        PanelOfTank(n) => t(format!("of {n}"), format!("de {n}"), format!("de {n}")),
        PanelFuelPerLapTick(n) => t(
            format!("{n} per lap \u{b7} each tick = 1 lap"),
            format!("{n} por volta \u{b7} cada risco = 1 volta"),
            format!("{n} por vuelta \u{b7} cada marca = 1 vuelta"),
        ),
        PanelFuelPerLapPlain(n) => t(format!("{n} per lap"), format!("{n} por volta"), format!("{n} por vuelta")),
        PanelDeltaFirstLap => t(
            s("The delta shows after your first full lap."),
            s("A diferença aparece depois da primeira volta completa."),
            s("La diferencia aparece tras la primera vuelta completa."),
        ),
        PanelVsBest => t(s("vs best"), s("vs melhor"), s("vs mejor")),
        PanelSessionPractice => t(s("Practice"), s("Treino"), s("Práctica")),
        PanelSessionQualifying => t(s("Qualifying"), s("Classificação"), s("Clasificación")),
        PanelSessionRace => t(s("Race"), s("Corrida"), s("Carrera")),
        PanelFlagGreen => t(s("Green flag"), s("Bandeira verde"), s("Bandera verde")),
        PanelFlagYellow => t(s("Yellow flag"), s("Bandeira amarela"), s("Bandera amarilla")),
        PanelFlagBlue => t(s("Blue flag"), s("Bandeira azul"), s("Bandera azul")),
        PanelFlagWhite => t(s("White flag"), s("Bandeira branca"), s("Bandera blanca")),
        PanelFlagBlack => t(s("Black flag"), s("Bandeira preta"), s("Bandera negra")),
        PanelFlagChequered => t(s("Chequered flag"), s("Bandeira quadriculada"), s("Bandera a cuadros")),
        AlertAbs => t(s("ABS active"), s("ABS atuando"), s("ABS actuando")),
        AlertTc => t(s("TC active"), s("TC atuando"), s("TC actuando")),
        AlertDrsAvailable => t(s("DRS available"), s("DRS liberado"), s("DRS disponible")),
        AlertDrsOpen => t(s("DRS open"), s("DRS aberto"), s("DRS abierto")),
        AlertPit => t(s("Pit limiter"), s("Limitador do pit"), s("Limitador de boxes")),
        AlertEngine => t(s("Engine"), s("Motor"), s("Motor")),
        AlertFuel => t(s("Fuel low"), s("Pouco combustível"), s("Poco combustible")),
        AlertHandbrake => t(s("Handbrake"), s("Freio de mão"), s("Freno de mano")),
        AlertHeadlights => t(s("Headlights"), s("Faróis"), s("Faros")),
        PanelTyreCorner(i) => match (lang, i) {
            (Lang::En, 0) => s("FL"),
            (Lang::En, 1) => s("FR"),
            (Lang::En, 2) => s("RL"),
            (Lang::En, _) => s("RR"),
            (Lang::Pt, 0) => s("DE"),
            (Lang::Pt, 1) => s("DD"),
            (Lang::Pt, 2) => s("TE"),
            (Lang::Pt, _) => s("TD"),
            (Lang::Es, 0) => s("DI"),
            (Lang::Es, 1) => s("DD"),
            (Lang::Es, 2) => s("TI"),
            (Lang::Es, _) => s("TD"),
        },
        PanelTyreCold => t(s("cold"), s("frio"), s("frío")),
        PanelTyreOk => t(s("ok"), s("ok"), s("ok")),
        PanelTyreHot => t(s("hot"), s("quente"), s("caliente")),
        PanelTyreOver => t(s("over"), s("passou"), s("excedido")),
        PanelColLap => t(s("Lap"), s("Volta"), s("Vuelta")),
        PanelColTime => t(s("Time"), s("Tempo"), s("Tiempo")),
        PanelColGap => t(s("Gap"), s("Dif."), s("Dif.")),
        PanelPercentOfLap(n) => t(format!("{n} of the lap"), format!("{n} da volta"), format!("{n} de la vuelta")),
        PanelDamageNone => t(s("Damage: none"), s("Avarias: nenhuma"), s("Daños: ninguno")),
        PanelDamage(parts) => t(format!("Damage: {parts}"), format!("Avarias: {parts}"), format!("Daños: {parts}")),
        PanelThrottleShort => t(s("Thr"), s("Acel"), s("Acel")),
        PanelBrakeShort => t(s("Brk"), s("Freio"), s("Freno")),
        PanelClutchShort => t(s("Clu"), s("Emb"), s("Embr")),
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
            s("Xpeed Companion connects by itself as soon as the data arrives."),
            s("O Xpeed Companion conecta sozinho assim que os dados chegarem."),
            s("Xpeed Companion se conecta solo en cuanto lleguen los datos."),
        ),
        FocusLoading => t(
            s("Loading… Xpeed Companion connects as soon as the game is ready."),
            s("Carregando… o Xpeed Companion conecta assim que o jogo estiver pronto."),
            s("Cargando… Xpeed Companion se conecta en cuanto el juego esté listo."),
        ),
        // What to switch on in a game that is open and shares no data. Menu names stay in English (the games' own wording);
        // the words around them are the person's language. Games with nothing to switch on say what starts the data.
        // Where a menu path could not be checked in the game itself, the line says only what is certain (see `watch.rs` tests
        // and the README of the Companion for the list).
        Setup(id) => match *id {
            // Automobilista 2's own menu (seen in the game, 2026-11-12): System > Use Shared Memory, Yes or No. Builds that list
            // formats instead call the option Shared Memory and offer "Project CARS 2".
            "ams2" => t(
                s("Turn the game's data sharing on: Options > System > Use Shared Memory > Yes (if it lists formats, pick Project CARS 2), then Save."),
                s("Ligue o compartilhamento de dados do jogo: Options > System > Use Shared Memory > Yes (se pedir um formato, escolha Project CARS 2) e depois Save."),
                s("Activa el uso compartido de datos del juego: Options > System > Use Shared Memory > Yes (si pide un formato, elige Project CARS 2) y luego Save."),
            ),
            "pcars2" | "pcars3" => t(
                s("Turn the game's data sharing on in its options: Shared Memory, in the Project CARS 2 format."),
                s("Ligue o compartilhamento de dados nas opções do jogo: Shared Memory, no formato Project CARS 2."),
                s("Activa el uso compartido de datos en las opciones del juego: Shared Memory, en el formato Project CARS 2."),
            ),
            "ac" | "acc" | "acr" | "acevo" => {
                let game = game_title(id);
                t(
                    format!("{game} shares its data by itself: start a session and get on track."),
                    format!("O {game} compartilha os dados sozinho: comece uma sessão e vá para a pista."),
                    format!("{game} comparte los datos solo: empieza una sesión y sal a la pista."),
                )
            }
            "iracing" => t(
                s("iRacing shares its data by itself while you are in the car: start a session and get on track."),
                s("O iRacing compartilha os dados sozinho enquanto você está no carro: comece uma sessão e vá para a pista."),
                s("iRacing comparte los datos solo mientras estás en el coche: empieza una sesión y sal a la pista."),
            ),
            "r3e" => t(
                s("RaceRoom shares its data by itself: start a session and get on track."),
                s("O RaceRoom compartilha os dados sozinho: comece uma sessão e vá para a pista."),
                s("RaceRoom comparte los datos solo: empieza una sesión y sal a la pista."),
            ),
            "f1" => t(
                s("In the game: Settings > Telemetry Settings > UDP Telemetry On, Broadcast Mode Off, IP 127.0.0.1, Port 20777, UDP Format 2025 (or 2026 with the Season Pack)."),
                s("No jogo: Settings > Telemetry Settings > UDP Telemetry On, Broadcast Mode Off, IP 127.0.0.1, Port 20777, UDP Format 2025 (ou 2026, com o Season Pack)."),
                s("En el juego: Settings > Telemetry Settings > UDP Telemetry On, Broadcast Mode Off, IP 127.0.0.1, Port 20777, UDP Format 2025 (o 2026, con el Season Pack)."),
            ),
            "f124" | "f123" => {
                let year = if *id == "f124" { 2024 } else { 2023 };
                t(
                    format!("In the game: Settings > Telemetry Settings > UDP Telemetry On, Broadcast Mode Off, IP 127.0.0.1, Port 20777, UDP Format {year}."),
                    format!("No jogo: Settings > Telemetry Settings > UDP Telemetry On, Broadcast Mode Off, IP 127.0.0.1, Port 20777, UDP Format {year}."),
                    format!("En el juego: Settings > Telemetry Settings > UDP Telemetry On, Broadcast Mode Off, IP 127.0.0.1, Port 20777, UDP Format {year}."),
                )
            }
            "fm" => t(
                s("In the game: Settings > Gameplay & HUD > UDP Race Telemetry > Data Out On, IP 127.0.0.1, Port 5301, Packet Format Dash."),
                s("No jogo: Settings > Gameplay & HUD > UDP Race Telemetry > Data Out On, IP 127.0.0.1, Port 5301, Packet Format Dash."),
                s("En el juego: Settings > Gameplay & HUD > UDP Race Telemetry > Data Out On, IP 127.0.0.1, Port 5301, Packet Format Dash."),
            ),
            "fm7" => t(
                s("In the game: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, Port 5301, Format Dash."),
                s("No jogo: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, Port 5301, Format Dash."),
                s("En el juego: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, Port 5301, Format Dash."),
            ),
            "fh4" | "fh5" | "fh6" => t(
                s("In the game: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, Port 5301."),
                s("No jogo: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, Port 5301."),
                s("En el juego: Settings > HUD and Gameplay > Data Out On, IP 127.0.0.1, Port 5301."),
            ),
            "wreckfest2" => t(
                s("Switch the data on in the game's telemetry config.json: set \"enabled\" to 1 (IP 127.0.0.1, port 23123), then restart the game."),
                s("Ligue os dados no config.json de telemetria do jogo: coloque \"enabled\" em 1 (IP 127.0.0.1, porta 23123) e abra o jogo de novo."),
                s("Activa los datos en el config.json de telemetría del juego: pon \"enabled\" en 1 (IP 127.0.0.1, puerto 23123) y vuelve a abrir el juego."),
            ),
            "lmu" => t(
                s("Turn the game's plugins on: Settings > Gameplay > Enable external plugins. If nothing changes, restart the game."),
                s("Ligue os plugins do jogo: Settings > Gameplay > Enable external plugins. Se nada mudar, abra o jogo de novo."),
                s("Activa los plugins del juego: Settings > Gameplay > Enable external plugins. Si no cambia nada, vuelve a abrir el juego."),
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
        NoticeNeedsSetup(id, name) => {
            let how = text(lang, &Setup(id));
            t(
                format!("{name} is open but not sharing data yet. {how}"),
                format!("{name} está aberto, mas ainda não compartilha dados. {how}"),
                format!("{name} está abierto, pero aún no comparte datos. {how}"),
            )
        }
        StateSilent => t(s("no data"), s("sem dados"), s("sin datos")),
        StateLoading => t(s("loading"), s("carregando"), s("cargando")),
        GameLoading => t(s("Open, loading"), s("Aberto, carregando"), s("Abierto, cargando")),
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
            s("No lap saved since Xpeed Companion started."),
            s("Nenhuma volta gravada desde que o Xpeed Companion abriu."),
            s("Ninguna vuelta guardada desde que se abrió Xpeed Companion."),
        ),
        PanelLapsCount(n) => t(
            format!("{n} lap(s) saved since Xpeed Companion started"),
            format!("{n} volta(s) gravada(s) desde que o Xpeed Companion abriu"),
            format!("{n} vuelta(s) guardada(s) desde que se abrió Xpeed Companion"),
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
            Msg::ConnectWaiting,
            Msg::ConnectWaitingHint,
            Msg::ConnectOpenAgain,
            Msg::ConnectCancel,
            Msg::ConnectedAs("ana@example.com".into()),
            Msg::ConnectedPlain,
            Msg::ConnectNoteCancelled,
            Msg::ConnectNoteExpired,
            Msg::MenuOpenLaps,
            Msg::MenuPause,
            Msg::MenuResume,
            Msg::MenuAutostart,
            Msg::MenuQuit,
            Msg::NoticeLapSaved(crate::status::saved_lap(3, 102_318)),
            Msg::NoticeLapNotSaved("disk full".into()),
            Msg::NoticeLapsSent(2),
            Msg::NoticePaired("RIG".into()),
            Msg::NoticeNotPaired,
            Msg::NoticeRefused,
            Msg::ConnectNoteReconnect,
            Msg::ConnectCodeHint("K7QX".into()),
            Msg::DiagnosticsCopy,
            Msg::DiagnosticsCopied,
            Msg::ActivityWorkerRestarting("uploader".into()),
            Msg::ActivityWorkerFailed("uploader".into()),
            Msg::WorkersFailed("uploader".into()),
            Msg::MenuPanel,
            Msg::MenuLanguage,
            Msg::MenuCheckUpdates,
            Msg::MenuAutoUpdate,
            Msg::UpdateNow,
            Msg::PanelUpdate,
            Msg::UpdateAvailable("0.6.0".into()),
            Msg::UpdateRequired("0.6.0".into()),
            Msg::UpdateDownloading,
            Msg::UpdateHeld("0.6.0".into()),
            Msg::NoticeUpdated("0.6.0".into()),
            Msg::NoticeUpdateBlocked("0.6.0".into()),
            Msg::NoticeUpToDate("0.6.0".into()),
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
            Msg::PanelNotDriving,
            Msg::PanelNoGameData,
            Msg::PanelPaused,
            Msg::PanelLap(3),
            Msg::PanelLastLap,
            Msg::PanelBestLap,
            Msg::PanelFuel,
            Msg::PanelThrottle,
            Msg::PanelBrake,
            Msg::PanelClutch,
            Msg::PanelPits,
            Msg::PanelGames,
            Msg::PanelAccount,
            Msg::PanelLaps,
            Msg::PanelActivity,
            Msg::PanelRecentLaps,
            Msg::PanelNoLapsYet,
            Msg::PanelInvalid,
            Msg::PanelWater,
            Msg::PanelOil,
            Msg::PanelBias,
            Msg::PanelDmgBody,
            Msg::PanelDmgEngine,
            Msg::PanelDmgGearbox,
            Msg::PanelDmgSusp,
            Msg::MenuUnits,
            Msg::MenuUnitSpeed,
            Msg::MenuUnitTemperature,
            Msg::MenuUnitPressure,
            Msg::MenuUnitFuel,
            Msg::PanelAlerts,
            Msg::PanelNoAlerts,
            Msg::PanelEngine,
            Msg::PanelLapsWord,
            Msg::PanelOfTank("60 L".into()),
            Msg::PanelFuelPerLapTick("2.6 L".into()),
            Msg::PanelFuelPerLapPlain("2.6 L".into()),
            Msg::PanelDeltaFirstLap,
            Msg::PanelVsBest,
            Msg::PanelSessionPractice,
            Msg::PanelSessionQualifying,
            Msg::PanelSessionRace,
            Msg::PanelFlagGreen,
            Msg::PanelFlagYellow,
            Msg::PanelFlagBlue,
            Msg::PanelFlagWhite,
            Msg::PanelFlagBlack,
            Msg::PanelFlagChequered,
            Msg::AlertAbs,
            Msg::AlertTc,
            Msg::AlertDrsAvailable,
            Msg::AlertDrsOpen,
            Msg::AlertPit,
            Msg::AlertEngine,
            Msg::AlertFuel,
            Msg::AlertHandbrake,
            Msg::AlertHeadlights,
            Msg::PanelTyreCorner(0),
            Msg::PanelTyreCorner(1),
            Msg::PanelTyreCorner(2),
            Msg::PanelTyreCorner(3),
            Msg::PanelTyreCold,
            Msg::PanelTyreOk,
            Msg::PanelTyreHot,
            Msg::PanelTyreOver,
            Msg::PanelColLap,
            Msg::PanelColTime,
            Msg::PanelColGap,
            Msg::PanelPercentOfLap("64%".into()),
            Msg::PanelDamageNone,
            Msg::PanelDamage("Body 12%".into()),
            Msg::PanelThrottleShort,
            Msg::PanelBrakeShort,
            Msg::PanelClutchShort,
            Msg::FocusOpen("Automobilista 2".into()),
            Msg::FocusConnected("Automobilista 2".into()),
            Msg::FocusGetInCar,
            Msg::FocusPaused,
            Msg::FocusUnsupported,
            Msg::FocusAutoConnect,
            Msg::FocusLoading,
            Msg::Setup("ams2"),
            Msg::Setup("f1"),
            Msg::Setup("fm"),
            Msg::Setup("wreckfest2"),
            Msg::Setup("lmu"),
            Msg::Setup("rfactor1"),
            Msg::Setup("ac"),
            Msg::NoticeNeedsSetup("ams2", "Automobilista 2"),
            Msg::StateSilent,
            Msg::GameSilent,
            Msg::StateLoading,
            Msg::GameLoading,
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
        // The update lines name the version.
        for lang in [Lang::En, Lang::Pt, Lang::Es] {
            for msg in [
                Msg::UpdateAvailable("0.6.0".into()),
                Msg::UpdateRequired("0.6.0".into()),
                Msg::UpdateHeld("0.6.0".into()),
                Msg::NoticeUpdated("0.6.0".into()),
                Msg::NoticeUpdateBlocked("0.6.0".into()),
                Msg::NoticeUpToDate("0.6.0".into()),
            ] {
                assert!(text(lang, &msg).contains("0.6.0"));
            }
        }
        assert_eq!(
            text(Lang::En, &Msg::NoticeUpdated("0.6.0".into())),
            "Xpeed Companion was updated to 0.6.0"
        );
        // The hint names the code to compare with the page.
        for lang in [Lang::En, Lang::Pt, Lang::Es] {
            assert!(text(lang, &Msg::ConnectCodeHint("K7QX".into())).contains("K7QX"));
        }
    }

    /// What a game that is open without data must be told, per game (English), checked against each game's reader notes.
    const SETUP_EN: &[(&str, &[&str])] = &[
        ("ams2", &["Options > System > Use Shared Memory", "Project CARS 2", "Save"]),
        ("pcars2", &["Shared Memory", "Project CARS 2"]),
        ("pcars3", &["Shared Memory", "Project CARS 2"]),
        ("ac", &["Assetto Corsa shares its data by itself", "start a session"]),
        ("acc", &["Assetto Corsa Competizione shares its data by itself", "start a session"]),
        ("acr", &["Assetto Corsa Rally shares its data by itself", "start a session"]),
        ("acevo", &["Assetto Corsa EVO shares its data by itself", "start a session"]),
        ("lmu", &["Settings > Gameplay > Enable external plugins"]),
        (
            "f1",
            &[
                "Settings > Telemetry Settings > UDP Telemetry On",
                "Broadcast Mode Off",
                "127.0.0.1",
                "20777",
                "UDP Format 2025 (or 2026 with the Season Pack)",
            ],
        ),
        ("f124", &["UDP Telemetry On", "20777", "UDP Format 2024"]),
        ("f123", &["UDP Telemetry On", "20777", "UDP Format 2023"]),
        (
            "fm",
            &["Gameplay & HUD", "UDP Race Telemetry", "Data Out On", "127.0.0.1", "5301", "Dash"],
        ),
        ("fm7", &["HUD and Gameplay", "Data Out On", "127.0.0.1", "5301", "Dash"]),
        ("fh4", &["HUD and Gameplay", "Data Out On", "127.0.0.1", "5301"]),
        ("fh5", &["HUD and Gameplay", "Data Out On", "127.0.0.1", "5301"]),
        ("fh6", &["HUD and Gameplay", "Data Out On", "127.0.0.1", "5301"]),
        ("iracing", &["iRacing shares its data by itself", "start a session"]),
        ("r3e", &["RaceRoom shares its data by itself", "start a session"]),
        ("wreckfest2", &["config.json", "\"enabled\" to 1", "23123"]),
        ("rfactor1", &["rFactorSharedMemoryMap", "Plugins"]),
        ("ams1", &["rFactorSharedMemoryMap"]),
        ("rf1", &["rFactorSharedMemoryMap"]),
    ];

    #[test]
    fn every_game_says_exactly_what_to_turn_on_in_the_three_languages() {
        let fallback = text(Lang::En, &Msg::Setup("no-such-game"));
        // Every game a reader waits for has its own line, and the table above names each of them.
        for &(_, id, name) in crate::games::PROGRAMS {
            let entry = SETUP_EN.iter().find(|(game, _)| *game == id);
            assert!(entry.is_some(), "{name} ({id}) has no expected instruction");
            assert_ne!(
                text(Lang::En, &Msg::Setup(id)),
                fallback,
                "{name} ({id}) falls back to the generic line"
            );
        }
        assert!(text(Lang::En, &Msg::Setup("lmu")).contains("external plugins"));
        for &(id, parts) in SETUP_EN {
            let en = text(Lang::En, &Msg::Setup(id));
            for part in parts {
                assert!(en.contains(part), "{id}: {en:?} lacks {part:?}");
            }
            let (pt, es) = (text(Lang::Pt, &Msg::Setup(id)), text(Lang::Es, &Msg::Setup(id)));
            assert!(pt != en && es != en && pt != es, "{id}: the three languages differ");
            // Short and friendly: one or two lines in the panel, no placeholder left over.
            for line in [&en, &pt, &es] {
                assert!(line.chars().count() <= 175, "{id}: too long ({}): {line}", line.chars().count());
                assert!(!line.contains('{') && !line.contains("TODO"), "{id}: {line}");
            }
            // A menu path or setting is kept in the game's own (English) wording in every language.
            for part in parts.iter().filter(|p| p.contains(" > ")) {
                assert!(pt.contains(part) && es.contains(part), "{id}: {part:?} in {pt:?} / {es:?}");
            }
        }
    }

    #[test]
    fn the_balloon_for_a_game_without_data_names_the_game_and_fits_what_windows_allows() {
        for &(id, _) in SETUP_EN {
            let name = crate::games::PROGRAMS
                .iter()
                .find(|(_, game, _)| *game == id)
                .map_or("Fake", |(_, _, name)| *name);
            for lang in Lang::ALL {
                let balloon = text(lang, &Msg::NoticeNeedsSetup(id, name));
                assert!(balloon.starts_with(name), "{balloon}");
                assert!(balloon.ends_with(&text(lang, &Msg::Setup(id))), "{balloon}");
                // A balloon holds 255 characters (`szInfo`).
                assert!(
                    balloon.encode_utf16().count() <= 255,
                    "{id} {lang:?}: {}",
                    balloon.encode_utf16().count()
                );
            }
        }
        assert_eq!(
            text(Lang::En, &Msg::NoticeNeedsSetup("r3e", "RaceRoom Racing Experience")),
            "RaceRoom Racing Experience is open but not sharing data yet. RaceRoom shares its data by itself: start a session and get on track."
        );
    }

    #[test]
    fn the_panel_failure_sentence_is_in_every_language_and_says_the_recording_goes_on() {
        let all: Vec<&str> = Lang::ALL.iter().map(|l| draw_failed(*l)).collect();
        assert!(all.iter().all(|s| !s.is_empty()));
        assert_eq!(
            all.iter().collect::<std::collections::HashSet<_>>().len(),
            Lang::ALL.len(),
            "{all:?}"
        );
        assert!(draw_failed(Lang::Pt).contains("gravação continua"));
        assert!(draw_failed(Lang::Es).contains("grabación continúa"));
    }

    #[test]
    fn a_saved_lap_is_said_in_the_language_with_the_word_for_one_that_did_not_count() {
        let mut lap = crate::status::saved_lap(5, 207_250);
        assert_eq!(lap_label(Lang::En, &lap), "Lap 5  3:27.250");
        lap.valid = false;
        assert_eq!(lap_label(Lang::En, &lap), "Lap 5  3:27.250 (not valid)");
        assert_eq!(lap_label(Lang::Pt, &lap), "Volta 5  3:27.250 (inválida)");
        assert_eq!(lap_label(Lang::Es, &lap), "Vuelta 5  3:27.250 (no válida)");
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
