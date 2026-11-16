# Fixtures: real drives, kept as tests

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

## The `.xcap` format

One gzip stream: the magic `XCAP` and a version byte, a JSON header (game, reader family, Companion version, game build,
start time), then records `{t_ms, stream, bytes}` as described at the top of `src/capture.rs`. A copy of a page is stored
as a difference from the last copy of the same page, so a page that did not change costs nothing.
