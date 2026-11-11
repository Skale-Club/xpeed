//! Automobilista 2 (Project CARS 2 format): shared memory $pcars2$.
//!
//! Not written yet: `open` finds nothing until the reader is.

use crate::game::Source;

pub fn open() -> Option<Box<dyn Source>> {
    None
}
