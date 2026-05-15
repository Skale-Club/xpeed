import { createClient } from "@supabase/supabase-js";

const sanitizeEnvValue = (value) => {
  if (!value) return value;
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const supabaseUrl = sanitizeEnvValue(
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
);
const serviceRoleKey = sanitizeEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
const maxStaleHours = Number.parseFloat(process.env.MAX_STALE_HOURS ?? "12");

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Missing env vars: SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.",
  );
  process.exit(1);
}

if (!Number.isFinite(maxStaleHours) || maxStaleHours <= 0) {
  console.error(`Invalid MAX_STALE_HOURS: ${process.env.MAX_STALE_HOURS}`);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`Verifying Supabase keepalive freshness (max stale: ${maxStaleHours}h)`);
console.log(`Target: ${supabaseUrl}`);

const { data, error } = await supabase
  .from("app_settings")
  .select("setting_key, setting_value, updated_at")
  .eq("setting_key", "system.supabase_keepalive")
  .single();

if (error) {
  console.error(`❌ Failed to read keepalive row: ${error.message}`);
  process.exit(1);
}

if (!data) {
  console.error("❌ Keepalive row not found in app_settings");
  process.exit(1);
}

// Prefer the payload-embedded timestamp; fall back to row updated_at.
let payloadTimestamp = null;
try {
  const payload =
    typeof data.setting_value === "string"
      ? JSON.parse(data.setting_value)
      : data.setting_value;
  if (payload && typeof payload.updated_at_utc === "string") {
    payloadTimestamp = payload.updated_at_utc;
  }
} catch {
  // Ignore parse errors; will fall back to row updated_at below.
}

const referenceIso = payloadTimestamp ?? data.updated_at;
if (!referenceIso) {
  console.error("❌ Keepalive row has no usable timestamp");
  process.exit(1);
}

const referenceDate = new Date(referenceIso);
if (Number.isNaN(referenceDate.getTime())) {
  console.error(`❌ Keepalive timestamp is not a valid date: ${referenceIso}`);
  process.exit(1);
}

const ageHours = (Date.now() - referenceDate.getTime()) / (1000 * 60 * 60);
console.log(
  `Last keepalive: ${referenceDate.toISOString()} (${ageHours.toFixed(2)}h ago)`,
);

if (ageHours > maxStaleHours) {
  console.error(
    `❌ Keepalive is STALE — ${ageHours.toFixed(2)}h old, threshold ${maxStaleHours}h.`,
  );
  console.error(
    "The scheduled `supabase-keepalive.yml` workflow is not producing fresh activity.",
  );
  console.error(
    "Check: workflow state (gh api repos/<owner>/<repo>/actions/workflows), secrets, recent run logs.",
  );
  process.exit(1);
}

console.log(`✅ Keepalive is fresh (${ageHours.toFixed(2)}h <= ${maxStaleHours}h).`);
