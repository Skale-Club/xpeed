//! Nothing is left here. The Le Mans Ultimate recorder (its own lap cutter) is gone: `lmu/source.rs` turns the game's two
//! streams into `Frame`s and the laps are cut by `lapcut.rs` like every other game's, on the session machine in
//! `session.rs`.
//!
//! This file only exists because `main.rs` still declares `mod recorder;`. Delete it together with that line (and put
//! `mod session;` there if `lapcut.rs` should no longer declare it, see the top of `lapcut.rs`).
