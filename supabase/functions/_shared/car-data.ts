// Reads the car's state for the assistant straight from the database, with the service role,
// but every query is scoped to the signed-in caller (user_id = caller). Nothing the browser
// sends is trusted except an id/VIN/name used to pick one of the CALLER's OWN cars.
//
// deno-lint-ignore-file no-explicit-any
import {
  computeTrends, EMPTY_CAR_DATA,
  type CarPromptData, type PromptMaintenance, type PromptProblem, type PromptTrip,
} from "./chat-prompt.ts";

export interface CarHint {
  /** A car id the client says is selected: used only if it belongs to the caller. */
  carProfileId?: string | null;
  vin?: string | null;
  name?: string | null;
}

const CAR_COLUMNS = "id, name, notes, make, model, year, engine_type, vin, created_at";

/** The caller's selected car: by id, else by VIN/name among their own cars, else their newest real car. */
async function pickCar(db: any, userId: string, hint: CarHint): Promise<any | null> {
  const base = () => db.from("car_profiles").select(CAR_COLUMNS).eq("user_id", userId);

  if (hint.carProfileId) {
    const { data, error } = await base().eq("id", hint.carProfileId).maybeSingle();
    if (error) console.error("chat: car lookup failed:", error.message);
    if (data) return data;
  }

  const { data: cars, error } = await base().neq("is_admin", true).order("created_at", { ascending: false }).limit(25);
  if (error) {
    console.error("chat: cars lookup failed:", error.message);
    return null;
  }
  const list: any[] = cars ?? [];
  if (hint.vin) {
    const byVin = list.find((c) => c.vin && String(c.vin).toUpperCase() === String(hint.vin).toUpperCase());
    if (byVin) return byVin;
  }
  if (hint.name) {
    const byName = list.find((c) => c.name === hint.name);
    if (byName) return byName;
  }
  return list[0] ?? null;
}

const minutes = (seconds: number | null) => (seconds ? Math.round(seconds / 60) : null);
const speedAvg = (summary: any): number | null => {
  const item = summary?.summaries?.find((s: any) => s.canonical_key === "vehicle_speed");
  return typeof item?.avg === "number" ? item.avg : null;
};

export async function loadCarPromptData(db: any, userId: string, hint: CarHint): Promise<CarPromptData> {
  const car = await pickCar(db, userId, hint);
  if (!car) return EMPTY_CAR_DATA;

  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [countRes, recentRes, latestRes, issuesRes, maintRes] = await Promise.all([
    db.from("sessions").select("id", { count: "exact", head: true }).eq("car_profile_id", car.id).eq("user_id", userId),
    db.from("sessions")
      .select("session_start, uploaded_at, summary")
      .eq("car_profile_id", car.id).eq("user_id", userId)
      .order("uploaded_at", { ascending: false }).limit(25),
    db.from("sessions")
      .select("session_start, uploaded_at, duration_seconds, summary, active_dtcs, gemini_analysis")
      .eq("car_profile_id", car.id).eq("user_id", userId)
      .order("uploaded_at", { ascending: false }).limit(3),
    db.from("vehicle_issues")
      .select("canonical_key, title, severity, status, recurrence_count, last_seen_at, details")
      .eq("car_profile_id", car.id).eq("user_id", userId)
      .in("status", ["active", "recurred"])
      .order("last_seen_at", { ascending: false }).limit(10),
    db.from("maintenance_events")
      .select("event_type, performed_at, odometer_km")
      .eq("car_profile_id", car.id).eq("user_id", userId)
      .gte("performed_at", cutoff)
      .order("performed_at", { ascending: false }).limit(5),
  ]);

  for (const [what, res] of [["sessions count", countRes], ["recent trips", recentRes], ["latest trips", latestRes], ["problems", issuesRes], ["maintenance", maintRes]] as const) {
    if ((res as any).error) console.error(`chat: ${what} lookup failed:`, (res as any).error.message);
  }

  const lastTrips: PromptTrip[] = (latestRes.data ?? []).map((s: any) => {
    const avg = speedAvg(s.summary);
    const km = avg != null && s.duration_seconds ? Math.round((avg * s.duration_seconds) / 3600) : null;
    const summary = s.gemini_analysis && typeof s.gemini_analysis.summary === "string" ? s.gemini_analysis.summary : null;
    return {
      date: new Date(s.session_start ?? s.uploaded_at).toISOString(),
      minutes: minutes(s.duration_seconds),
      km,
      avgSpeedKmh: avg == null ? null : Math.round(avg),
      faultCodes: Array.isArray(s.active_dtcs) ? s.active_dtcs.filter((c: unknown) => typeof c === "string") : [],
      summary,
    };
  });

  return {
    vehicle: { name: car.name, notes: car.notes, make: car.make, model: car.model, year: car.year, engine_type: car.engine_type },
    sessionCount: countRes.count ?? 0,
    openProblems: (issuesRes.data ?? []) as PromptProblem[],
    lastTrips,
    trends: computeTrends(recentRes.data ?? []),
    maintenance: (maintRes.data ?? []).map((e: any): PromptMaintenance => ({
      type: e.event_type, date: e.performed_at, odometer: e.odometer_km,
    })),
  };
}
