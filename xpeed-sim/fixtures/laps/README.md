# Recorded lap regressions

Four real lap files from the owner's local Companion history: one Automobilista 2 lap at Interlagos and three
Assetto Corsa EVO laps at Laguna Seca. These are historical recordings, including the behavior of their original
Companion versions. They are not examples of guaranteed-correct telemetry.

The importer removed the session ID, normalized the start timestamp and gzip timestamp, and kept only standard
game/track/car/lap/channel metadata. Every sample payload is byte-identical to its source. `provenance.json` records
source and sanitized-file hashes. Source files were not changed.

The lapfile regression reads every file with the strict parser, checks useful sample counts, and compares every
channel's float bits after round-trip serialization. This exercises real output compatibility and preservation.
It does **not** exercise a game's raw shared memory or UDP reader, verify clutch/steering conventions, or replace
the `.xcap` capture/replay acceptance cases described in the parent README.

Raw reader captures remain pending. Do not relabel these files as raw captures or mark a game's reader verified
from these output-only tests. No signature or paid service is required for this experimental project.
