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
pub mod forza;
pub mod iracing;
pub mod kunos;
pub mod r3e;
pub mod rfactor1;
pub mod wreckfest2;

/// A reader this build has.
pub struct Reader {
    /// The family of games it reads (`"kunos"`: Assetto Corsa, Assetto Corsa Competizione, Assetto Corsa Rally).
    pub family: &'static str,
    /// The games it reads, as the panel lists them.
    pub title: &'static str,
    /// The ids its sources report (`Source::game_id`), to show their state against this line of the panel.
    pub ids: &'static [&'static str],
    /// The program names of its games, in lower case. The reader is tried only while one of them is running, so a
    /// reader that listens on a UDP port does not hold the port (and keep other tools from it) when the game is not
    /// there, and it is let go when the game closes.
    pub programs: &'static [&'static str],
    /// Tries to open the door; `None` when the game is not there.
    pub open: fn() -> Option<Box<dyn Source>>,
}

/// Every program a reader waits for, with the game it is: its id and name. When the program runs but the reader finds
/// no data, the panel names that game and tells how to switch its data on.
pub const PROGRAMS: &[(&str, &str, &str)] = &[
    ("acs.exe", "ac", "Assetto Corsa"),
    ("acs_x86.exe", "ac", "Assetto Corsa"),
    ("ac2-win64-shipping.exe", "acc", "Assetto Corsa Competizione"),
    ("acr.exe", "acr", "Assetto Corsa Rally"),
    ("ams2.exe", "ams2", "Automobilista 2"),
    ("ams2avx.exe", "ams2", "Automobilista 2"),
    ("pcars2.exe", "pcars2", "Project CARS 2"),
    ("pcars2avx.exe", "pcars2", "Project CARS 2"),
    ("pcars3.exe", "pcars3", "Project CARS 3"),
    ("pcars3avx.exe", "pcars3", "Project CARS 3"),
    ("wreckfest2.exe", "wreckfest2", "Wreckfest 2"),
    ("f1_25.exe", "f1", "EA SPORTS F1 25"),
    ("f1_24.exe", "f124", "EA SPORTS F1 24"),
    ("f1_23.exe", "f123", "EA SPORTS F1 23"),
    ("assettocorsaevo.exe", "acevo", "Assetto Corsa EVO"),
    ("gsc.exe", "rfactor1", "Stock Car Extreme"),
    ("ams.exe", "ams1", "Automobilista"),
    ("rfactor.exe", "rf1", "rFactor"),
    ("iracingsim64dx11.exe", "iracing", "iRacing"),
    ("iracingsim64.exe", "iracing", "iRacing"),
    ("rrre64.exe", "r3e", "RaceRoom Racing Experience"),
    ("rrre.exe", "r3e", "RaceRoom Racing Experience"),
    ("forza_steamworks_release_final.exe", "fm", "Forza Motorsport"),
    ("forza_gaming.desktop.x64_release_final.exe", "fm", "Forza Motorsport"),
    ("forzamotorsport7.exe", "fm7", "Forza Motorsport 7"),
    ("forzahorizon4.exe", "fh4", "Forza Horizon 4"),
    ("forzahorizon5.exe", "fh5", "Forza Horizon 5"),
];

/// The game of `reader` whose program is running, if any: its id and name.
pub fn running_game(running: &[String], reader: &Reader) -> Option<(&'static str, &'static str)> {
    PROGRAMS
        .iter()
        .find(|(program, _, _)| reader.programs.contains(program) && running.iter().any(|r| r == program))
        .map(|&(_, id, name)| (id, name))
}

pub const READERS: &[Reader] = &[
    Reader {
        family: "kunos",
        title: "Assetto Corsa · ACC · AC Rally",
        ids: &["ac", "acc", "acr"],
        programs: &["acs.exe", "acs_x86.exe", "ac2-win64-shipping.exe", "acr.exe"],
        open: kunos::open,
    },
    Reader {
        family: "ams2",
        title: "Automobilista 2",
        ids: &["ams2"],
        programs: &["ams2.exe", "ams2avx.exe"],
        open: ams2::open,
    },
    Reader {
        family: "pcars",
        title: "Project CARS 2 · Project CARS 3",
        ids: &["pcars2", "pcars3"],
        // The games' own program names (both also ship an AVX build).
        programs: &["pcars2.exe", "pcars2avx.exe", "pcars3.exe", "pcars3avx.exe"],
        open: ams2::open_pcars,
    },
    Reader {
        family: "wreckfest2",
        title: "Wreckfest 2",
        ids: &["wreckfest2"],
        programs: &["wreckfest2.exe"],
        open: wreckfest2::open,
    },
    Reader {
        family: "f1",
        title: "F1 25 · F1 24 · F1 23",
        // One UDP port for the three: the format of each packet says which game sent it (`f1.rs`).
        ids: &["f1", "f124", "f123"],
        // The games' own executables (Steam and EA app installs): F1_25.exe, F1_24.exe, F1_23.exe.
        programs: &["f1_25.exe", "f1_24.exe", "f1_23.exe"],
        open: f1::open,
    },
    Reader {
        family: "acevo",
        title: "Assetto Corsa EVO",
        ids: &["acevo"],
        programs: &["assettocorsaevo.exe"],
        open: acevo::open,
    },
    Reader {
        family: "rfactor1",
        title: "Stock Car Extreme \u{b7} Automobilista \u{b7} rFactor",
        ids: &["rfactor1", "ams1", "rf1"],
        programs: &["gsc.exe", "ams.exe", "rfactor.exe"],
        open: rfactor1::open,
    },
    Reader {
        family: "iracing",
        title: "iRacing",
        ids: &["iracing"],
        programs: &["iracingsim64dx11.exe", "iracingsim64.exe"],
        open: iracing::open,
    },
    Reader {
        family: "r3e",
        title: "RaceRoom Racing Experience",
        ids: &["r3e"],
        // The official API sample (`sample-c/src/utils.c`) looks for these two.
        programs: &["rrre64.exe", "rrre.exe"],
        open: r3e::open,
    },
    Reader {
        family: "forza",
        title: "Forza Motorsport · Forza Horizon",
        ids: &["fm", "fm7", "fh4", "fh5"],
        programs: &[
            "forza_steamworks_release_final.exe",
            "forza_gaming.desktop.x64_release_final.exe",
            "forzamotorsport7.exe",
            "forzahorizon4.exe",
            "forzahorizon5.exe",
        ],
        open: forza::open,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_program_a_reader_waits_for_names_one_of_its_games() {
        for reader in READERS {
            for program in reader.programs {
                let found = PROGRAMS.iter().find(|(p, _, _)| p == program);
                let (_, id, _) = found.unwrap_or_else(|| panic!("{program} is not in PROGRAMS"));
                assert!(reader.ids.contains(id), "{program}: {id} is not one of {:?}", reader.ids);
            }
        }
        let ams2 = READERS.iter().find(|r| r.family == "ams2").unwrap();
        assert_eq!(
            running_game(&["explorer.exe".into(), "ams2avx.exe".into()], ams2),
            Some(("ams2", "Automobilista 2"))
        );
        assert_eq!(running_game(&["pcars2.exe".into()], ams2), None, "another reader's program");
    }
}
