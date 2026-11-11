//! Assetto Corsa, Assetto Corsa Competizione and Assetto Corsa Rally (Kunos): shared memory pages acpmf_physics, acpmf_graphics, acpmf_static.
//!
//! Not written yet: `open` finds nothing until the reader is.

use crate::game::Source;

pub fn open() -> Option<Box<dyn Source>> {
    None
}
