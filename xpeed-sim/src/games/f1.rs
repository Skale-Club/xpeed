//! EA SPORTS F1 25: the UDP telemetry the game sends.
//!
//! Not written yet: `open` finds nothing until the reader is.

use crate::game::Source;

pub fn open() -> Option<Box<dyn Source>> {
    None
}
