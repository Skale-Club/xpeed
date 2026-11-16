//! Capturing what a reader sees, to play it back later (`replay.rs`).
//!
//! Every convention a reader has to guess (the direction of the clutch, the sign of the steering, the numbering of the
//! laps) was written from documents and found wrong only by driving. `xpeed-companion capture GAME` records exactly
//! the bytes the reader is given while a person drives, into a small `.xcap` file; `replay` runs those bytes through the
//! same parsing code, the lap cutter and the data checks, as often as needed, with nobody at the wheel. A capture of a
//! few minutes becomes a permanent regression fixture (`fixtures/README.md`).
//!
//! ## What is recorded
//!
//! * Shared-memory games (Assetto Corsa and its family, Assetto Corsa EVO, Automobilista 2, Project CARS, Stock Car
//!   Extreme and the other rFactor 1 games, iRacing, RaceRoom): every copy the reader takes of a page (`Mapping::read`)
//!   and the name and size of every memory it opens (`Mapping::open`). The reader is the real one, so what is written is
//!   what it read, byte for byte. A copy equal to the last copy of the same place is not written again.
//! * UDP games (F1, Forza, Wreckfest 2): every datagram the reader's socket receives.
//! * Le Mans Ultimate: every range the reader copies out of the game's memory (the header, the player's telemetry, the
//!   scoring), which together make the buffer its snapshots are parsed from.
//!
//! The recording is made by taps in the code paths that read (`tap_open`, `tap_read`, `tap_datagram`, `tap_lmu`). They
//! do nothing unless a capture runs on the same thread (a thread-local check), so the tray app is not slowed.
//!
//! ## The file
//!
//! A `.xcap` is one gzip stream. Inside it:
//!
//! ```text
//! "XCAP" 0x01                          magic and format version
//! u32 LE length, then that many bytes  the header: a JSON object (see `Header`)
//! records, until the end:
//!   0x00 varint id, varint n, n bytes  a stream is named (before its first use)
//!   0x01 varint id, varint dt, varint n, n bytes
//!                                      data for a stream, `dt` ms after the last record
//!   0x02 varint dt                     a tick: the reader was asked for a reading once; the data that follows, up to
//!                                      the next tick, is what it read while answering
//! ```
//!
//! Streams are named `open:NAME` (the payload is the size of the memory, 8 bytes), `mem:NAME@AT+LEN` (a copy of LEN bytes
//! at AT of the memory NAME), `udp` (one datagram), `lmu@AT+LEN` (a range of Le Mans Ultimate's memory) and, as id 0,
//! `tick`. The payload of every stream but `udp` is a difference from the last copy of the same stream: byte 0 is `0`
//! (the whole copy follows) or `1` (a count of runs, each a gap from the end of the previous run, a length and the new
//! bytes). Gzip does the rest, so a ten-minute drive is some megabytes.
//!
//! A logical record is `{t_ms, stream, bytes}`: time in milliseconds since the capture began, the stream and the whole
//! copy (the differences are undone by the `Reader`).
//!
//! ## Limits
//!
//! The tray app must be paused or closed while a UDP game is captured: the capture opens the game's UDP port like the
//! reader does, and only one program can hold it. A shared memory can be read by both at once.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::game::{Phase, Source};

const MAGIC: &[u8; 4] = b"XCAP";
const FORMAT: u8 = 1;
const TAG_STREAM: u8 = 0;
const TAG_DATA: u8 = 1;
const TAG_TICK: u8 = 2;
/// The id of the tick stream: records with it carry no bytes, only the time.
pub const TICK: u32 = 0;
/// Unchanged bytes shorter than this between two changed runs are written with them (a new run costs a few bytes).
const MERGE_GAP: usize = 4;
/// The biggest header or record this reader believes (a corrupt file must not ask for gigabytes).
const MAX_BLOCK: usize = 64 * 1024 * 1024;

// ---- what a stream is -----------------------------------------------------------------------------------------

/// What a stream's name says it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Tick,
    /// A memory the reader opened: the payload is its size (8 bytes, little endian).
    Open(String),
    /// A copy of `len` bytes at `at` of the memory `name`.
    Mem {
        name: String,
        at: usize,
        len: usize,
    },
    /// One datagram.
    Udp,
    /// A range of Le Mans Ultimate's memory.
    Lmu {
        at: usize,
        len: usize,
    },
    /// A name this version does not know (a newer capture): skipped by the replay.
    Other,
}

pub fn open_stream(name: &str) -> String {
    format!("open:{name}")
}

pub fn mem_stream(name: &str, at: usize, len: usize) -> String {
    format!("mem:{name}@{at}+{len}")
}

pub fn lmu_stream(at: usize, len: usize) -> String {
    format!("lmu@{at}+{len}")
}

fn at_len(text: &str) -> Option<(usize, usize)> {
    let (at, len) = text.split_once('+')?;
    Some((at.parse().ok()?, len.parse().ok()?))
}

impl Kind {
    pub fn parse(name: &str) -> Kind {
        if name == "tick" {
            Kind::Tick
        } else if name == "udp" {
            Kind::Udp
        } else if let Some(memory) = name.strip_prefix("open:") {
            Kind::Open(memory.to_owned())
        } else if let Some(rest) = name.strip_prefix("mem:") {
            rest.rsplit_once('@')
                .and_then(|(memory, place)| {
                    at_len(place).map(|(at, len)| Kind::Mem {
                        name: memory.to_owned(),
                        at,
                        len,
                    })
                })
                .unwrap_or(Kind::Other)
        } else if let Some(place) = name.strip_prefix("lmu@") {
            at_len(place).map_or(Kind::Other, |(at, len)| Kind::Lmu { at, len })
        } else {
            Kind::Other
        }
    }

    /// Whether a payload is a difference from the last copy of the same stream.
    fn is_diff(&self) -> bool {
        matches!(self, Kind::Open(_) | Kind::Mem { .. } | Kind::Lmu { .. })
    }
}

// ---- the header -----------------------------------------------------------------------------------------------

/// Who and what the capture is of. The replay needs `family` and `game` to open the right reader.
#[derive(Clone, Debug, PartialEq)]
pub struct Header {
    /// The game's id as the lap files write it (`"acevo"`, `"f124"`, `"lmu"`).
    pub game: String,
    /// The reader's family (`games::READERS`), or `"lmu"`.
    pub family: String,
    /// The version of Xpeed Companion that recorded it.
    pub companion: String,
    /// The game's build, when the person said (`--build`) or the reader knows. Free text.
    pub game_build: Option<String>,
    /// When the capture began, ISO 8601 UTC and Unix milliseconds.
    pub started_at: String,
    pub started_unix_ms: i64,
}

impl Header {
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "format": FORMAT,
            "game": self.game,
            "family": self.family,
            "companion": self.companion,
            "game_build": self.game_build,
            "started_at": self.started_at,
            "started_unix_ms": self.started_unix_ms,
        })
        .to_string()
    }

    pub fn from_json(text: &str) -> Result<Header, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("the header is not JSON: {e}"))?;
        let text_of = |key: &str| v.get(key).and_then(|x| x.as_str()).map(str::to_owned);
        let need = |key: &str| text_of(key).ok_or_else(|| format!("the header has no {key}"));
        Ok(Header {
            game: need("game")?,
            family: need("family")?,
            companion: text_of("companion").unwrap_or_default(),
            game_build: text_of("game_build"),
            started_at: text_of("started_at").unwrap_or_default(),
            started_unix_ms: v.get("started_unix_ms").and_then(serde_json::Value::as_i64).unwrap_or(0),
        })
    }
}

// ---- varints and differences ----------------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// `Ok(None)` at a clean end of the input (no byte read), an error in the middle of a number.
fn read_varint(r: &mut impl Read) -> io::Result<Option<u64>> {
    let (mut v, mut shift) = (0u64, 0u32);
    let mut first = true;
    loop {
        let mut b = [0u8; 1];
        match r.read(&mut b)? {
            0 if first => return Ok(None),
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            _ => {}
        }
        first = false;
        v |= u64::from(b[0] & 0x7f) << shift;
        if b[0] & 0x80 == 0 {
            return Ok(Some(v));
        }
        shift += 7;
        if shift > 63 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "a number is too long"));
        }
    }
}

fn bad(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

/// The payload that turns `prev` into `new`: the whole copy, or the runs that changed, whichever is shorter.
fn encode_diff(prev: Option<&[u8]>, new: &[u8]) -> Vec<u8> {
    let full = || {
        let mut out = Vec::with_capacity(new.len() + 1);
        out.push(0);
        out.extend_from_slice(new);
        out
    };
    let Some(prev) = prev.filter(|p| p.len() == new.len()) else {
        return full();
    };
    let n = new.len();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < n {
        if prev[i] == new[i] {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        let mut j = end;
        while j < n && j - end < MERGE_GAP {
            if prev[j] != new[j] {
                end = j + 1;
            }
            j += 1;
        }
        runs.push((start, end));
        i = end;
    }
    let mut out = vec![1];
    put_varint(&mut out, runs.len() as u64);
    let mut last_end = 0;
    for (start, end) in runs {
        put_varint(&mut out, (start - last_end) as u64);
        put_varint(&mut out, (end - start) as u64);
        out.extend_from_slice(&new[start..end]);
        last_end = end;
        if out.len() > n {
            return full();
        }
    }
    out
}

fn decode_diff(prev: Option<&[u8]>, payload: &[u8]) -> io::Result<Vec<u8>> {
    match payload.first() {
        Some(0) => Ok(payload[1..].to_vec()),
        Some(1) => {
            let mut out = prev.ok_or_else(|| bad("a difference with nothing to apply it to"))?.to_vec();
            let mut cur = &payload[1..];
            let runs = read_varint(&mut cur)?.ok_or_else(|| bad("a difference without its runs"))?;
            let mut at = 0usize;
            for _ in 0..runs {
                let gap = read_varint(&mut cur)?.ok_or_else(|| bad("a run without its gap"))? as usize;
                let len = read_varint(&mut cur)?.ok_or_else(|| bad("a run without its length"))? as usize;
                at = at.checked_add(gap).ok_or_else(|| bad("a run is out of place"))?;
                let end = at
                    .checked_add(len)
                    .filter(|e| *e <= out.len())
                    .ok_or_else(|| bad("a run is out of place"))?;
                let bytes = cur.get(..len).ok_or_else(|| bad("a run is cut short"))?;
                out[at..end].copy_from_slice(bytes);
                cur = &cur[len..];
                at = end;
            }
            Ok(out)
        }
        _ => Err(bad("an unknown way of coding a copy")),
    }
}

// ---- writing --------------------------------------------------------------------------------------------------

/// Counts the bytes that go through to the file (the compressed size).
struct Counting<W> {
    inner: W,
    bytes: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// What a writer did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    /// Data records written.
    pub records: u64,
    /// Copies not written because they equalled the last one of their stream.
    pub unchanged: u64,
    pub ticks: u64,
    /// The size of the file so far (compressed), without what the encoder still holds.
    pub file_bytes: u64,
    /// The bytes of the logical records, before the differences and the compression.
    pub raw_bytes: u64,
}

/// Writes a `.xcap`. Times are given by the caller, in milliseconds since the capture began, and must not go back.
pub struct Writer<W: Write> {
    enc: GzEncoder<Counting<W>>,
    ids: HashMap<String, u32>,
    kinds: Vec<Kind>,
    prev: HashMap<u32, Vec<u8>>,
    last_t: u64,
    tick_wanted: bool,
    stats: Stats,
}

impl<W: Write> Writer<W> {
    pub fn new(out: W, header: &Header) -> io::Result<Writer<W>> {
        let mut enc = GzEncoder::new(Counting { inner: out, bytes: 0 }, Compression::default());
        let json = header.to_json();
        enc.write_all(MAGIC)?;
        enc.write_all(&[FORMAT])?;
        enc.write_all(&(json.len() as u32).to_le_bytes())?;
        enc.write_all(json.as_bytes())?;
        Ok(Writer {
            enc,
            ids: HashMap::new(),
            kinds: vec![Kind::Tick],
            prev: HashMap::new(),
            last_t: 0,
            tick_wanted: false,
            stats: Stats::default(),
        })
    }

    /// The reader was asked for a reading. The tick is written with the first record that follows (so a reading that
    /// changed nothing leaves no trace) and gets that record's time.
    pub fn tick(&mut self) {
        self.tick_wanted = true;
    }

    fn id_of(&mut self, name: &str) -> io::Result<u32> {
        if let Some(id) = self.ids.get(name) {
            return Ok(*id);
        }
        let id = self.kinds.len() as u32;
        self.ids.insert(name.to_owned(), id);
        self.kinds.push(Kind::parse(name));
        let mut rec = vec![TAG_STREAM];
        put_varint(&mut rec, u64::from(id));
        put_varint(&mut rec, name.len() as u64);
        rec.extend_from_slice(name.as_bytes());
        self.enc.write_all(&rec)?;
        Ok(id)
    }

    /// Writes one copy of `bytes` for `stream`. False when it was not written because it equals the last copy.
    pub fn record(&mut self, t_ms: u64, stream: &str, bytes: &[u8]) -> io::Result<bool> {
        let id = self.id_of(stream)?;
        let payload = if self.kinds[id as usize].is_diff() {
            let prev = self.prev.get(&id).map(Vec::as_slice);
            if prev == Some(bytes) {
                self.stats.unchanged += 1;
                return Ok(false);
            }
            encode_diff(prev, bytes)
        } else {
            bytes.to_vec()
        };
        let t = t_ms.max(self.last_t);
        let mut rec = Vec::with_capacity(payload.len() + 16);
        if self.tick_wanted {
            rec.push(TAG_TICK);
            put_varint(&mut rec, t - self.last_t);
            self.last_t = t;
            self.tick_wanted = false;
            self.stats.ticks += 1;
        }
        rec.push(TAG_DATA);
        put_varint(&mut rec, u64::from(id));
        put_varint(&mut rec, t - self.last_t);
        put_varint(&mut rec, payload.len() as u64);
        rec.extend_from_slice(&payload);
        self.last_t = t;
        self.enc.write_all(&rec)?;
        if self.kinds[id as usize].is_diff() {
            self.prev.insert(id, bytes.to_vec());
        }
        self.stats.records += 1;
        self.stats.raw_bytes += bytes.len() as u64;
        Ok(true)
    }

    pub fn stats(&self) -> Stats {
        Stats {
            file_bytes: self.enc.get_ref().bytes,
            ..self.stats
        }
    }

    /// Ends the gzip stream and gives the output back.
    pub fn finish(self) -> io::Result<(W, Stats)> {
        let stats = self.stats;
        let counting = self.enc.finish()?;
        Ok((
            counting.inner,
            Stats {
                file_bytes: counting.bytes,
                ..stats
            },
        ))
    }
}

// ---- reading --------------------------------------------------------------------------------------------------

/// One logical record: the whole copy (differences undone), at a time, for a stream. A tick has `stream == TICK` and no
/// bytes.
#[derive(Clone, Debug, PartialEq)]
pub struct Record {
    pub t_ms: u64,
    pub stream: u32,
    pub bytes: Vec<u8>,
}

/// Reads a `.xcap` record by record, in order, without holding the file in memory.
pub struct Reader {
    dec: GzDecoder<Box<dyn Read>>,
    pub header: Header,
    streams: Vec<(String, Kind)>,
    prev: HashMap<u32, Vec<u8>>,
    t: u64,
    problem: Option<String>,
}

impl Reader {
    pub fn new(input: Box<dyn Read>) -> Result<Reader, String> {
        let mut dec = GzDecoder::new(input);
        let mut head = [0u8; 9];
        dec.read_exact(&mut head)
            .map_err(|e| format!("not a capture file (cannot read its start: {e})"))?;
        if &head[..4] != MAGIC {
            return Err("not a capture file (wrong magic)".into());
        }
        if head[4] != FORMAT {
            return Err(format!("this capture is format {}, this program reads format {FORMAT}", head[4]));
        }
        let n = u32::from_le_bytes(head[5..9].try_into().unwrap()) as usize;
        if n > MAX_BLOCK {
            return Err("the header is too long".into());
        }
        let mut json = vec![0u8; n];
        dec.read_exact(&mut json).map_err(|e| format!("the header is cut short: {e}"))?;
        let header = Header::from_json(&String::from_utf8_lossy(&json))?;
        Ok(Reader {
            dec,
            header,
            streams: vec![("tick".into(), Kind::Tick)],
            prev: HashMap::new(),
            t: 0,
            problem: None,
        })
    }

    #[cfg(test)]
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Reader, String> {
        Reader::new(Box::new(io::Cursor::new(bytes)))
    }

    pub fn from_file(path: &Path) -> Result<Reader, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        Reader::new(Box::new(io::BufReader::new(file)))
    }

    pub fn kind(&self, stream: u32) -> &Kind {
        self.streams.get(stream as usize).map_or(&Kind::Other, |(_, k)| k)
    }

    #[cfg(test)]
    pub fn name(&self, stream: u32) -> &str {
        self.streams.get(stream as usize).map_or("?", |(n, _)| n.as_str())
    }

    /// Why the file ended before its end (a capture that was killed, or a damaged file); `None` for a whole one.
    pub fn problem(&self) -> Option<&str> {
        self.problem.as_deref()
    }

    fn block(&mut self) -> io::Result<Vec<u8>> {
        let n = read_varint(&mut self.dec)?.ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))? as usize;
        if n > MAX_BLOCK {
            return Err(bad("a record is too long"));
        }
        let mut out = vec![0u8; n];
        self.dec.read_exact(&mut out)?;
        Ok(out)
    }

    fn step(&mut self) -> io::Result<Option<Record>> {
        loop {
            let mut tag = [0u8; 1];
            if self.dec.read(&mut tag)? == 0 {
                return Ok(None);
            }
            let eof = || io::Error::from(io::ErrorKind::UnexpectedEof);
            match tag[0] {
                TAG_STREAM => {
                    let id = read_varint(&mut self.dec)?.ok_or_else(eof)? as usize;
                    let name = String::from_utf8_lossy(&self.block()?).into_owned();
                    if id == 0 || id > 1_000_000 {
                        return Err(bad("a stream has an impossible id"));
                    }
                    if self.streams.len() <= id {
                        self.streams.resize(id + 1, (String::new(), Kind::Other));
                    }
                    let kind = Kind::parse(&name);
                    self.streams[id] = (name, kind);
                }
                TAG_TICK => {
                    self.t += read_varint(&mut self.dec)?.ok_or_else(eof)?;
                    return Ok(Some(Record {
                        t_ms: self.t,
                        stream: TICK,
                        bytes: Vec::new(),
                    }));
                }
                TAG_DATA => {
                    let id = read_varint(&mut self.dec)?.ok_or_else(eof)? as u32;
                    self.t += read_varint(&mut self.dec)?.ok_or_else(eof)?;
                    let payload = self.block()?;
                    let bytes = if self.kind(id).is_diff() {
                        let out = decode_diff(self.prev.get(&id).map(Vec::as_slice), &payload)?;
                        self.prev.insert(id, out.clone());
                        out
                    } else {
                        payload
                    };
                    return Ok(Some(Record {
                        t_ms: self.t,
                        stream: id,
                        bytes,
                    }));
                }
                other => return Err(bad(&format!("an unknown record type {other}"))),
            }
        }
    }

    /// The next record; `None` at the end (check `problem` to tell a whole file from a cut one).
    pub fn next_record(&mut self) -> Option<Record> {
        if self.problem.is_some() {
            return None;
        }
        match self.step() {
            Ok(record) => record,
            Err(e) => {
                self.problem = Some(if e.kind() == io::ErrorKind::UnexpectedEof {
                    "the file ends in the middle of a record (the capture was stopped before it was closed)".into()
                } else {
                    e.to_string()
                });
                None
            }
        }
    }
}

// ---- the capture running on this thread, and the taps the readers call ----------------------------------------

enum Clock {
    Real(Instant),
    /// Set by a test.
    #[cfg(test)]
    Manual(u64),
}

struct Session {
    writer: Writer<Box<dyn Write>>,
    clock: Clock,
    error: Option<String>,
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

/// Starts capturing what readers do on this thread into `out`.
pub fn begin(out: Box<dyn Write>, header: &Header) -> io::Result<()> {
    begin_with(out, header, Clock::Real(Instant::now()))
}

fn begin_with(out: Box<dyn Write>, header: &Header, clock: Clock) -> io::Result<()> {
    let writer = Writer::new(out, header)?;
    SESSION.with(|s| {
        *s.borrow_mut() = Some(Session {
            writer,
            clock,
            error: None,
        })
    });
    Ok(())
}

/// Ends the capture of this thread: the file is closed. The first error met while writing, if any, is returned instead
/// of the summary.
pub fn end() -> Result<Stats, String> {
    let session = SESSION.with(|s| s.borrow_mut().take()).ok_or("no capture is running")?;
    if let Some(error) = session.error {
        return Err(error);
    }
    session.writer.finish().map(|(_, stats)| stats).map_err(|e| e.to_string())
}

/// Whether a capture runs on this thread.
#[cfg(test)]
pub fn active() -> bool {
    SESSION.with(|s| s.borrow().is_some())
}

fn with_session(body: impl FnOnce(&mut Session, u64)) {
    SESSION.with(|s| {
        if let Some(session) = s.borrow_mut().as_mut() {
            if session.error.is_some() {
                return;
            }
            let t = match &session.clock {
                Clock::Real(start) => start.elapsed().as_millis() as u64,
                #[cfg(test)]
                Clock::Manual(t) => *t,
            };
            body(session, t);
        }
    });
}

fn put(session: &mut Session, t: u64, stream: &str, bytes: &[u8]) {
    if let Err(e) = session.writer.record(t, stream, bytes) {
        session.error = Some(format!("cannot write the capture: {e}"));
    }
}

/// The reader is about to ask the game for one reading.
pub fn tick() {
    SESSION.with(|s| {
        if let Some(session) = s.borrow_mut().as_mut() {
            session.writer.tick();
        }
    });
}

/// What the capture of this thread has written so far (`None` when none runs).
pub fn progress() -> Option<Stats> {
    SESSION.with(|s| s.borrow().as_ref().map(|session| session.writer.stats()))
}

/// A game's memory was opened (`Mapping::open`).
pub fn tap_open(name: &str, len: usize) {
    with_session(|s, t| put(s, t, &open_stream(name), &(len as u64).to_le_bytes()));
}

/// A copy was taken of a game's memory (`Mapping::read`).
pub fn tap_read(name: &str, at: usize, bytes: &[u8]) {
    with_session(|s, t| put(s, t, &mem_stream(name, at, bytes.len()), bytes));
}

/// A datagram arrived on a reader's socket.
pub fn tap_datagram(bytes: &[u8]) {
    with_session(|s, t| put(s, t, "udp", bytes));
}

/// Le Mans Ultimate's reader copied `bytes` from `at` of the game's memory.
pub fn tap_lmu(at: usize, bytes: &[u8]) {
    with_session(|s, t| put(s, t, &lmu_stream(at, bytes.len()), bytes));
}

/// Sets the time of a capture started with `begin_manual`.
#[cfg(test)]
pub fn set_time(ms: u64) {
    SESSION.with(|s| {
        if let Some(session) = s.borrow_mut().as_mut() {
            session.clock = Clock::Manual(ms);
        }
    });
}

/// Like `begin`, with a clock the test moves (`set_time`).
#[cfg(test)]
pub fn begin_manual(out: Box<dyn Write>, header: &Header) -> io::Result<()> {
    begin_with(out, header, Clock::Manual(0))
}

// ---- the command ----------------------------------------------------------------------------------------------

static STOP: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn on_ctrl(_kind: u32) -> i32 {
    STOP.store(true, Ordering::SeqCst);
    1
}

/// Ctrl+C ends the capture instead of the process, so the file is closed properly.
fn stop_on_ctrl_c() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    unsafe {
        SetConsoleCtrlHandler(Some(on_ctrl), 1);
    }
}

/// What the command saw of the game, for its summary.
#[derive(Default)]
struct Seen {
    frames: u64,
    driving: u64,
    laps_started: u32,
    first_lap: Option<i32>,
    last_lap: Option<i32>,
    last_phase: Option<Phase>,
}

impl Seen {
    fn frame(&mut self, f: &crate::game::Frame) {
        self.frames += 1;
        self.last_phase = Some(f.phase);
        if f.driving && f.lap > 0 {
            self.driving += 1;
            self.first_lap.get_or_insert(f.lap);
            if self.last_lap.is_some_and(|l| f.lap > l) {
                self.laps_started += 1;
            }
            self.last_lap = Some(f.lap);
        }
    }

    fn lap_text(&self) -> String {
        match (self.first_lap, self.last_lap) {
            (Some(a), Some(b)) => format!("{} lap change(s), lap numbers {a} to {b}", self.laps_started),
            _ => "none (the car was never on track)".into(),
        }
    }
}

pub struct Request {
    pub game: String,
    pub seconds: u64,
    pub out: Option<PathBuf>,
    pub build: Option<String>,
}

/// What `capture GAME` can be given.
fn games_text() -> String {
    let mut names: Vec<&str> = vec!["lmu"];
    for r in crate::games::READERS {
        names.extend(r.ids.iter().copied());
    }
    names.join(", ")
}

enum Target {
    Lmu,
    Reader(&'static crate::games::Reader),
}

fn target_of(game: &str) -> Option<(Target, String)> {
    let game = game.trim().to_ascii_lowercase();
    if game == "lmu" {
        return Some((Target::Lmu, "lmu".into()));
    }
    crate::games::READERS
        .iter()
        .find(|r| r.family == game || r.ids.iter().any(|id| *id == game))
        .map(|r| (Target::Reader(r), if r.family == game { r.ids[0].to_owned() } else { game.clone() }))
}

fn out_path(request: &Request, game: &str) -> PathBuf {
    request.out.clone().unwrap_or_else(|| {
        let stamp: String = crate::util::iso_utc(crate::util::now_ms())
            .chars()
            .filter(char::is_ascii_digit)
            .take(14)
            .collect();
        PathBuf::from(format!("{game}-{stamp}.xcap"))
    })
}

fn header_for(request: &Request, game: &str, family: &str) -> Header {
    let now = crate::util::now_ms();
    Header {
        game: game.to_owned(),
        family: family.to_owned(),
        companion: env!("CARGO_PKG_VERSION").to_owned(),
        game_build: request.build.clone(),
        started_at: crate::util::iso_utc(now),
        started_unix_ms: now,
    }
}

fn fail(message: impl std::fmt::Display) -> ExitCode {
    eprintln!("{message}");
    ExitCode::from(1)
}

/// Waits for the game to be there (its memory shared, its port free): `None` after `wait`, or when stopped.
fn open_waiting(reader: &crate::games::Reader, wait: Duration) -> Option<Box<dyn Source>> {
    let until = Instant::now() + wait;
    let mut said = false;
    while !STOP.load(Ordering::SeqCst) {
        if let Some(source) = (reader.open)() {
            return Some(source);
        }
        if Instant::now() >= until {
            return None;
        }
        if !said {
            println!("Waiting for {} (up to {} s; Ctrl+C to give up)...", reader.title, wait.as_secs());
            said = true;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}

const WAIT_FOR_GAME: Duration = Duration::from_secs(120);

pub fn command(request: &Request) -> ExitCode {
    let Some((target, game)) = target_of(&request.game) else {
        return fail(format!("unknown game {:?}. Games: {}", request.game, games_text()));
    };
    stop_on_ctrl_c();
    let path = out_path(request, &game);
    let part = PathBuf::from(format!("{}.part", path.display()));
    let file = match std::fs::File::create(&part) {
        Ok(file) => file,
        Err(e) => return fail(format!("cannot create {}: {e}", part.display())),
    };
    let result = match target {
        Target::Lmu => capture_lmu(request, &game, file),
        Target::Reader(reader) => capture_reader(request, reader, &game, file),
    };
    let (stats, seen, seconds, name) = match result {
        Ok(done) => done,
        Err(why) => {
            let _ = std::fs::remove_file(&part);
            return fail(why);
        }
    };
    if let Err(e) = std::fs::rename(&part, &path) {
        return fail(format!("cannot rename {} to {}: {e}", part.display(), path.display()));
    }
    println!();
    println!("Captured {name} for {seconds:.1} s into {}", path.display());
    println!(
        "  {} records in {} readings, {} copies unchanged and skipped; {:.1} MB raw, {:.2} MB on disk",
        stats.records,
        stats.ticks,
        stats.unchanged,
        stats.raw_bytes as f64 / 1e6,
        stats.file_bytes as f64 / 1e6
    );
    println!("  frames {} (driving {}), laps: {}", seen.frames, seen.driving, seen.lap_text());
    if seen.driving == 0 {
        println!("  The car was never on track: a fixture needs an out lap, two clean laps, a pause and a pit entry.");
    }
    println!("Next: xpeed-companion replay {}", path.display());
    ExitCode::SUCCESS
}

type Done = (Stats, Seen, f64, String);

fn capture_reader(request: &Request, reader: &crate::games::Reader, game: &str, file: std::fs::File) -> Result<Done, String> {
    // Opened once to learn which game it is (a reader may say after looking at the game), then again with the capture on,
    // so that what the reader does while opening is in the file too.
    let probe = open_waiting(reader, WAIT_FOR_GAME).ok_or_else(|| {
        format!(
            "{} is not there: no shared memory to read{} (for a UDP game, pause or close the Xpeed Companion tray app first: only one program can hold the port)",
            reader.title,
            if STOP.load(Ordering::SeqCst) { " (stopped)" } else { "" }
        )
    })?;
    let game_id = if reader.ids.contains(&game) { game } else { probe.game_id() };
    let name = probe.game_name().to_owned();
    let listens = probe.listens();
    let header = header_for(request, game_id, reader.family);
    drop(probe);
    begin(Box::new(io::BufWriter::new(file)), &header).map_err(|e| e.to_string())?;
    let finish = |seen: Seen, seconds: f64, name: String| end().map(|stats| (stats, seen, seconds, name));
    let Some(mut source) = open_waiting(reader, Duration::from_secs(20)) else {
        let _ = end();
        return Err(format!("{} went away before the capture could start", reader.title));
    };
    println!(
        "Capturing {name} for up to {} s. Drive: an out lap, two clean laps, a pause, a pit entry. Ctrl+C ends it early.",
        request.seconds
    );
    if listens {
        println!("(UDP game: the tray app must not be reading the same port.)");
    }
    let started = Instant::now();
    let (mut seen, mut last_say, mut reopen_until) = (Seen::default(), Instant::now(), None::<Instant>);
    while !STOP.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(request.seconds) {
        tick();
        if let Some(frame) = source.next(Duration::from_millis(50)) {
            seen.frame(&frame);
        }
        if !source.alive() {
            // The reader gave up (the game closed, or went quiet): look again for a while before ending.
            let until = *reopen_until.get_or_insert_with(|| Instant::now() + Duration::from_secs(30));
            if Instant::now() >= until {
                println!("The game went away; ending the capture.");
                break;
            }
            match (reader.open)() {
                Some(again) => {
                    source = again;
                    reopen_until = None;
                }
                None => std::thread::sleep(Duration::from_millis(250)),
            }
        } else {
            reopen_until = None;
        }
        if last_say.elapsed() >= Duration::from_secs(5) {
            last_say = Instant::now();
            println!(
                "  {:>4.0} s  frames {}  lap {}  {}  ({:.1} MB so far)",
                started.elapsed().as_secs_f64(),
                seen.frames,
                seen.last_lap.map_or("-".into(), |l| l.to_string()),
                seen.last_phase.map_or("", phase_word),
                progress().map_or(0.0, |s| s.file_bytes as f64 / 1e6)
            );
        }
    }
    finish(seen, started.elapsed().as_secs_f64(), name)
}

fn phase_word(phase: Phase) -> &'static str {
    match phase {
        Phase::Driving => "driving",
        Phase::Paused => "paused",
        Phase::Menu => "menu",
        Phase::Garage => "garage",
        Phase::Replay => "replay",
        Phase::Spectating => "spectating",
        Phase::Loading => "loading",
        Phase::Unknown => "unknown",
    }
}

fn capture_lmu(request: &Request, game: &str, file: std::fs::File) -> Result<Done, String> {
    use crate::lmu::reader::{LmuReader, Names, OpenError};
    let until = Instant::now() + WAIT_FOR_GAME;
    let mut said = false;
    let header = header_for(request, game, "lmu");
    begin(Box::new(io::BufWriter::new(file)), &header).map_err(|e| e.to_string())?;
    let mut reader = loop {
        match LmuReader::open(&Names::lmu()) {
            Ok(reader) => break reader,
            Err(OpenError::NotRunning) if Instant::now() < until && !STOP.load(Ordering::SeqCst) => {
                if !said {
                    println!("Waiting for Le Mans Ultimate ('Enable external plugins' must be on)...");
                    said = true;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(error) => {
                let _ = end();
                return Err(crate::engine::explain(&error));
            }
        }
    };
    tap_open("LMU_Data", reader.mapped_bytes());
    println!(
        "Capturing Le Mans Ultimate for up to {} s. Drive: an out lap, two clean laps, a pause, a pit entry. Ctrl+C ends it early.",
        request.seconds
    );
    let started = Instant::now();
    let (mut seen, mut last_say) = (Seen::default(), Instant::now());
    while !STOP.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(request.seconds) {
        if !reader.wait_frame(200) {
            continue;
        }
        tick();
        if let Some(snapshot) = reader.read() {
            if let Some(t) = snapshot.telemetry {
                let mut f = crate::game::Frame::empty();
                f.set_phase(Phase::Driving);
                f.lap = t.lap_number;
                seen.frame(&f);
            }
        }
        if last_say.elapsed() >= Duration::from_secs(5) {
            last_say = Instant::now();
            println!(
                "  {:>4.0} s  readings {}  lap {}  ({:.1} MB so far)",
                started.elapsed().as_secs_f64(),
                seen.frames,
                seen.last_lap.map_or("-".into(), |l| l.to_string()),
                progress().map_or(0.0, |s| s.file_bytes as f64 / 1e6)
            );
        }
    }
    end().map(|stats| (stats, seen, started.elapsed().as_secs_f64(), "Le Mans Ultimate".into()))
}

/// What other modules' tests need to make a capture in memory.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A sink a test can read back after the capture closed it.
    #[derive(Clone, Default)]
    pub struct Shared(pub Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    pub fn header(game: &str, family: &str) -> Header {
        Header {
            game: game.into(),
            family: family.into(),
            companion: "test".into(),
            game_build: Some("build 1".into()),
            started_at: "2026-11-16T10:00:00Z".into(),
            started_unix_ms: 1_794_000_000_000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{header, Shared};
    use super::*;
    use crate::shm::{FakeMemory, Mapping};

    fn read_all(bytes: Vec<u8>) -> (Header, Vec<(Record, String)>, Option<String>) {
        let mut reader = Reader::from_bytes(bytes).unwrap();
        let mut out = Vec::new();
        while let Some(r) = reader.next_record() {
            let name = reader.name(r.stream).to_owned();
            out.push((r, name));
        }
        (reader.header.clone(), out, reader.problem().map(str::to_owned))
    }

    #[test]
    fn the_header_survives_the_file() {
        let sink = Shared::default();
        let w = Writer::new(sink.clone(), &header("acevo", "acevo")).unwrap();
        w.finish().unwrap();
        let (h, records, problem) = read_all(sink.0.lock().unwrap().clone());
        assert_eq!(h, header("acevo", "acevo"));
        assert!(records.is_empty() && problem.is_none());
    }

    #[test]
    fn copies_come_back_whole_in_order_and_an_unchanged_copy_is_not_written() {
        let sink = Shared::default();
        let mut w = Writer::new(sink.clone(), &header("ac", "kunos")).unwrap();
        let page = vec![7u8; 600];
        let mut changed = page.clone();
        changed[10] = 99;
        changed[11] = 98;
        changed[500] = 1;
        w.tick();
        assert!(w.record(5, "mem:acpmf_physics@0+600", &page).unwrap());
        w.tick();
        assert!(!w.record(9, "mem:acpmf_physics@0+600", &page).unwrap(), "equal to the last copy");
        w.tick();
        assert!(w.record(12, "mem:acpmf_physics@0+600", &changed).unwrap());
        w.record(12, "udp", b"abc").unwrap();
        w.record(13, "udp", b"abc").unwrap();
        let stats = w.stats();
        assert_eq!((stats.records, stats.unchanged, stats.ticks), (4, 1, 2));
        let (_, _) = w.finish().map(|(_, s)| ((), s)).unwrap();
        let (_, records, problem) = read_all(sink.0.lock().unwrap().clone());
        assert!(problem.is_none());
        let seen: Vec<(u64, &str, usize)> = records.iter().map(|(r, n)| (r.t_ms, n.as_str(), r.bytes.len())).collect();
        assert_eq!(
            seen,
            [
                (5, "tick", 0),
                (5, "mem:acpmf_physics@0+600", 600),
                (12, "tick", 0),
                (12, "mem:acpmf_physics@0+600", 600),
                (12, "udp", 3),
                (13, "udp", 3),
            ]
        );
        assert_eq!(records[1].0.bytes, page);
        assert_eq!(records[3].0.bytes, changed, "the difference is undone");
    }

    #[test]
    fn a_page_that_changes_a_little_costs_a_little() {
        let sink = Shared::default();
        let mut w = Writer::new(sink.clone(), &header("ac", "kunos")).unwrap();
        let mut page = vec![0u8; 2000];
        let mut rng = 12345u32;
        for t in 0..2000u64 {
            rng = rng.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            // Three floats move per reading, like a car's speed, position and pedals.
            for k in 0..3 {
                let at = (k * 600 + 4) as usize;
                page[at..at + 4].copy_from_slice(&(rng.wrapping_add(k as u32)).to_le_bytes());
            }
            w.tick();
            w.record(t * 3, "mem:acpmf_physics@0+2000", &page).unwrap();
        }
        let raw = w.stats().raw_bytes;
        let (_, stats) = w.finish().unwrap();
        assert!(stats.file_bytes * 40 < raw, "{} B on disk for {raw} B read", stats.file_bytes);
        // And it still reads back to the last copy.
        let (_, records, _) = read_all(sink.0.lock().unwrap().clone());
        assert_eq!(records.last().unwrap().0.bytes, page);
    }

    #[test]
    fn a_file_cut_short_gives_what_it_has_and_says_so() {
        let sink = Shared::default();
        let mut w = Writer::new(sink.clone(), &header("ac", "kunos")).unwrap();
        for t in 0..50u64 {
            w.tick();
            let page: Vec<u8> = (0..4000u32).map(|i| (i as u64 * 31 + t * 7) as u8 ^ (i >> 3) as u8).collect();
            w.record(t, "mem:x@0+4000", &page).unwrap();
        }
        w.finish().unwrap();
        let whole = sink.0.lock().unwrap().clone();
        let (_, all, problem) = read_all(whole.clone());
        assert!(problem.is_none());
        let (_, some, problem) = read_all(whole[..whole.len() / 2].to_vec());
        assert!(problem.is_some() && !some.is_empty() && some.len() < all.len());
    }

    #[test]
    fn what_is_not_a_capture_is_refused() {
        assert!(Reader::from_bytes(b"hello".to_vec()).is_err());
        let sink = Shared::default();
        let mut enc = GzEncoder::new(sink.clone(), Compression::default());
        enc.write_all(b"NOPE\x01\0\0\0\0").unwrap();
        enc.finish().unwrap();
        let err = Reader::from_bytes(sink.0.lock().unwrap().clone()).err().unwrap();
        assert!(err.contains("magic"), "{err}");
    }

    #[test]
    fn stream_names_say_what_they_are() {
        assert_eq!(
            Kind::parse(&mem_stream("Local\\x@y", 8, 16)),
            Kind::Mem {
                name: "Local\\x@y".into(),
                at: 8,
                len: 16
            }
        );
        assert_eq!(Kind::parse(&open_stream("acpmf_static")), Kind::Open("acpmf_static".into()));
        assert_eq!(Kind::parse(&lmu_stream(100, 40)), Kind::Lmu { at: 100, len: 40 });
        assert_eq!(
            (Kind::parse("udp"), Kind::parse("tick"), Kind::parse("what")),
            (Kind::Udp, Kind::Tick, Kind::Other)
        );
    }

    #[test]
    fn the_taps_record_what_a_reader_reads_and_nothing_when_no_capture_runs() {
        let fake = FakeMemory::new("tap", 4096);
        fake.write(0, &42i32.to_le_bytes());
        // No capture on this thread: nothing happens and nothing breaks.
        assert!(!active());
        let before = Mapping::open(&fake.name).unwrap();
        assert!(before.read(0, 4).is_some());
        drop(before);

        let sink = Shared::default();
        begin_manual(Box::new(sink.clone()), &header("ac", "kunos")).unwrap();
        assert!(active());
        set_time(100);
        let mapping = Mapping::open(&fake.name).unwrap();
        tick();
        set_time(110);
        let first = mapping.read(0, 8).unwrap();
        mapping.read(0, 8).unwrap();
        tick();
        fake.write(4, &7i32.to_le_bytes());
        set_time(120);
        let second = mapping.read(0, 8).unwrap();
        tap_datagram(b"packet");
        let stats = end().unwrap();
        assert!(!active());
        assert_eq!((stats.records, stats.unchanged, stats.ticks), (4, 1, 2));
        let (_, records, problem) = read_all(sink.0.lock().unwrap().clone());
        assert!(problem.is_none());
        let want = [
            (100, open_stream(&fake.name)),
            (110, "tick".into()),
            (110, mem_stream(&fake.name, 0, 8)),
            (120, "tick".into()),
            (120, mem_stream(&fake.name, 0, 8)),
            (120, "udp".into()),
        ];
        let got: Vec<(u64, String)> = records.iter().map(|(r, n)| (r.t_ms, n.clone())).collect();
        // The `open:` record comes before the first tick.
        assert_eq!(got.len(), want.len());
        assert_eq!(got[0], want[0]);
        assert_eq!(got[2], want[2]);
        assert_eq!(records[2].0.bytes, first);
        assert_eq!(records[4].0.bytes, second);
        assert_eq!(records[0].0.bytes, 4096u64.to_le_bytes());
    }

    #[test]
    fn a_target_is_found_by_game_or_family() {
        for (given, game) in [
            ("lmu", "lmu"),
            ("ac", "ac"),
            ("kunos", "ac"),
            ("acevo", "acevo"),
            ("f124", "f124"),
            ("ForzA", "fm"),
        ] {
            let (_, id) = target_of(given).unwrap_or_else(|| panic!("{given}"));
            assert_eq!(id, game, "{given}");
        }
        assert!(target_of("nothing").is_none());
        assert!(games_text().contains("acevo") && games_text().starts_with("lmu"));
    }
}
