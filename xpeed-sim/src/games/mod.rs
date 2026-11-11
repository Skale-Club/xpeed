//! The readers for every game other than Le Mans Ultimate (which has its own, in `lmu/`). Each one opens the door its
//! game offers (shared memory, or UDP the game sends to this computer) and turns what it reads into `Frame`s
//! (`game.rs`); the engine feeds those to a lap cutter (`lapcut.rs`) and writes the laps.
//!
//! A reader is tried again every few seconds until its game is there. A reader that cannot be sure of its layout
//! (a game version it does not know) must give nothing rather than numbers it cannot vouch for.

use crate::game::Source;

pub mod acevo;
pub mod ams2;
pub mod f1;
pub mod kunos;
pub mod rfactor1;
pub mod wreckfest2;

/// A reader this build has.
pub struct Reader {
    /// The family of games it reads (`"kunos"`: Assetto Corsa, Assetto Corsa Competizione, Assetto Corsa Rally).
    pub family: &'static str,
    /// The program names of its games, in lower case. The reader is tried only while one of them is running, so a
    /// reader that listens on a UDP port does not hold the port (and keep other tools from it) when the game is not
    /// there, and it is let go when the game closes.
    pub programs: &'static [&'static str],
    /// Tries to open the door; `None` when the game is not there.
    pub open: fn() -> Option<Box<dyn Source>>,
}

pub const READERS: &[Reader] = &[
    Reader {
        family: "kunos",
        programs: &["acs.exe", "acs_x86.exe", "ac2-win64-shipping.exe", "acr.exe"],
        open: kunos::open,
    },
    Reader {
        family: "ams2",
        programs: &["ams2.exe", "ams2avx.exe"],
        open: ams2::open,
    },
    Reader {
        family: "wreckfest2",
        programs: &["wreckfest2.exe"],
        open: wreckfest2::open,
    },
    Reader {
        family: "f1",
        programs: &["f1_25.exe"],
        open: f1::open,
    },
    Reader {
        family: "acevo",
        programs: &["assettocorsaevo.exe"],
        open: acevo::open,
    },
    Reader {
        family: "rfactor1",
        programs: &["gsc.exe"],
        open: rfactor1::open,
    },
];
