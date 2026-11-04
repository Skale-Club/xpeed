// What the development copy of production data is allowed to contain.
// Pure functions, no database: tested in scripts/verify-db-foundation.mjs.
import { createHash } from 'node:crypto';

/** Tables that are never copied: secrets, operational noise, or links to files that do not travel. */
export const SKIPPED_TABLES = new Set([
  'xpeed_schema_migrations', 'xpeed_dev_sync',
  'app_settings', 'mcp_tokens', 'oauth_clients', 'oauth_authorization_codes', 'oauth_refresh_tokens',
  'rate_limits', 'security_events', 'shared_reports', 'session_photos',
]);

const short = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

// Column patterns blanked on tables that have no explicit rule, as a safety net for new tables.
const SENSITIVE_COLUMN = /(^|_)(email|phone|vin|plate|token|secret|password|passwd|ip|address)(_|$)/i;
// Keys such as `GPS Latitude`, `lat`, `user_email`: separators can be anything but letters.
const SENSITIVE_KEY = /(^|[^a-z])(lat|latitude|lon|lng|longitude|gps|vin|plate|email|phone|address)([^a-z]|$)/i;

/** Removes sensitive keys anywhere inside a JSON value. */
export function scrubJson(value) {
  if (Array.isArray(value)) return value.map(scrubJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE_KEY.test(key)).map(([key, inner]) => [key, scrubJson(inner)]));
  }
  return value;
}

/**
 * @param {{ keepEmails?: string[], keepPhones?: string[] }} keep accounts that stay recognizable so the
 *   owner can still sign in on the development copy and see their own data.
 */
export function createAnonymizer({ keepEmails = [], keepPhones = [] } = {}) {
  const emails = new Set(keepEmails.map((v) => v.trim().toLowerCase()).filter(Boolean));
  const phones = new Set(keepPhones.map((v) => v.trim()).filter(Boolean));
  const keptAccounts = new Set();
  const isKept = (account) => (account.email && emails.has(String(account.email).toLowerCase())) || (account.phone && phones.has(account.phone));

  const rules = {
    app_accounts: (row) => {
      if (isKept(row)) { keptAccounts.add(row.id); return row; }
      return { ...row, email: row.email ? `driver-${short(row.id)}@example.test` : null, phone: null, full_name: row.full_name ? `Driver ${short(row.id).slice(0, 4)}` : null };
    },
    google_auth_identities: (row) => keptAccounts.has(row.account_id) ? row : { ...row, subject: `dev-${short(row.subject)}` },
    // Make, model, year and engine stay: they are what makes the data realistic and are not personal.
    car_profiles: (row) => ({ ...row, name: `Car ${short(row.id).slice(0, 4)}`, vin: null, photo_path: null, notes: null }),
    // source_csv is the raw upload, which can hold GPS columns.
    sessions: (row) => ({ ...row, source_filename: 'trip.csv', source_file_path: null, source_csv: null }),
    chat_conversations: (row) => ({ ...row, title: 'Conversation' }),
    chat_messages: (row) => ({ ...row, parts: [{ type: 'text', text: '[removed in development copy]' }], attachments: [] }),
    maintenance_events: (row) => ({ ...row, notes: null, shop: null }),
    vehicle_issues: (row) => ({ ...row, resolved_note: null }),
  };

  /** Rows must be copied in table order: app_accounts first so kept accounts are known. */
  const order = (tables) => [...tables].sort((a, b) => (a === 'app_accounts' ? -1 : b === 'app_accounts' ? 1 : 0));

  function row(table, input) {
    // Two passes: the table's own rule, then the generic net for anything it did not name.
    let output = rules[table] ? rules[table](input) : { ...input };
    if (!rules[table]) {
      for (const column of Object.keys(output)) if (SENSITIVE_COLUMN.test(column) && typeof output[column] === 'string') output[column] = null;
    }
    for (const [column, value] of Object.entries(output)) {
      if (value && typeof value === 'object') output[column] = scrubJson(value);
    }
    return output;
  }

  return { row, order, keptAccounts };
}
