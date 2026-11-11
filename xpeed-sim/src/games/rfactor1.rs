//! rFactor 1 engine games (Stock Car Extreme): the shared memory of the rFactorSharedMemoryMap plugin.
//!
//! Not written yet: `open` finds nothing until the reader is.

use crate::game::Source;

pub fn open() -> Option<Box<dyn Source>> {
    None
}
