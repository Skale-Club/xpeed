//! Le Mans Ultimate: the memory it shares (`LMU_Data`) and what the collector takes from it.

pub mod layout;
#[cfg(windows)]
pub mod reader;
pub mod snapshot;
