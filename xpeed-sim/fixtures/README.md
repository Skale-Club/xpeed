# Fixtures: real drives, kept as tests

Recorded **lap outputs** are available in [`laps/`](laps/README.md) for parser/serialization and diagnostic regressions.
They do not count as raw-reader validation. This folder currently has no committed raw `.xcap` captures; reader
conventions marked `ASSUMED` remain unverified until an actual capture and its expectations are recorded.

A fixture is a few minutes of real driving, recorded with `xpeed-companion capture` into a `.xcap` file and committed
here. `cargo test` replays every `*.xcap` in this folder through the reader of its game, the lap cutter and the data
checks (`src/sanity.rs`), exactly as the app does with a live game, and compares the result with the fixture's
`NAME.expect.json`. A reader whose clutch is inverted, whose map is mirrored or whose laps are numbered from the wrong
base fails there, with nobody having to read bytes.

With no fixture in the folder the test passes (it only has to find none). The first synthetic proof of the pipeline is
inside the tests themselves (`src/replay.rs`, built from the Assetto Corsa reader's own pages).

## Recording one

1. Pick one game and one car on a circuit you know (its length, and the direction it is driven, help the expectations).
   A car with a clutch and a manual box tests more than an automatic one; say which in the notes.
2. Start the capture, then drive:
   * an **out lap** (leave the pits and cross the line once);
   * **two clean laps** (no cuts, no spins, no pit lane);
   * a **pause** of about ten seconds (the game's pause or escape menu) and back;
   * a **pit entry** (an in lap, into the pit lane and the box), and out again if you like.
   Five to seven minutes is enough. Shorter is better: a fixture is committed for good. Press Ctrl+C in the terminal to end
   the capture when you are done (or let `--seconds` run out); the file is closed properly either way.
3. Replay it: `xpeed-companion replay fixtures\NAME.xcap`. Read the table: the laps cut, their times, `distance`
   (the distance covered against the track length, a few percent off at most), the data checks, the steering and clutch
   lines. Does it say what you drove? If a number is wrong, the reader or the cutter has a bug: that is what the fixture
   is for. Fix it, then record the expectations.
4. Write `fixtures\NAME.expect.json` (below), run `cargo test --locked` and commit both files.

Name the files after the game, the car and the circuit: `acevo-laguna-seca-mx5.xcap`.

### How to capture each family

Run the commands from a terminal in the folder where the file should go; `--out` says where. `--build` is free text for
the game's version (the build number the launcher shows); it ends up in the header.

| Family | Games (`capture` argument) | How |
| --- | --- | --- |
| Shared memory | `ac`, `acc`, `acr`, `acevo`, `ams2`, `pcars2`, `pcars3`, `rfactor1`, `ams1`, `rf1`, `iracing`, `r3e` | Start the game and get in the car. `xpeed-companion capture acevo --seconds 420 --out fixtures\acevo-NAME.xcap`. The tray app can stay open: both read the same memory. |
| Le Mans Ultimate | `lmu` | `Enable external plugins` on in the game (Settings > Gameplay). `xpeed-companion capture lmu --seconds 420 --out fixtures\lmu-NAME.xcap`. The tray app can stay open. |
| UDP | `f1` (also `f124`, `f123`), `fm`, `fm7`, `fh4`, `fh5`, `fh6`, `wreckfest2` | Switch the game's UDP telemetry on, pointed at this computer (`127.0.0.1`; F1 port 20777, Forza port 5301, Wreckfest 2 port 23123). **Pause or quit the tray app first** (menu: pause recording; or quit it): only one program can hold a UDP port, so the capture cannot open it while the tray app listens. Then `xpeed-companion capture f124 --seconds 420 --out fixtures\f124-NAME.xcap`. |

The capture waits up to two minutes for the game to be there, says what it sees every few seconds, and ends with a short
summary: the records and the readings written, the size on disk, the frames, the laps seen. If the summary says the car
was never on track, record again.

### Size

A capture stores each copy of a game's memory as the bytes that changed from the last copy, and gzip does the rest.
Ten minutes of Assetto Corsa EVO should stay at a few tens of megabytes at most, five minutes of a lighter game at a few
megabytes. The summary prints the size. If a fixture is bigger than about 10 MB, record fewer minutes.

### Privacy

A capture holds what the game shares: car, track, times, and in some games the names of the drivers (Le Mans Ultimate's
scoring lists every car, iRacing's session information holds the driver's own name and customer id). Do not commit a
capture of an online session, and read the replay output before committing one from iRacing.

## The expectations: `NAME.expect.json`

Every key is optional. An unknown key is an error (it is probably a typo).

```json
{
  "laps": 3,
  "valid": 3,
  "allow": ["dist_vs_track"],
  "steer": "right_positive",
  "clutch": "released_0",
  "map_direction": "clockwise",
  "notes": "free text: car, circuit, what was driven"
}
```

| Key | Meaning |
| --- | --- |
| `laps` | How many laps the replay must cut (default: at least one). |
| `valid` | How many of them must be valid. |
| `allow` | Data check ids (see `IDS` in `src/sanity.rs`) that are known and accepted for this capture. Any other finding fails the test. Default: none. Say why in `notes`. |
| `steer` | `right_positive`: steering right reads positive (the convention of the lap file), checked as the correlation of the steering with the turning of the path (at least 0.3). `right_negative` for a game that really reports it the other way. |
| `clutch` | `released_0`: the clutch reads 0 when released (the median at speed on the throttle in a gear is below 0.2); `released_1`: it reads 1 (above 0.8); `none`: the replay has no clutch value. |
| `map_direction` | `clockwise` or `counter_clockwise`: the way the circuit is driven, seen from above with x east and z north (the sign of the area of the path, for every whole lap). A mirrored map flips it. |
| `notes` | Anything. Not checked. |

Lap numbers, times and the distance against the track length are shown by `replay`; `laps`, `valid` and the data checks
(`dist_vs_track` is the distance against the track length) are what the test holds them to.

## What to verify per game

The convention of every `Frame` field is in `src/game.rs`, with the way each reader maps its game's raw value. Only a few
mappings were ever checked against a running game (marked `VERIFIED-LIVE` there: Assetto Corsa EVO's steering, clutch and
axes, Automobilista 2's tyre pressure in kPa and its brake bias as the rear share). Every other mapping is `ASSUMED`, and
where two readers contradict each other nobody guessed which one is right. A fixture of each game settles it; the
`.expect.json` key that does is named in the last column.

| What | The contradiction or doubt | Games to record | Key |
| --- | --- | --- | --- |
| Map axes (x east, z north) | iRacing works the position out from the velocity and writes z = MINUS north; Automobilista 2 and EVO write z = north. Assetto Corsa and Competizione write the game's coordinates as they are, while EVO's ground is mirrored (x negated) | `ac`, `acc`, `ams2`, `iracing`, `r3e`, `rfactor1`, `lmu`, `f1`, `fm`, `wreckfest2` | `map_direction` (drive a circuit whose direction you know) |
| Steering sign (+1 = right) | only EVO was checked; the others pass the game's value through, iRacing negates the angle | all but `acevo` | `steer` |
| Clutch polarity (1 = pressed) | EVO writes 1 = engaged and is turned around; iRacing is turned around too; the others pass the value through and nobody saw which end is "pressed" | all but `acevo` (`ac`, `acc`, `acr` do not read it) | `clutch` (use a car with a clutch and a manual box) |
| Lap numbering (first lap driven = 1) | rFactor 1, iRacing and Le Mans Ultimate pass the game's number through and it is not known whether their first lap is 0 or 1; the other readers add 1 to a laps-completed count | `rfactor1`, `iracing`, `lmu` | none: read the `replay` table, the out lap and the first flying lap must be 1 and 2 (or 0 and 1 is the answer; write it in `notes` and change the reader) |
| Brake bias (front share) | Assetto Corsa, Competizione and EVO are taken as the front share, Automobilista 2 (checked), RaceRoom and Le Mans Ultimate are the rear share turned around | `ac`, `acc`, `acevo`, `r3e`, `lmu` | none: the dash value in the game against the one in the replay table |
| Aid levels, damage, pit area | taken from the headers; no game was compared with its own dash | any | none |
| Aids in the lap header (`aids`: `tcMax`, `absMax`, `stability`, `autoShift`, `autoClutch`, `autoBlip`, `idealLine`) | The lap keeps the highest setting seen on it. Every mapping is `ASSUMED`; the list below says what to compare for each game. A key that is not in the header means unknown, 0 means off or "the car has none" | see below | none: the setup screen against the `aids` object of the lap file (`xpeed-companion`'s lap list or the unzipped header) |

What to verify for the aids, per game. In every capture drive one lap with a setting changed halfway (TC from 4 to off, say)
and check that the lap file shows the HIGHEST value, then one lap with every aid off and one with the car's maximum:

- **Assetto Corsa (`ac`)**: the settings screen (Content Manager's "Assists") against `autoShifterOn` (physics 264),
  `aidStability` (static 484, 0..1), `aidAutoclutch` (488), `aidAutoBlip` (492) and `idealLineOn` (graphics 272: the offset
  is the one Assetto Corsa's own struct implies, Competizione's document has a `penalty` before it, so check the value
  really follows the line toggle). The physics `tc` and `abs` floats have NOT been settled: capture them with the aid on
  at several settings and see whether they are the setting (steady) or the intervention (zero until the aid acts). Until a
  capture shows it, the Assetto Corsa reader gives no TC or ABS level, so `tcMax` and `absMax` are absent from its laps.
- **Competizione (`acc`)**: the graphics page's `TC` and `ABS` against the setup screen (0 is off; are the numbers the
  same as the setting shown in the car's MFD?). It gives no stability, gearbox or line aid.
- **EVO (`acevo`)**: the electronics levels against the car's dash, and on a car without TC (or ABS) that its level and
  maximum are both 0, which the lap file turns into `tcMax: 0` (resp. `absMax: 0`).
- **Automobilista 2 (`ams2`), RaceRoom (`r3e`), EA SPORTS F1 (`f1`), Wreckfest 2 (`wreckfest2`)**: the level numbers
  against the game's assist menu (F1: TC 0 off, 1 medium, 2 full; ABS 0 off, 1 on; Wreckfest 2: 0, 1 half, 2 full). A
  game that reports "unset" as a number (-1, 255) must not become a level.
- **Le Mans Ultimate (`lmu`)**: `mTC` and `mABS` against the car's dash, and that a car without the aid (maximum 0) gives
  `tcMax: 0` or `absMax: 0`.
- **iRacing, Forza, rFactor 1**: give no aid setting; their laps must have no `aids` object at all.

Record the game's own dash next to the replay table when a key does not exist (a photo of the setup screen is enough
for the brake bias), and say in `notes` what was compared.

## The `.xcap` format

One gzip stream: the magic `XCAP` and a version byte, a JSON header (game, reader family, Companion version, game build,
start time), then records `{t_ms, stream, bytes}` as described at the top of `src/capture.rs`. A copy of a page is stored
as a difference from the last copy of the same page, so a page that did not change costs nothing.
