//! The readers for every game other than Le Mans Ultimate (which has its own, in `lmu/`). Each one opens the door its
//! game offers (shared memory, or UDP the game sends to this computer) and turns what it reads into `Frame`s
//! (`game.rs`); the engine feeds those to a lap cutter (`lapcut.rs`) and writes the laps.
//!
//! A reader is tried again every few seconds until its game is there. A reader that cannot be sure of its layout
//! (a game version it does not know) must give nothing rather than numbers it cannot vouch for.

use crate::game::Source;

pub mod ams2;
pub mod f1;
pub mod kunos;
pub mod wreckfest2;

/// A reader this build has.
pub struct Reader {
    /// The family of games it reads (`"kunos"`: Assetto Corsa, Assetto Corsa Competizione, Assetto Corsa Rally).
    pub family: &'static str,
    /// Tries to open the door; `None` when the game is not there.
    pub open: fn() -> Option<Box<dyn Source>>,
}

pub const READERS: &[Reader] = &[
    Reader {
        family: "kunos",
        open: kunos::open,
    },
    Reader {
        family: "ams2",
        open: ams2::open,
    },
    Reader {
        family: "wreckfest2",
        open: wreckfest2::open,
    },
    Reader {
        family: "f1",
        open: f1::open,
    },
];
