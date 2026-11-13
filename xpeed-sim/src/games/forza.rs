//! Forza Motorsport (2023), Forza Motorsport 7, Forza Horizon 4, 5 and 6: the UDP telemetry the game sends
//! to this computer ("Data Out").
//!
//! The game only sends while it is running AND Data Out is switched on. The person has to set, in the game:
//!
//! * Forza Motorsport (2023): **Settings > Gameplay & HUD**, under the "UDP Race Telemetry" header. Forza Motorsport 7:
//!   the same options in its HUD settings.
//!   * Data Out: **On**
//!   * Data Out IP Address: **127.0.0.1** (the game and Xpeed Companion on the same PC; else the IP of this computer)
//!   * Data Out IP Port: **5301** (this reader listens on it, on every local address)
//!   * Data Out Packet Format: **Dash** ("Car Dash"). "Sled" has no lap times, lap number or position: its packets
//!     reach the panel (rpm, car) but never make a lap.
//! * Forza Horizon 4, 5 and 6: **Settings > HUD and Gameplay**: Data Out **On**, IP **127.0.0.1**, port **5301**. There is
//!   no format to pick (Horizon always sends its own 324-byte "Dash").
//!
//! The Microsoft Store / Game Pass builds of Forza Motorsport 7 and Forza Horizon 4 and 5 are Store apps, and Windows
//! keeps Store apps from sending to 127.0.0.1 until the app is given a loopback exemption (SimHub's guide uses the
//! "Windows 8 AppContainer Loopback Utility": tick the game, Save). Forza Motorsport (2023) sends to 127.0.0.1 without
//! it (Turn 10 says so); the Steam builds are not Store apps.
//!
//! Sources:
//! * Turn 10's "Forza Motorsport 'Data Out' Documentation" (the Sled and Dash fields, and the two fields Forza
//!   Motorsport (2023) adds): <https://support.forza.net/hc/en-us/articles/21742934024211-Forza-Motorsport-Data-Out-Documentation>
//!   (it was at support.forzamotorsport.net before). It states the types and the order, not the offsets.
//! * Turn 10's "Forza Horizon 6 'Data Out' Documentation", the only official page for the Horizon layout (the same
//!   Dash with 12 bytes inserted after the Sled part, 324 bytes in all), and the source of the units the Motorsport
//!   page leaves out (speed in m/s, position in metres, fuel 0..1, `LapNumber` = laps completed, lap times in seconds):
//!   <https://support.forza.net/hc/en-us/articles/51744149102611-Forza-Horizon-6-Data-Out-Documentation>
//! * Cross-check of the offsets and packet sizes: `geeooff/forza-data-web` (<https://github.com/geeooff/forza-data-web>,
//!   `Core/ForzaDataReader*.cs`: Sled 0..232, Dash 232..311 or 244..323 on Horizon, Motorsport extras 311..331), and
//!   for the gear numbering (0 = reverse, 1..10, 11 = neutral), which no official page gives, `theRTB/ForzaShiftTone`
//!   (`forzabase/gear.py`). The `offsets_*` tests add the documented field sizes up to every offset used here.
//!
//! The four layouts, told apart by their length (anything else is refused):
//!
//! | bytes | layout                                            | sent by                                   |
//! |-------|---------------------------------------------------|-------------------------------------------|
//! | 232   | Sled                                              | Forza Motorsport 7 and (2023), "Sled"     |
//! | 311   | Sled + Dash (79)                                  | Forza Motorsport 7, "Dash"                |
//! | 324   | Sled + 12 Horizon bytes + Dash (79) + 1 (padding) | Forza Horizon 4, 5 and 6                  |
//! | 331   | Sled + Dash (79) + tyre wear x4, TrackOrdinal     | Forza Motorsport (2023), "Dash"           |
//!
//! Which game it is comes from the running program (`Game::ALL`), and a packet whose length that game does not send
//! is refused (a 324-byte packet while Forza Motorsport 7 runs is not its own). All little-endian, packed.
//!
//! What a frame takes from a packet, and how:
//!
//! * `driving`: a Dash packet with `IsRaceOn` = 1 whose race clock (`CurrentRaceTime`) has moved within the last
//!   0.25 s. The packet has no "paused" flag: a paused game sends `IsRaceOn` = 0 or a frozen race clock (or nothing).
//! * `lap`: `LapNumber` + 1 (the game counts the laps completed; the lap file counts the lap being driven).
//! * `lap_time_s` = `CurrentLap`, `last_lap_s` = `LastLap` (seconds; 0 means none yet).
//! * `dist_m`: the packet has only `DistanceTraveled`, the distance of the whole session. The distance on the lap is
//!   `DistanceTraveled` minus its value at the first packet of the lap; that start is taken again when the lap
//!   number changes, when the car changes, and when `DistanceTraveled` jumps back more than 50 m from one packet to
//!   the next (a restart or a rewind; reversing the car moves it back far less). Below the start it reads 0.
//! * speed (m/s), rpm, gear, pedals (0..255 to 0..1), steering (-127..127 to -1..1), world position (metres).
//! * tyres: temperature in °F in the packet, turned into °C; tread left = 1 - `TireWear` (Forza Motorsport (2023)
//!   only; the page gives the name and no scale, so 0 = new is read from the name), no pressure.
//! * car `"Car #<CarOrdinal>"` with class letter and PI (`"A 800"`); track `"Track #<TrackOrdinal>"` only in the
//!   331-byte format (the others carry no track).
//! * `fuel_l` stays NaN: `Fuel` is a fraction of the tank (0..1) and no packet says how big the tank is.
//! * `in_pits` stays false and `lap_valid` stays `None`: no format says either.

use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use crate::game::{Frame, Source, Tyre};
use crate::shm::Page;

/// The port the person types in the game's Data Out settings. Not the F1 reader's 20777, so both can listen at once.
/// 5301, not the 5300 many guides use: Turn 10 asks to keep clear of 5200..5300, where the game binds its own socket
/// (Forza Horizon 6 Data Out documentation).
pub const DEFAULT_PORT: u16 = 5301;

/// The Sled part every layout starts with: 58 fields of 4 bytes.
const SLED_SIZE: usize = 232;
/// The Dash part (Motorsport and Horizon alike).
const DASH_SIZE: usize = 79;
/// What Forza Horizon puts between the Sled and the Dash parts (CarGroup, SmashableVelDiff, SmashableMass).
const HORIZON_INSERT_SIZE: usize = 12;
/// The byte Forza Horizon sends after the Dash part (no field: the 324 the page states is one more than its fields).
const HORIZON_TAIL_SIZE: usize = 1;
/// What Forza Motorsport (2023) adds after the Dash part: TireWear x4, TrackOrdinal.
const FM_EXTRAS_SIZE: usize = 20;

const FM7_DASH_PACKET: usize = SLED_SIZE + DASH_SIZE; // 311
const HORIZON_PACKET: usize = SLED_SIZE + HORIZON_INSERT_SIZE + DASH_SIZE + HORIZON_TAIL_SIZE; // 324
const FM_DASH_PACKET: usize = SLED_SIZE + DASH_SIZE + FM_EXTRAS_SIZE; // 331

// Sled (offsets from the start of the packet).
const S_IS_RACE_ON: usize = 0; // S32: 1 on track, 0 in menus or when the race is stopped
const S_CURRENT_RPM: usize = 16; // F32
const S_CAR_ORDINAL: usize = 212; // S32: the car make/model
const S_CAR_CLASS: usize = 216; // S32: 0 = the lowest class
const S_CAR_PI: usize = 220; // S32: 100..999

// Dash (offsets from the start of the Dash part).
const D_POSITION: usize = 0; // F32 x3: PositionX, Y, Z (metres)
const D_SPEED: usize = 12; // F32, m/s
const D_TIRE_TEMP: usize = 24; // F32 x4: FL, FR, RL, RR (°F)
const D_DISTANCE: usize = 48; // F32: DistanceTraveled (metres, whole session)
const D_LAST_LAP: usize = 56; // F32, seconds
const D_CURRENT_LAP: usize = 60; // F32, seconds
const D_RACE_TIME: usize = 64; // F32: CurrentRaceTime, seconds
const D_LAP_NUMBER: usize = 68; // U16: laps completed
const D_ACCEL: usize = 71; // U8 0..255
const D_BRAKE: usize = 72; // U8 0..255
const D_CLUTCH: usize = 73; // U8 0..255
const D_HANDBRAKE: usize = 74; // U8 0..255
const D_GEAR: usize = 75; // U8: 0 reverse, 1..10, 11 neutral
const D_STEER: usize = 76; // S8 -127..127

// Forza Motorsport (2023) extras (offsets from their start, right after the Dash part).
const E_TIRE_WEAR: usize = 0; // F32 x4: FL, FR, RL, RR
const E_TRACK_ORDINAL: usize = 16; // S32

/// The race clock standing still this long (on this program's clock) is a paused game.
const PAUSE_AFTER_S: f64 = 0.25;
/// `DistanceTraveled` going back more than this from one packet to the next starts the lap distance again.
const JUMP_BACK_M: f64 = 50.0;

fn u16_at(p: &Page, at: usize) -> u16 {
    u16::from(p.u8_at(at)) | (u16::from(p.u8_at(at + 1)) << 8)
}

fn i8_at(p: &Page, at: usize) -> i8 {
    i8::from_le_bytes([p.u8_at(at)])
}

/// A float the game gave, if it is a number within `range`; else NaN.
fn within(v: f32, range: std::ops::RangeInclusive<f32>) -> f32 {
    if v.is_finite() && range.contains(&v) {
        v
    } else {
        f32::NAN
    }
}

/// The layout of a packet, from its length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layout {
    Sled,
    Fm7Dash,
    HorizonDash,
    FmDash,
}

impl Layout {
    fn of_len(len: usize) -> Option<Layout> {
        match len {
            SLED_SIZE => Some(Layout::Sled),
            FM7_DASH_PACKET => Some(Layout::Fm7Dash),
            HORIZON_PACKET => Some(Layout::HorizonDash),
            FM_DASH_PACKET => Some(Layout::FmDash),
            _ => None,
        }
    }

    /// Where the Dash part starts; `None` for Sled.
    fn dash_at(self) -> Option<usize> {
        match self {
            Layout::Sled => None,
            Layout::Fm7Dash | Layout::FmDash => Some(SLED_SIZE),
            Layout::HorizonDash => Some(SLED_SIZE + HORIZON_INSERT_SIZE),
        }
    }

    /// Where the Forza Motorsport (2023) extras start; `None` for the other layouts.
    fn extras_at(self) -> Option<usize> {
        (self == Layout::FmDash).then_some(SLED_SIZE + DASH_SIZE)
    }
}

/// The game sending, as the running program tells it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Game {
    Fm,
    Fm7,
    Fh4,
    Fh5,
    Fh6,
}

impl Game {
    /// In the order they are looked for when several run at once (the newest first).
    const ALL: [Game; 5] = [Game::Fm, Game::Fh6, Game::Fh5, Game::Fh4, Game::Fm7];

    fn id(self) -> &'static str {
        match self {
            Game::Fm => "fm",
            Game::Fm7 => "fm7",
            Game::Fh4 => "fh4",
            Game::Fh5 => "fh5",
            Game::Fh6 => "fh6",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Game::Fm => "Forza Motorsport",
            Game::Fm7 => "Forza Motorsport 7",
            Game::Fh4 => "Forza Horizon 4",
            Game::Fh5 => "Forza Horizon 5",
            Game::Fh6 => "Forza Horizon 6",
        }
    }

    /// The executables, in lower case.
    /// * Forza Motorsport (2023): the Steam build `forza_steamworks_release_final.exe` (the process name in a crash
    ///   dump on the game's Steam forum, app 2440510); the Microsoft Store / Game Pass build
    ///   `forza_gaming.desktop.x64_release_final.exe` (Fanatec forum, about telemetry from the Store build).
    /// * Forza Horizon 4, 5 and 6: `ForzaHorizon4.exe`, `ForzaHorizon5.exe`, `ForzaHorizon6.exe` (Turn 10's support article "My Game is Not
    ///   Launching or is Crashing on PC"; the same name on Steam and the Store). `ForzaHorizon6.exe` is the faulting
    ///   application in downloadsource.net's FH6 startup-crash guide (version 6.354.221.0); Steam app 2483190.
    /// * Forza Motorsport 7 (Microsoft Store only): `ForzaMotorsport7.exe` (crash reports on the Forza forums).
    fn programs(self) -> &'static [&'static str] {
        match self {
            Game::Fm => &["forza_steamworks_release_final.exe", "forza_gaming.desktop.x64_release_final.exe"],
            Game::Fm7 => &["forzamotorsport7.exe"],
            Game::Fh4 => &["forzahorizon4.exe"],
            Game::Fh5 => &["forzahorizon5.exe"],
            Game::Fh6 => &["forzahorizon6.exe"],
        }
    }

    /// Whether this game sends packets of that layout.
    fn sends(self, layout: Layout) -> bool {
        match self {
            Game::Fm => matches!(layout, Layout::Sled | Layout::FmDash),
            Game::Fm7 => matches!(layout, Layout::Sled | Layout::Fm7Dash),
            Game::Fh4 | Game::Fh5 | Game::Fh6 => layout == Layout::HorizonDash,
        }
    }

    /// The class letter of `CarClass` in this game. Turn 10's page says "0 (D) to 7 (X)", Forza Motorsport 7's eight
    /// classes; Forza Motorsport (2023) added E below D (nine, 0..8) and Forza Horizon has seven (D to S2, X): those
    /// two tables are `geeooff/forza-data-web`'s (`Console/CarClasses.cs`).
    fn class_letter(self, class: i32) -> Option<&'static str> {
        let table: &[&str] = match self {
            Game::Fm7 => &["D", "C", "B", "A", "S", "R", "P", "X"],
            Game::Fm => &["E", "D", "C", "B", "A", "S", "R", "P", "X"],
            Game::Fh4 | Game::Fh5 | Game::Fh6 => &["D", "C", "B", "A", "S1", "S2", "X"],
        };
        usize::try_from(class).ok().and_then(|i| table.get(i).copied())
    }

    /// The class as the game shows it: the letter and the performance index (`"A 800"`), the letter alone when the
    /// index is out of 100..999, `None` for a class the table does not have.
    fn class(self, class: i32, pi: i32) -> Option<String> {
        let letter = self.class_letter(class)?;
        Some(if (100..=999).contains(&pi) {
            format!("{letter} {pi}")
        } else {
            letter.to_owned()
        })
    }

    /// The first of the games whose program is in `running` (names in lower case).
    fn running(running: &[String]) -> Option<Game> {
        Game::ALL.into_iter().find(|g| crate::win::any_running(running, g.programs()))
    }
}

/// Where the current lap started on the `DistanceTraveled` scale.
#[derive(Clone, Copy, Debug)]
struct LapStart {
    lap_number: u16,
    car_ordinal: i32,
    start_m: f64,
    last_m: f64,
}

/// Turns the packets of one game into frames.
struct Decoder {
    game: Game,
    lap_start: Option<LapStart>,
    /// The last race clock seen and this program's clock when it last moved.
    race_clock: Option<(u32, f64)>,
}

impl Decoder {
    fn new(game: Game) -> Decoder {
        Decoder {
            game,
            lap_start: None,
            race_clock: None,
        }
    }

    /// Reads one datagram. A frame for every packet of a length this game sends; `None` for anything else. Never
    /// panics, whatever the bytes are.
    fn feed(&mut self, data: &[u8], clock_s: f64) -> Option<Frame> {
        let layout = Layout::of_len(data.len())?;
        if !self.game.sends(layout) {
            return None;
        }
        let p = Page(data);
        let mut f = Frame::empty();
        f.clock_s = clock_s;
        f.rpm = within(p.f32_at(S_CURRENT_RPM), 0.0..=30_000.0);
        let ordinal = p.i32_at(S_CAR_ORDINAL);
        if ordinal > 0 {
            f.car = format!("Car #{ordinal}");
            f.car_class = self.game.class(p.i32_at(S_CAR_CLASS), p.i32_at(S_CAR_PI));
        }
        // Sled: no lap data at all, so never driving (no lap can be cut from it).
        let Some(d) = layout.dash_at() else {
            return Some(f);
        };
        let race_on = p.i32_at(S_IS_RACE_ON) == 1;

        f.x = within(p.f32_at(d + D_POSITION), -1e6..=1e6);
        f.y = within(p.f32_at(d + D_POSITION + 4), -1e6..=1e6);
        f.z = within(p.f32_at(d + D_POSITION + 8), -1e6..=1e6);
        f.speed_ms = within(p.f32_at(d + D_SPEED), 0.0..=200.0);
        f.throttle = f32::from(p.u8_at(d + D_ACCEL)) / 255.0;
        f.brake = f32::from(p.u8_at(d + D_BRAKE)) / 255.0;
        f.clutch = f32::from(p.u8_at(d + D_CLUTCH)) / 255.0;
        // The only light the packet gives: the handbrake input is above 0 (0..255).
        f.state.handbrake = Some(p.u8_at(d + D_HANDBRAKE) > 0);
        f.steer = (f32::from(i8_at(&p, d + D_STEER)) / 127.0).clamp(-1.0, 1.0);
        f.gear = match p.u8_at(d + D_GEAR) {
            0 => -1.0,
            11 => 0.0,
            g @ 1..=10 => f32::from(g),
            _ => f32::NAN,
        };

        let extras = layout.extras_at();
        let tyres: [Tyre; 4] = std::array::from_fn(|i| {
            let fahrenheit = p.f32_at(d + D_TIRE_TEMP + 4 * i);
            // A zeroed field (a menu packet) is no reading.
            let temp_c = if fahrenheit != 0.0 {
                within((fahrenheit - 32.0) * 5.0 / 9.0, -50.0..=400.0)
            } else {
                f32::NAN
            };
            let left = extras.map_or(f32::NAN, |e| 1.0 - within(p.f32_at(e + E_TIRE_WEAR + 4 * i), 0.0..=1.0));
            Tyre {
                // Data Out has no brake temperature.
                brake_c: f32::NAN,
                temp_c,
                pressure_kpa: f32::NAN,
                left,
            }
        });
        f.tyres = tyres.iter().any(Tyre::known).then_some(tyres);
        if let Some(e) = extras {
            let track = p.i32_at(e + E_TRACK_ORDINAL);
            if track > 0 {
                f.track = format!("Track #{track}");
            }
        }

        let lap_number = u16_at(&p, d + D_LAP_NUMBER);
        f.lap = i32::from(lap_number) + 1;
        let current = p.f32_at(d + D_CURRENT_LAP);
        f.lap_time_s = (current.is_finite() && (0.0..=86_400.0).contains(&current)).then_some(f64::from(current));
        let last = p.f32_at(d + D_LAST_LAP);
        f.last_lap_s = (last.is_finite() && last > 0.0 && last <= 86_400.0).then_some(f64::from(last));
        if race_on {
            f.dist_m = self.lap_distance(f64::from(p.f32_at(d + D_DISTANCE)), lap_number, ordinal);
        }

        let race_time = p.f32_at(d + D_RACE_TIME);
        let paused = self.race_clock_still(race_time, clock_s);
        f.driving = race_on && race_time.is_finite() && !paused;
        Some(f)
    }

    /// The distance on the current lap (see the module doc); `None` when `DistanceTraveled` is not a number.
    fn lap_distance(&mut self, travelled: f64, lap_number: u16, car_ordinal: i32) -> Option<f64> {
        if !travelled.is_finite() || travelled.abs() > 1e7 {
            return None;
        }
        let start = match self.lap_start {
            Some(s) if s.lap_number == lap_number && s.car_ordinal == car_ordinal && travelled >= s.last_m - JUMP_BACK_M => s.start_m,
            _ => travelled,
        };
        self.lap_start = Some(LapStart {
            lap_number,
            car_ordinal,
            start_m: start,
            last_m: travelled,
        });
        Some((travelled - start).max(0.0))
    }

    /// True when the race clock has not moved for `PAUSE_AFTER_S`.
    fn race_clock_still(&mut self, race_time: f32, clock_s: f64) -> bool {
        let bits = race_time.to_bits();
        match self.race_clock {
            Some((before, since)) if before == bits => clock_s - since >= PAUSE_AFTER_S,
            _ => {
                self.race_clock = Some((bits, clock_s));
                false
            }
        }
    }
}

/// The open door: a UDP socket the game sends its telemetry to.
pub struct ForzaSource {
    socket: UdpSocket,
    start: Instant,
    decoder: Decoder,
    buf: Vec<u8>,
    alive: bool,
}

/// Windows' "message too long": a datagram bigger than the buffer. Not ours, and nothing wrong with the door.
const WSAEMSGSIZE: i32 = 10040;

impl ForzaSource {
    /// Binds `addr` for `game`; `None` when that fails (the port is busy: another program, for example a dashboard,
    /// owns it).
    fn bind(addr: SocketAddr, game: Game) -> Option<ForzaSource> {
        let socket = UdpSocket::bind(addr).ok()?;
        Some(ForzaSource {
            socket,
            start: Instant::now(),
            decoder: Decoder::new(game),
            // The biggest packet is 331 bytes; anything longer is refused by its size (or by Windows, see WSAEMSGSIZE).
            buf: vec![0; 1024],
            alive: true,
        })
    }

    #[cfg(test)]
    fn local_addr(&self) -> SocketAddr {
        self.socket.local_addr().expect("a bound socket has an address")
    }
}

/// Opens the door on UDP port 5301, all local addresses, for the Forza game that is running. `None` when none is, or
/// when the port is not free.
pub fn open() -> Option<Box<dyn Source>> {
    let game = Game::running(&crate::win::running_programs())?;
    let source = ForzaSource::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, DEFAULT_PORT)), game)?;
    Some(Box::new(source))
}

impl Source for ForzaSource {
    fn game_id(&self) -> &'static str {
        self.decoder.game.id()
    }

    fn game_name(&self) -> &'static str {
        self.decoder.game.name()
    }

    fn next(&mut self, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        loop {
            let wait = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
            if self.socket.set_read_timeout(Some(wait)).is_err() {
                self.alive = false;
                return None;
            }
            match self.socket.recv_from(&mut self.buf) {
                Ok((n, _)) => {
                    let clock_s = self.start.elapsed().as_secs_f64();
                    if let Some(frame) = self.decoder.feed(&self.buf[..n], clock_s) {
                        return Some(frame);
                    }
                }
                Err(e) if e.raw_os_error() == Some(WSAEMSGSIZE) => {}
                Err(e) => match e.kind() {
                    ErrorKind::WouldBlock | ErrorKind::TimedOut => return None,
                    // Windows reports a refused earlier send on a UDP socket this way; nothing is wrong with the door.
                    ErrorKind::ConnectionReset | ErrorKind::Interrupted => {}
                    _ => {
                        self.alive = false;
                        return None;
                    }
                },
            }
            if Instant::now() >= deadline {
                return None;
            }
        }
    }

    fn alive(&self) -> bool {
        self.alive
    }

    fn listens(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::CarState;
    use crate::lapcut::LapCutter;

    // ---- the documented fields, in the order of Turn 10's pages, with their sizes in bytes ----

    /// Sled, as Turn 10's Forza Motorsport page lists it.
    const SLED_FIELDS: &[(&str, usize)] = &[
        ("IsRaceOn", 4),
        ("TimestampMS", 4),
        ("EngineMaxRpm", 4),
        ("EngineIdleRpm", 4),
        ("CurrentEngineRpm", 4),
        ("AccelerationX", 4),
        ("AccelerationY", 4),
        ("AccelerationZ", 4),
        ("VelocityX", 4),
        ("VelocityY", 4),
        ("VelocityZ", 4),
        ("AngularVelocityX", 4),
        ("AngularVelocityY", 4),
        ("AngularVelocityZ", 4),
        ("Yaw", 4),
        ("Pitch", 4),
        ("Roll", 4),
        ("NormalizedSuspensionTravelFrontLeft", 4),
        ("NormalizedSuspensionTravelFrontRight", 4),
        ("NormalizedSuspensionTravelRearLeft", 4),
        ("NormalizedSuspensionTravelRearRight", 4),
        ("TireSlipRatioFrontLeft", 4),
        ("TireSlipRatioFrontRight", 4),
        ("TireSlipRatioRearLeft", 4),
        ("TireSlipRatioRearRight", 4),
        ("WheelRotationSpeedFrontLeft", 4),
        ("WheelRotationSpeedFrontRight", 4),
        ("WheelRotationSpeedRearLeft", 4),
        ("WheelRotationSpeedRearRight", 4),
        ("WheelOnRumbleStripFrontLeft", 4),
        ("WheelOnRumbleStripFrontRight", 4),
        ("WheelOnRumbleStripRearLeft", 4),
        ("WheelOnRumbleStripRearRight", 4),
        ("WheelInPuddleDepthFrontLeft", 4),
        ("WheelInPuddleDepthFrontRight", 4),
        ("WheelInPuddleDepthRearLeft", 4),
        ("WheelInPuddleDepthRearRight", 4),
        ("SurfaceRumbleFrontLeft", 4),
        ("SurfaceRumbleFrontRight", 4),
        ("SurfaceRumbleRearLeft", 4),
        ("SurfaceRumbleRearRight", 4),
        ("TireSlipAngleFrontLeft", 4),
        ("TireSlipAngleFrontRight", 4),
        ("TireSlipAngleRearLeft", 4),
        ("TireSlipAngleRearRight", 4),
        ("TireCombinedSlipFrontLeft", 4),
        ("TireCombinedSlipFrontRight", 4),
        ("TireCombinedSlipRearLeft", 4),
        ("TireCombinedSlipRearRight", 4),
        ("SuspensionTravelMetersFrontLeft", 4),
        ("SuspensionTravelMetersFrontRight", 4),
        ("SuspensionTravelMetersRearLeft", 4),
        ("SuspensionTravelMetersRearRight", 4),
        ("CarOrdinal", 4),
        ("CarClass", 4),
        ("CarPerformanceIndex", 4),
        ("DrivetrainType", 4),
        ("NumCylinders", 4),
    ];

    /// The Dash part after Sled (the same on both pages).
    const DASH_FIELDS: &[(&str, usize)] = &[
        ("PositionX", 4),
        ("PositionY", 4),
        ("PositionZ", 4),
        ("Speed", 4),
        ("Power", 4),
        ("Torque", 4),
        ("TireTempFrontLeft", 4),
        ("TireTempFrontRight", 4),
        ("TireTempRearLeft", 4),
        ("TireTempRearRight", 4),
        ("Boost", 4),
        ("Fuel", 4),
        ("DistanceTraveled", 4),
        ("BestLap", 4),
        ("LastLap", 4),
        ("CurrentLap", 4),
        ("CurrentRaceTime", 4),
        ("LapNumber", 2),
        ("RacePosition", 1),
        ("Accel", 1),
        ("Brake", 1),
        ("Clutch", 1),
        ("HandBrake", 1),
        ("Gear", 1),
        ("Steer", 1),
        ("NormalizedDrivingLine", 1),
        ("NormalizedAIBrakeDifference", 1),
    ];

    /// What Forza Horizon inserts after NumCylinders (named on Turn 10's Forza Horizon 6 page).
    const HORIZON_INSERT_FIELDS: &[(&str, usize)] = &[("CarGroup", 4), ("SmashableVelDiff", 4), ("SmashableMass", 4)];

    /// What Forza Motorsport (2023) adds after the Dash part.
    const FM_EXTRA_FIELDS: &[(&str, usize)] = &[
        ("TireWearFrontLeft", 4),
        ("TireWearFrontRight", 4),
        ("TireWearRearLeft", 4),
        ("TireWearRearRight", 4),
        ("TrackOrdinal", 4),
    ];

    fn size_of(fields: &[(&str, usize)]) -> usize {
        fields.iter().map(|(_, size)| size).sum()
    }

    /// The offset of `name`: the sizes of every field before it, added up.
    fn offset_of(fields: &[(&str, usize)], name: &str) -> usize {
        let at = fields
            .iter()
            .position(|(n, _)| *n == name)
            .unwrap_or_else(|| panic!("no field {name}"));
        size_of(&fields[..at])
    }

    #[test]
    fn sizes_add_up_to_the_four_packet_lengths() {
        assert_eq!(SLED_FIELDS.len(), 58);
        assert_eq!(size_of(SLED_FIELDS), SLED_SIZE);
        assert_eq!(size_of(DASH_FIELDS), DASH_SIZE);
        assert_eq!(size_of(HORIZON_INSERT_FIELDS), HORIZON_INSERT_SIZE);
        assert_eq!(size_of(FM_EXTRA_FIELDS), FM_EXTRAS_SIZE);
        assert_eq!(SLED_SIZE, 232);
        assert_eq!(FM7_DASH_PACKET, 311);
        assert_eq!(HORIZON_PACKET, 324);
        assert_eq!(FM_DASH_PACKET, 331);
        // The Horizon page states 324 bytes; its fields add up to one less (the trailing byte this reader skips).
        assert_eq!(
            size_of(SLED_FIELDS) + size_of(HORIZON_INSERT_FIELDS) + size_of(DASH_FIELDS) + 1,
            324
        );
    }

    #[test]
    fn offsets_are_the_documented_sizes_added_up() {
        assert_eq!(offset_of(SLED_FIELDS, "IsRaceOn"), S_IS_RACE_ON);
        assert_eq!(offset_of(SLED_FIELDS, "CurrentEngineRpm"), S_CURRENT_RPM);
        assert_eq!(offset_of(SLED_FIELDS, "CarOrdinal"), S_CAR_ORDINAL);
        assert_eq!(offset_of(SLED_FIELDS, "CarClass"), S_CAR_CLASS);
        assert_eq!(offset_of(SLED_FIELDS, "CarPerformanceIndex"), S_CAR_PI);

        assert_eq!(offset_of(DASH_FIELDS, "PositionX"), D_POSITION);
        assert_eq!(offset_of(DASH_FIELDS, "PositionY"), D_POSITION + 4);
        assert_eq!(offset_of(DASH_FIELDS, "PositionZ"), D_POSITION + 8);
        assert_eq!(offset_of(DASH_FIELDS, "Speed"), D_SPEED);
        assert_eq!(offset_of(DASH_FIELDS, "TireTempFrontLeft"), D_TIRE_TEMP);
        assert_eq!(offset_of(DASH_FIELDS, "TireTempRearRight"), D_TIRE_TEMP + 12);
        assert_eq!(offset_of(DASH_FIELDS, "DistanceTraveled"), D_DISTANCE);
        assert_eq!(offset_of(DASH_FIELDS, "LastLap"), D_LAST_LAP);
        assert_eq!(offset_of(DASH_FIELDS, "CurrentLap"), D_CURRENT_LAP);
        assert_eq!(offset_of(DASH_FIELDS, "CurrentRaceTime"), D_RACE_TIME);
        assert_eq!(offset_of(DASH_FIELDS, "LapNumber"), D_LAP_NUMBER);
        assert_eq!(offset_of(DASH_FIELDS, "Accel"), D_ACCEL);
        assert_eq!(offset_of(DASH_FIELDS, "Brake"), D_BRAKE);
        assert_eq!(offset_of(DASH_FIELDS, "Clutch"), D_CLUTCH);
        assert_eq!(offset_of(DASH_FIELDS, "HandBrake"), D_HANDBRAKE);
        assert_eq!(offset_of(DASH_FIELDS, "Gear"), D_GEAR);
        assert_eq!(offset_of(DASH_FIELDS, "Steer"), D_STEER);

        assert_eq!(offset_of(FM_EXTRA_FIELDS, "TireWearFrontLeft"), E_TIRE_WEAR);
        assert_eq!(offset_of(FM_EXTRA_FIELDS, "TrackOrdinal"), E_TRACK_ORDINAL);

        // Where the parts start in each layout (geeooff/forza-data-web: 232..311, 244..323, 311..331).
        assert_eq!(Layout::Fm7Dash.dash_at(), Some(232));
        assert_eq!(Layout::FmDash.dash_at(), Some(232));
        assert_eq!(Layout::HorizonDash.dash_at(), Some(244));
        assert_eq!(Layout::Sled.dash_at(), None);
        assert_eq!(Layout::FmDash.extras_at(), Some(311));
        assert_eq!(Layout::Fm7Dash.extras_at(), None);
        assert_eq!(Layout::HorizonDash.extras_at(), None);
    }

    // ---- byte builders, field by field in the documented order ----

    #[derive(Default)]
    struct W(Vec<u8>);

    impl W {
        fn u8(&mut self, v: u8) -> &mut Self {
            self.0.push(v);
            self
        }
        fn i8(&mut self, v: i8) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u16(&mut self, v: u16) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn i32(&mut self, v: i32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u32(&mut self, v: u32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn f32(&mut self, v: f32) -> &mut Self {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
    }

    #[derive(Clone)]
    struct Sled {
        race_on: i32,
        rpm: f32,
        car_ordinal: i32,
        car_class: i32,
        pi: i32,
    }

    fn sample_sled() -> Sled {
        Sled {
            race_on: 1,
            rpm: 6543.5,
            car_ordinal: 2352,
            car_class: 3,
            pi: 600,
        }
    }

    /// Sled: every field written, the ones not read with values of their own so a wrong offset shows.
    fn write_sled(w: &mut W, s: &Sled) {
        w.i32(s.race_on).u32(123_456).f32(9000.0).f32(800.0).f32(s.rpm);
        for v in 1..=12 {
            w.f32(1000.0 + v as f32); // acceleration, velocity, angular velocity x3, yaw, pitch, roll
        }
        for v in 1..=12 {
            w.f32(2000.0 + v as f32); // suspension travel, slip ratio, wheel rotation x4
        }
        for _ in 0..4 {
            w.i32(1); // on a rumble strip
        }
        for v in 1..=20 {
            w.f32(3000.0 + v as f32); // puddle, surface rumble, slip angle, combined slip, suspension metres x4
        }
        w.i32(s.car_ordinal).i32(s.car_class).i32(s.pi).i32(1).i32(8);
    }

    #[derive(Clone)]
    struct Dash {
        pos: [f32; 3],
        speed: f32,
        tire_temp_f: [f32; 4],
        distance: f32,
        last: f32,
        current: f32,
        race_time: f32,
        lap_number: u16,
        accel: u8,
        brake: u8,
        clutch: u8,
        gear: u8,
        steer: i8,
    }

    fn sample_dash() -> Dash {
        Dash {
            pos: [120.5, 12.25, -340.75],
            speed: 50.0,
            tire_temp_f: [212.0, 194.0, 176.0, 158.0], // 100, 90, 80, 70 °C
            distance: 2500.0,
            last: 91.25,
            current: 45.5,
            race_time: 136.75,
            lap_number: 1,
            accel: 255,
            brake: 51,
            clutch: 0,
            gear: 4,
            steer: -127,
        }
    }

    fn write_dash(w: &mut W, d: &Dash) {
        w.f32(d.pos[0]).f32(d.pos[1]).f32(d.pos[2]);
        w.f32(d.speed).f32(250_000.0).f32(400.0); // Speed, Power, Torque
        for t in d.tire_temp_f {
            w.f32(t);
        }
        w.f32(14.5).f32(0.62).f32(d.distance); // Boost, Fuel, DistanceTraveled
        w.f32(88.125).f32(d.last).f32(d.current).f32(d.race_time); // BestLap, LastLap, CurrentLap, CurrentRaceTime
        w.u16(d.lap_number).u8(3); // LapNumber, RacePosition
        w.u8(d.accel).u8(d.brake).u8(d.clutch).u8(200).u8(d.gear).i8(d.steer); // .., HandBrake, ..
        w.i8(-5).i8(17); // NormalizedDrivingLine, NormalizedAIBrakeDifference
    }

    fn sled_packet(s: &Sled) -> Vec<u8> {
        let mut w = W::default();
        write_sled(&mut w, s);
        w.0
    }

    fn fm7_packet(s: &Sled, d: &Dash) -> Vec<u8> {
        let mut w = W::default();
        write_sled(&mut w, s);
        write_dash(&mut w, d);
        w.0
    }

    fn horizon_packet(s: &Sled, d: &Dash) -> Vec<u8> {
        let mut w = W::default();
        write_sled(&mut w, s);
        w.u32(7).f32(3.5).f32(1200.0); // CarGroup, SmashableVelDiff, SmashableMass
        write_dash(&mut w, d);
        w.u8(0x5a); // the trailing byte
        w.0
    }

    fn fm_packet(s: &Sled, d: &Dash, wear: [f32; 4], track: i32) -> Vec<u8> {
        let mut w = W::default();
        write_sled(&mut w, s);
        write_dash(&mut w, d);
        for v in wear {
            w.f32(v);
        }
        w.i32(track);
        w.0
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-3
    }

    #[test]
    fn the_builders_make_packets_of_the_documented_lengths() {
        assert_eq!(sled_packet(&sample_sled()).len(), 232);
        assert_eq!(fm7_packet(&sample_sled(), &sample_dash()).len(), 311);
        assert_eq!(horizon_packet(&sample_sled(), &sample_dash()).len(), 324);
        assert_eq!(fm_packet(&sample_sled(), &sample_dash(), [0.0; 4], 1).len(), 331);
    }

    // ---- exact frame values, one test per length ----

    /// What every Dash layout gives the same way.
    fn assert_dash_values(f: &Frame) {
        assert!(f.driving);
        assert_eq!(f.clock_s, 2.5);
        assert_eq!(f.rpm, 6543.5);
        assert_eq!((f.x, f.y, f.z), (120.5, 12.25, -340.75));
        assert_eq!(f.speed_ms, 50.0);
        assert_eq!((f.throttle, f.clutch), (1.0, 0.0));
        assert!(close(f.brake, 0.2));
        assert_eq!(f.steer, -1.0);
        assert_eq!(f.gear, 4.0);
        assert_eq!(f.lap, 2, "LapNumber 1 = one lap done, the second being driven");
        assert_eq!(f.lap_time_s, Some(45.5));
        assert_eq!(f.last_lap_s, Some(91.25));
        assert_eq!(f.dist_m, Some(0.0), "the first packet of a lap is its start");
        assert!(!f.in_pits);
        assert_eq!(f.lap_valid, None);
        assert!(f.fuel_l.is_nan(), "a fraction of an unknown tank is not litres");
        // The packet's handbrake input (200 of 255) is the only part of the car's state it has.
        assert_eq!(
            f.state,
            CarState {
                handbrake: Some(true),
                ..CarState::UNKNOWN
            }
        );
        assert_eq!(f.car, "Car #2352");
        let tyres = f.tyres.expect("tyre temperatures");
        for (tyre, c) in tyres.iter().zip([100.0, 90.0, 80.0, 70.0]) {
            assert!(close(tyre.temp_c, c), "{} °C", tyre.temp_c);
            assert!(tyre.pressure_kpa.is_nan());
        }
    }

    #[test]
    fn reads_forza_motorsport_7_dash() {
        let mut d = Decoder::new(Game::Fm7);
        let f = d.feed(&fm7_packet(&sample_sled(), &sample_dash()), 2.5).expect("a frame");
        assert_dash_values(&f);
        assert_eq!(f.car_class.as_deref(), Some("A 600"));
        assert!(f.track.is_empty(), "the 311-byte format has no track");
        assert!(
            f.tyres.unwrap().iter().all(|t| t.left.is_nan()),
            "no wear before Forza Motorsport (2023)"
        );
    }

    #[test]
    fn reads_forza_horizon_dash() {
        for game in [Game::Fh4, Game::Fh5, Game::Fh6] {
            let mut d = Decoder::new(game);
            let f = d.feed(&horizon_packet(&sample_sled(), &sample_dash()), 2.5).expect("a frame");
            assert_dash_values(&f);
            assert_eq!(f.car_class.as_deref(), Some("A 600"));
            assert!(f.track.is_empty());
        }
    }

    #[test]
    fn reads_forza_motorsport_2023_dash_with_wear_and_track() {
        let mut d = Decoder::new(Game::Fm);
        let f = d
            .feed(&fm_packet(&sample_sled(), &sample_dash(), [0.0, 0.25, 0.5, 1.0], 860), 2.5)
            .expect("a frame");
        assert_dash_values(&f);
        assert_eq!(f.car_class.as_deref(), Some("B 600"), "class 3 is B in the nine classes of 2023");
        assert_eq!(f.track, "Track #860");
        let left: Vec<f32> = f.tyres.unwrap().iter().map(|t| t.left).collect();
        assert_eq!(left, [1.0, 0.75, 0.5, 0.0]);
    }

    #[test]
    fn sled_reaches_the_panel_but_makes_no_lap() {
        for game in [Game::Fm, Game::Fm7] {
            let mut d = Decoder::new(game);
            let f = d.feed(&sled_packet(&sample_sled()), 1.0).expect("a frame");
            assert!(!f.driving);
            assert_eq!(f.rpm, 6543.5);
            assert_eq!(f.car, "Car #2352");
            assert!(f.lap_time_s.is_none() && f.last_lap_s.is_none() && f.dist_m.is_none());
            assert!(f.speed_ms.is_nan() && f.x.is_nan() && f.tyres.is_none());
            assert_eq!(f.state, CarState::UNKNOWN, "a Sled packet has no handbrake");
        }
    }

    #[test]
    fn a_length_the_game_does_not_send_is_refused() {
        let s = sample_sled();
        let d = sample_dash();
        let sled = sled_packet(&s);
        let fm7 = fm7_packet(&s, &d);
        let horizon = horizon_packet(&s, &d);
        let fm = fm_packet(&s, &d, [0.0; 4], 1);
        let sends = |game: Game, packet: &[u8]| Decoder::new(game).feed(packet, 0.0).is_some();
        assert!(sends(Game::Fm, &sled) && sends(Game::Fm, &fm));
        assert!(!sends(Game::Fm, &fm7) && !sends(Game::Fm, &horizon));
        assert!(sends(Game::Fm7, &sled) && sends(Game::Fm7, &fm7));
        assert!(!sends(Game::Fm7, &fm) && !sends(Game::Fm7, &horizon));
        for game in [Game::Fh4, Game::Fh5, Game::Fh6] {
            assert!(sends(game, &horizon));
            assert!(!sends(game, &sled) && !sends(game, &fm7) && !sends(game, &fm));
        }
        // Any other length, for every game: one byte more or less than each format, and the odd sizes.
        for game in Game::ALL {
            for packet in [&sled, &fm7, &horizon, &fm] {
                let mut longer = packet.clone();
                longer.push(0);
                assert!(!sends(game, &longer), "{game:?} {}", longer.len());
                assert!(!sends(game, &packet[..packet.len() - 1]), "{game:?} {}", packet.len() - 1);
            }
            for len in [0, 1, 4, 100, 231, 323, 1024] {
                assert!(!sends(game, &vec![1u8; len]), "{game:?} {len}");
            }
        }
    }

    // ---- driving, laps and distance ----

    #[test]
    fn menus_and_a_paused_game_are_not_driving() {
        let mut d = Decoder::new(Game::Fm7);
        let s = sample_sled();
        let mut dash = sample_dash();
        // IsRaceOn = 0: a menu, or the race stopped.
        let off = Sled { race_on: 0, ..s.clone() };
        let f = d.feed(&fm7_packet(&off, &dash), 0.0).unwrap();
        assert!(!f.driving);
        assert_eq!(f.dist_m, None, "no lap distance outside a race");
        // Racing: the race clock moves with every packet.
        let mut clock = 1.0;
        for _ in 0..10 {
            dash.race_time += 1.0 / 60.0;
            clock += 1.0 / 60.0;
            assert!(d.feed(&fm7_packet(&s, &dash), clock).unwrap().driving);
        }
        // Paused: the same race clock, packet after packet. A short stall is still driving; 0.25 s of it is a pause.
        clock += 0.1;
        assert!(d.feed(&fm7_packet(&s, &dash), clock).unwrap().driving);
        clock += 0.2;
        assert!(!d.feed(&fm7_packet(&s, &dash), clock).unwrap().driving);
        clock += 5.0;
        assert!(!d.feed(&fm7_packet(&s, &dash), clock).unwrap().driving);
        // Back from the pause.
        dash.race_time += 1.0 / 60.0;
        assert!(d.feed(&fm7_packet(&s, &dash), clock + 0.016).unwrap().driving);
        // A race clock that is not a number is no race.
        dash.race_time = f32::NAN;
        assert!(!d.feed(&fm7_packet(&s, &dash), clock + 0.032).unwrap().driving);
    }

    #[test]
    fn the_lap_distance_starts_again_on_a_new_lap() {
        let mut d = Decoder::new(Game::Fh5);
        let s = sample_sled();
        let mut dash = Dash {
            distance: 10_000.0,
            ..sample_dash()
        };
        assert_eq!(d.feed(&horizon_packet(&s, &dash), 0.0).unwrap().dist_m, Some(0.0));
        dash.distance = 10_250.5;
        dash.race_time += 1.0;
        assert_eq!(d.feed(&horizon_packet(&s, &dash), 1.0).unwrap().dist_m, Some(250.5));
        // The line: LapNumber goes up, the distance on the lap starts from here.
        dash.distance = 13_000.0;
        dash.lap_number = 2;
        dash.race_time += 1.0;
        let f = d.feed(&horizon_packet(&s, &dash), 2.0).unwrap();
        assert_eq!((f.lap, f.dist_m), (3, Some(0.0)));
        dash.distance = 13_100.0;
        dash.race_time += 1.0;
        assert_eq!(d.feed(&horizon_packet(&s, &dash), 3.0).unwrap().dist_m, Some(100.0));
        // Another car: its lap starts where it is.
        let other = Sled {
            car_ordinal: 9,
            ..s.clone()
        };
        dash.distance = 13_150.0;
        assert_eq!(d.feed(&horizon_packet(&other, &dash), 3.1).unwrap().dist_m, Some(0.0));
    }

    #[test]
    fn a_jump_back_in_distance_starts_the_lap_again_and_reversing_does_not() {
        let mut d = Decoder::new(Game::Fm);
        let s = sample_sled();
        let feed = |d: &mut Decoder, distance: f32| {
            let dash = Dash { distance, ..sample_dash() };
            d.feed(&fm_packet(&s, &dash, [0.0; 4], 3), 0.0).unwrap().dist_m
        };
        assert_eq!(feed(&mut d, 500.0), Some(0.0));
        assert_eq!(feed(&mut d, 1500.0), Some(1000.0));
        // Reversing a few metres: still the same lap.
        assert_eq!(feed(&mut d, 1490.0), Some(990.0));
        // A restart (or a rewind): back by more than 50 m at once.
        assert_eq!(feed(&mut d, 600.0), Some(0.0));
        assert_eq!(feed(&mut d, 620.0), Some(20.0));
        // Backing over the lap's own start (less than 50 m at once) reads 0, never less.
        assert_eq!(feed(&mut d, 590.0), Some(0.0));
        // A distance that is not a number is no distance, and does not move the start.
        assert_eq!(feed(&mut d, f32::NAN), None);
        assert_eq!(feed(&mut d, f32::INFINITY), None);
        assert_eq!(feed(&mut d, 3e9), None);
        assert_eq!(feed(&mut d, 650.0), Some(50.0));
    }

    #[test]
    fn values_out_of_range_are_not_believed() {
        let mut d = Decoder::new(Game::Fm7);
        let s = Sled {
            rpm: f32::NAN,
            car_ordinal: 0,
            ..sample_sled()
        };
        let dash = Dash {
            pos: [f32::INFINITY, 2e7, f32::NAN],
            speed: -3.0,
            tire_temp_f: [0.0, f32::NAN, 5000.0, 32.0],
            last: -1.0,
            current: f32::NAN,
            ..sample_dash()
        };
        let f = d.feed(&fm7_packet(&s, &dash), 0.0).unwrap();
        assert!(f.rpm.is_nan() && f.speed_ms.is_nan());
        assert!(f.x.is_nan() && f.y.is_nan() && f.z.is_nan());
        assert!(f.car.is_empty() && f.car_class.is_none(), "ordinal 0 is no car");
        assert_eq!((f.last_lap_s, f.lap_time_s), (None, None));
        let tyres = f.tyres.expect("one tyre is enough");
        assert!(tyres[0].temp_c.is_nan() && tyres[1].temp_c.is_nan() && tyres[2].temp_c.is_nan());
        assert_eq!(tyres[3].temp_c, 0.0, "32 °F is 0 °C");
        // No temperature at all: no tyres.
        let cold = Dash {
            tire_temp_f: [0.0; 4],
            ..sample_dash()
        };
        assert!(d.feed(&fm7_packet(&sample_sled(), &cold), 0.0).unwrap().tyres.is_none());
        // Wear outside 0..1 is not believed.
        let mut d = Decoder::new(Game::Fm);
        let f = d
            .feed(&fm_packet(&sample_sled(), &cold, [-0.5, 1.5, f32::NAN, 0.1], 0), 0.0)
            .unwrap();
        let left: Vec<f32> = f.tyres.unwrap().iter().map(|t| t.left).collect();
        assert!(left[0].is_nan() && left[1].is_nan() && left[2].is_nan());
        assert!(close(left[3], 0.9));
        assert!(f.track.is_empty(), "track ordinal 0 is no track");
    }

    #[test]
    fn gears_pedals_and_steering_in_xpeed_units() {
        let mut d = Decoder::new(Game::Fh5);
        let gear = |d: &mut Decoder, raw: u8| {
            let dash = Dash {
                gear: raw,
                ..sample_dash()
            };
            d.feed(&horizon_packet(&sample_sled(), &dash), 0.0).unwrap().gear
        };
        assert_eq!(gear(&mut d, 0), -1.0, "0 is reverse");
        assert_eq!(gear(&mut d, 11), 0.0, "11 is neutral");
        for g in 1..=10u8 {
            assert_eq!(gear(&mut d, g), f32::from(g));
        }
        for raw in [12u8, 100, 255] {
            assert!(gear(&mut d, raw).is_nan(), "gear {raw}");
        }
        let steer = |d: &mut Decoder, raw: i8| {
            let dash = Dash {
                steer: raw,
                ..sample_dash()
            };
            d.feed(&horizon_packet(&sample_sled(), &dash), 0.0).unwrap().steer
        };
        assert_eq!(steer(&mut d, 127), 1.0);
        assert_eq!(steer(&mut d, 0), 0.0);
        assert_eq!(steer(&mut d, -128), -1.0);
        assert!(close(steer(&mut d, 64), 64.0 / 127.0));
        let dash = Dash {
            accel: 0,
            brake: 255,
            clutch: 128,
            ..sample_dash()
        };
        let f = d.feed(&horizon_packet(&sample_sled(), &dash), 0.0).unwrap();
        assert_eq!((f.throttle, f.brake), (0.0, 1.0));
        assert!(close(f.clutch, 128.0 / 255.0));
    }

    #[test]
    fn class_tables() {
        assert_eq!(Game::Fm7.class(0, 350), Some("D 350".into()));
        assert_eq!(Game::Fm7.class(7, 999), Some("X 999".into()));
        assert_eq!(Game::Fm7.class(8, 999), None);
        assert_eq!(Game::Fm.class(0, 250), Some("E 250".into()));
        assert_eq!(Game::Fm.class(8, 999), Some("X 999".into()));
        assert_eq!(Game::Fh5.class(4, 850), Some("S1 850".into()));
        assert_eq!(Game::Fh4.class(6, 999), Some("X 999".into()));
        assert_eq!(Game::Fh4.class(7, 999), None);
        assert_eq!(Game::Fh5.class(-1, 500), None);
        assert_eq!(Game::Fh5.class(2, 0), Some("B".into()), "a PI out of 100..999 is left out");
    }

    // ---- garbled packets ----

    #[test]
    fn garbage_and_truncated_packets_never_panic() {
        let s = sample_sled();
        let d = sample_dash();
        let valid = [
            sled_packet(&s),
            fm7_packet(&s, &d),
            horizon_packet(&s, &d),
            fm_packet(&s, &d, [0.5; 4], 2),
        ];
        let mut decoders: Vec<Decoder> = Game::ALL.into_iter().map(Decoder::new).collect();
        for packet in &valid {
            for cut in 0..packet.len() {
                // A cut that lands on another format's length (311 cut to 232 is a Sled packet) is that packet.
                if Layout::of_len(cut).is_some() {
                    continue;
                }
                for dec in decoders.iter_mut() {
                    assert!(dec.feed(&packet[..cut], 0.0).is_none(), "{cut} bytes");
                }
            }
        }
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (state >> 33) as u8
        };
        for round in 0..400 {
            // Random bytes of a valid length: read as a packet, whatever comes out stays in range.
            let len = valid[round % valid.len()].len();
            let junk: Vec<u8> = (0..len).map(|_| next()).collect();
            for dec in decoders.iter_mut() {
                if let Some(f) = dec.feed(&junk, round as f64 * 0.01) {
                    assert!(f.throttle.is_nan() || (0.0..=1.0).contains(&f.throttle));
                    assert!(f.steer.is_nan() || (-1.0..=1.0).contains(&f.steer));
                    assert!(f.speed_ms.is_nan() || (0.0..=200.0).contains(&f.speed_ms));
                    assert!(f.dist_m.is_none_or(|m| m >= 0.0));
                    assert!(f.fuel_l.is_nan());
                }
            }
            let noise: Vec<u8> = (0..usize::from(next()) * 3).map(|_| next()).collect();
            for dec in decoders.iter_mut() {
                dec.feed(&noise, 0.0);
            }
        }
    }

    // ---- which game ----

    #[test]
    fn the_running_program_names_the_game() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            Game::running(&names(&["explorer.exe", "forza_steamworks_release_final.exe"])),
            Some(Game::Fm)
        );
        assert_eq!(
            Game::running(&names(&["forza_gaming.desktop.x64_release_final.exe"])),
            Some(Game::Fm)
        );
        assert_eq!(Game::running(&names(&["forzamotorsport7.exe"])), Some(Game::Fm7));
        assert_eq!(Game::running(&names(&["forzahorizon4.exe"])), Some(Game::Fh4));
        assert_eq!(Game::running(&names(&["forzahorizon5.exe"])), Some(Game::Fh5));
        assert_eq!(Game::running(&names(&["forzahorizon6.exe"])), Some(Game::Fh6));
        assert_eq!(Game::running(&names(&["f1_25.exe", "acs.exe"])), None);
        assert_eq!(Game::running(&[]), None);
        for (game, id, name) in [
            (Game::Fm, "fm", "Forza Motorsport"),
            (Game::Fm7, "fm7", "Forza Motorsport 7"),
            (Game::Fh4, "fh4", "Forza Horizon 4"),
            (Game::Fh5, "fh5", "Forza Horizon 5"),
            (Game::Fh6, "fh6", "Forza Horizon 6"),
        ] {
            assert_eq!((game.id(), game.name()), (id, name));
        }
    }

    #[test]
    fn the_reader_list_has_every_program_and_id() {
        let reader = crate::games::READERS
            .iter()
            .find(|r| r.family == "forza")
            .expect("a forza line in READERS");
        assert_eq!(reader.title, "Forza Motorsport · Forza Horizon");
        assert_eq!(reader.ids, ["fm", "fm7", "fh4", "fh5", "fh6"]);
        let mut wanted: Vec<&str> = Game::ALL.iter().flat_map(|g| g.programs().iter().copied()).collect();
        let mut listed = reader.programs.to_vec();
        wanted.sort_unstable();
        listed.sort_unstable();
        assert_eq!(listed, wanted);
        assert!(listed.iter().all(|p| *p == p.to_lowercase()));
        for game in Game::ALL {
            assert!(reader.ids.contains(&game.id()));
        }
    }

    // ---- the socket ----

    fn loopback_pair(game: Game) -> (ForzaSource, UdpSocket) {
        let source = ForzaSource::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), game).expect("an ephemeral loopback port is free");
        let sender = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        sender.connect(source.local_addr()).unwrap();
        (source, sender)
    }

    #[test]
    fn identifies_itself_and_does_not_share_the_f1_port() {
        let (source, _) = loopback_pair(Game::Fh5);
        assert_eq!((source.game_id(), source.game_name()), ("fh5", "Forza Horizon 5"));
        assert!(source.alive());
        assert_eq!(DEFAULT_PORT, 5301);
        assert_ne!(DEFAULT_PORT, crate::games::f1::DEFAULT_PORT);
    }

    #[test]
    fn says_nothing_until_packets_come() {
        let (mut source, _sender) = loopback_pair(Game::Fm);
        let started = Instant::now();
        assert!(source.next(Duration::from_millis(30)).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(source.alive());
    }

    #[test]
    fn a_busy_port_gives_no_source() {
        let (first, _) = loopback_pair(Game::Fm);
        assert!(ForzaSource::bind(first.local_addr(), Game::Fm).is_none());
    }

    #[test]
    fn gives_a_frame_for_each_packet_over_udp_and_survives_junk() {
        let (mut source, sender) = loopback_pair(Game::Fm7);
        sender.send(b"not a packet at all").unwrap();
        // A datagram longer than the buffer (Windows refuses it with "message too long"): not a reason to close.
        sender.send(&vec![7u8; 4000]).unwrap();
        sender.send(&horizon_packet(&sample_sled(), &sample_dash())).unwrap();
        sender.send(&fm7_packet(&sample_sled(), &sample_dash())).unwrap();
        let f = source.next(Duration::from_millis(500)).expect("a frame");
        assert!(f.driving);
        assert_eq!(f.speed_ms, 50.0);
        assert_eq!(f.car, "Car #2352");
        assert!(source.alive());
        sender.send(&fm7_packet(&sample_sled(), &sample_dash())).unwrap();
        let g = source.next(Duration::from_millis(500)).expect("another frame");
        assert!(g.clock_s >= f.clock_s);
        assert!(source.next(Duration::from_millis(10)).is_none());
        assert!(source.alive());
    }

    /// A scripted race over loopback, cut into a lap file by the real lap cutter.
    #[test]
    fn a_lap_flows_from_udp_to_the_lap_cutter() {
        let (mut source, sender) = loopback_pair(Game::Fm);
        let mut cutter = LapCutter::new(source.game_id());
        let mut laps = Vec::new();
        let s = sample_sled();
        let tick = |source: &mut ForzaSource, lap_number: u16, lap_t: f32, last: f32, race_t: f32, distance: f32| {
            let dash = Dash {
                lap_number,
                current: lap_t,
                last,
                race_time: race_t,
                distance,
                pos: [distance, 1.0, -distance],
                ..sample_dash()
            };
            sender.send(&fm_packet(&s, &dash, [0.1; 4], 860)).unwrap();
            source.next(Duration::from_millis(500)).expect("a frame for every packet")
        };
        // Lap 1 (LapNumber 0): 6.5 s at 20 Hz from 1000 m on the session's distance, then the line.
        for i in 0..130u16 {
            let t = f32::from(i) * 0.05;
            let f = tick(&mut source, 0, t, 0.0, t, 1000.0 + t * 50.0);
            assert!(f.driving && f.lap == 1);
            laps.extend(cutter.on_frame(&f, 1_794_312_000_000 + i64::from(i) * 50));
        }
        assert!(laps.is_empty(), "a lap is not done before the next one starts");
        for i in 0..4u16 {
            let t = f32::from(i) * 0.05;
            let f = tick(&mut source, 1, t, 6.5, 6.5 + t, 1325.0 + t * 50.0);
            assert_eq!(
                (f.lap, f.last_lap_s, f.dist_m.map(|m| m.round())),
                (2, Some(6.5), Some(f64::from(t * 50.0).round()))
            );
            laps.extend(cutter.on_frame(&f, 1_794_312_006_500 + i64::from(i) * 50));
        }
        assert_eq!(laps.len(), 1, "exactly one lap");
        let lap = &laps[0];
        assert_eq!(lap.game, "fm");
        assert_eq!(lap.lap_number, 1);
        assert_eq!(lap.time_ms, 6500, "the game's own time");
        assert!(lap.valid);
        assert_eq!(lap.track_name, "Track #860");
        assert_eq!(lap.car_name, "Car #2352");
        assert_eq!(lap.car_class.as_deref(), Some("B 600"));
        assert_eq!(lap.sample_count(), 130);
        let dist = lap.channel("dist").expect("a distance");
        assert_eq!(dist.values[0], 0.0);
        assert!(
            (dist.values.last().unwrap() - 129.0 * 0.05 * 50.0).abs() < 0.5,
            "{}",
            dist.values.last().unwrap()
        );
        for id in [
            "t", "dist", "speed", "rpm", "gear", "throttle", "brake", "clutch", "steer", "x", "y", "z",
        ] {
            assert!(lap.channel(id).is_some(), "channel {id}");
        }
        assert!(lap.channel("fuel").is_none(), "the game gives no fuel in litres");
    }
}
