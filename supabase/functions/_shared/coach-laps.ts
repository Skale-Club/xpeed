// Bounded, owner-checked raw evidence. At most two stored laps are decoded;
// failures leave the metadata coach available with an explicit limitation.
import { gunzipLap, type LapFile } from "../../../src/lib/sim/lap-file.ts";
import { summarizeDriving, type DrivingEvidence } from "../../../src/lib/sim/coach-driving.ts";

export const COACH_FILE_LIMITS = { compressed: 8 * 1024 * 1024, unpacked: 24 * 1024 * 1024, samples: 100_000 } as const;
export interface StoredCoachLap {
  id: string; user_id?: string; game?: string; track_name?: string; car_name?: string;
  lap_number: number; time_ms: number; sample_count?: number; started_at?: string;
  storage_path?: string; size_bytes?: number;
}
export type LoadedDrivingEvidence = DrivingEvidence | { status: "unavailable"; reason: string };

function matches(lap: LapFile, row: StoredCoachLap): boolean {
  const h = lap.header;
  return h.game === row.game && h.track.name === row.track_name && h.car.name === row.car_name
    && h.lap.number === row.lap_number && h.lap.timeMs === row.time_ms && h.sampleCount === row.sample_count
    && Date.parse(h.startedAt) === Date.parse(row.started_at ?? "") && h.lap.valid && !h.lap.inLap && !h.lap.outLap;
}

// deno-lint-ignore no-explicit-any
export async function loadDrivingEvidence(db: any, userId: string, study: StoredCoachLap | undefined, reference: StoredCoachLap | undefined): Promise<LoadedDrivingEvidence> {
  if (!study || !reference || study.id === reference.id) return { status: "unavailable", reason: "insufficient_laps" };
  const files: LapFile[] = [];
  for (const row of [study, reference]) {
    if (row.user_id !== userId || !row.storage_path?.startsWith(`${userId}/`) || row.storage_path.includes("..") || !row.storage_path.endsWith(".xlap.gz")) {
      return { status: "unavailable", reason: "file_identity_unavailable" };
    }
    if (!Number.isInteger(row.size_bytes) || row.size_bytes! <= 0 || row.size_bytes! > COACH_FILE_LIMITS.compressed
      || !Number.isInteger(row.sample_count) || row.sample_count! > COACH_FILE_LIMITS.samples) {
      return { status: "unavailable", reason: "file_limits" };
    }
    try {
      const result = await db.storage.from("sim-laps").download(row.storage_path);
      if (result.error || !result.data) return { status: "unavailable", reason: "file_unavailable" };
      const blob = result.data as Blob;
      if (blob.size !== row.size_bytes || blob.size > COACH_FILE_LIMITS.compressed) return { status: "unavailable", reason: "file_limits" };
      const lap = await gunzipLap(new Uint8Array(await blob.arrayBuffer()), { maxBytes: COACH_FILE_LIMITS.unpacked });
      if (!matches(lap, row)) return { status: "unavailable", reason: "file_identity_mismatch" };
      files.push(lap);
    } catch { return { status: "unavailable", reason: "file_unavailable" }; }
  }
  try { return summarizeDriving({ id: study.id, lap: files[0] }, { id: reference.id, lap: files[1] }); }
  catch { return { status: "unavailable", reason: "analysis_unavailable" }; }
}
