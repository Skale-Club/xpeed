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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const retryWithBackoff = async (fn, maxRetries = 3, baseDelayMs = 1000) => {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.log(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
};

const supabaseUrl = sanitizeEnvValue(
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
);
const serviceRoleKey = sanitizeEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Missing env vars: SUPABASE_URL (or VITE_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.",
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const now = new Date();
const heartbeatPayload = {
  updated_at_utc: now.toISOString(),
  hour_utc: now.getUTCHours(),
  date_utc: now.toISOString().split("T")[0],
  source: "github-actions-cron",
  version: "2.0",
};

console.log(`Starting Supabase keepalive at ${now.toISOString()}`);
console.log(`Target: ${supabaseUrl}`);

// Execute multiple operations to ensure activity is registered
await retryWithBackoff(async () => {
  // Operation 1: Write heartbeat to app_settings
  // app_settings is unique per (user_id, setting_key) through partial indexes, which
  // ON CONFLICT (setting_key) can't use: update the system row, insert it if missing.
  const heartbeat = {
    setting_value: JSON.stringify(heartbeatPayload),
    encrypted: false,
  };
  const { data: updatedRows, error: updateError } = await supabase
    .from("app_settings")
    .update(heartbeat)
    .is("user_id", null)
    .eq("setting_key", "system.supabase_keepalive")
    .select("id");
  if (updateError) {
    throw new Error(`Update failed: ${updateError.message}`);
  }
  if (!updatedRows || updatedRows.length === 0) {
    const { error: insertError } = await supabase
      .from("app_settings")
      .insert({ setting_key: "system.supabase_keepalive", ...heartbeat });
    if (insertError) {
      throw new Error(`Insert failed: ${insertError.message}`);
    }
  }
  console.log("✓ Heartbeat written to app_settings");
}, 3);

await retryWithBackoff(async () => {
  // Operation 2: Read back the setting (ensures read activity)
  const { data, error: readError } = await supabase
    .from("app_settings")
    .select("setting_key, setting_value, updated_at")
    .eq("setting_key", "system.supabase_keepalive")
    .single();

  if (readError) {
    throw new Error(`Read failed: ${readError.message}`);
  }
  console.log("✓ Heartbeat verified:", data?.updated_at);
}, 3);

await retryWithBackoff(async () => {
  // Operation 3: Query sessions table to generate more database activity
  const { count, error: countError } = await supabase
    .from("sessions")
    .select("*", { count: "exact", head: true });

  if (countError) {
    throw new Error(`Session count failed: ${countError.message}`);
  }
  console.log(`✓ Sessions table queried (${count} rows)`);
}, 3);

console.log("");
console.log("=".repeat(50));
console.log(`✅ Supabase keepalive completed successfully!`);
console.log(`   Timestamp: ${heartbeatPayload.updated_at_utc}`);
console.log("=".repeat(50));
