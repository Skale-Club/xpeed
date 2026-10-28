// Sample data for the screen-test copy of the app: one 2010 Prius with three
// trips, a few problems and a service. Times are relative to "now".

type Row = Record<string, unknown>;

const USER_ID = 'user-1';
const CAR_ID = 'car-1';
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);

function rows(sessionId: string, minutes: number, base: { speed: number; rpm: number; coolant: number }) {
  return Array.from({ length: 60 }, (_, i) => ({
    id: `${sessionId}-r${i}`,
    session_id: sessionId,
    t_seconds: Math.round((i / 59) * minutes * 60),
    t_timestamp: null,
    data: {
      'Vehicle speed (km/h)': Math.max(0, Math.round(base.speed + 20 * Math.sin(i / 6))),
      'Engine RPM (rpm)': Math.max(0, Math.round(base.rpm + 500 * Math.sin(i / 4))),
      'Engine coolant temperature (°C)': Math.min(base.coolant, 40 + i * 2),
      'Hybrid battery remaining life (%)': 60 + Math.round(5 * Math.sin(i / 10)),
    },
    created_at: daysAgo(1),
  }));
}

function summary(speedAvg: number, coolantMax: number) {
  return {
    summaries: [
      { canonical_key: 'vehicle_speed', parameter_key: 'Vehicle speed (km/h)', label: 'Vehicle Speed', unit: 'km/h', min: 0, max: speedAvg * 2, avg: speedAvg, count: 60 },
      { canonical_key: 'coolant_temp', parameter_key: 'Engine coolant temperature (°C)', label: 'Coolant Temp', unit: '°C', min: 40, max: coolantMax, avg: coolantMax - 6, count: 60 },
      { canonical_key: 'engine_rpm', parameter_key: 'Engine RPM (rpm)', label: 'Engine RPM', unit: 'rpm', min: 0, max: 3200, avg: 1300, count: 60 },
    ],
    headerMapping: {
      'Vehicle speed (km/h)': { canonical_key: 'vehicle_speed', label: 'Vehicle Speed', unit: 'km/h' },
      'Engine coolant temperature (°C)': { canonical_key: 'coolant_temp', label: 'Coolant Temp', unit: '°C' },
      'Engine RPM (rpm)': { canonical_key: 'engine_rpm', label: 'Engine RPM', unit: 'rpm' },
    },
    timeColumn: { type: 'seconds', key: 'Time (s)' },
  };
}

const session = (id: string, start: string, minutes: number, speedAvg: number, coolantMax: number, extra: Row = {}): Row => ({
  id,
  car_profile_id: CAR_ID,
  user_id: USER_ID,
  uploaded_at: start,
  session_start: start,
  session_end: null,
  source_filename: `xpeed-scan_${start.slice(0, 10)} 08-00-00.csv`,
  source_file_path: null,
  duration_seconds: minutes * 60,
  row_count: minutes * 180,
  columns: null,
  summary: summary(speedAvg, coolantMax),
  active_dtcs: [],
  gemini_analysis: null,
  created_at: start,
  ...extra,
});

export function seedDatabase(): Record<string, Row[]> {
  return {
    car_profiles: [
      {
        id: CAR_ID, user_id: USER_ID, name: '2010 Toyota Prius', year: 2010, make: 'Toyota', model: 'Prius', trim: null,
        vin: 'JTDKN3DU5A0123456', engine_type: 'hybrid', ruleset_id: null, country: null, notes: null, is_admin: false, created_at: daysAgo(90),
      },
    ],
    sessions: [
      session('s-3', hoursAgo(3), 34, 41, 118, {
        active_dtcs: ['P0420'],
        gemini_analysis: {
          summary: 'O motor esquentou mais que o normal no fim da viagem e o carro registrou uma falha no catalisador. O resto funcionou bem.',
          key_findings: ['Temperatura do motor chegou a 118 °C', 'Código de falha P0420 (catalisador)'],
          recommended_action: 'Confira o líquido de arrefecimento e agende uma revisão.',
        },
      }),
      session('s-2', daysAgo(2), 18, 33, 92),
      session('s-1', daysAgo(6), 52, 58, 95, { source_filename: 'Ida pra praia' }),
    ],
    session_rows: [...rows('s-3', 34, { speed: 41, rpm: 1300, coolant: 118 }), ...rows('s-2', 18, { speed: 33, rpm: 1100, coolant: 92 }), ...rows('s-1', 52, { speed: 58, rpm: 1500, coolant: 95 })],
    session_flags: [
      {
        id: 'f-1', session_id: 's-3', severity: 'critical', canonical_key: 'coolant_temp', parameter_key: 'Engine coolant temperature (°C)',
        message: 'Coolant reached critical levels.', evidence: { max: 118, avg: 104 }, resolved: false, created_at: hoursAgo(3),
      },
    ],
    vehicle_issues: [
      {
        id: 'i-1', car_profile_id: CAR_ID, user_id: USER_ID, canonical_key: 'coolant_temp', title: 'Coolant reached critical levels.', severity: 'critical',
        status: 'active', first_seen_at: hoursAgo(3), last_seen_at: hoursAgo(3), first_session_id: 's-3', last_session_id: 's-3',
        resolved_at: null, resolved_note: null, recurrence_count: 0, created_at: hoursAgo(3),
      },
      {
        id: 'i-2', car_profile_id: CAR_ID, user_id: USER_ID, canonical_key: 'dtc:P0420', title: 'P0420', severity: 'serious',
        status: 'recurred', first_seen_at: daysAgo(40), last_seen_at: hoursAgo(3), first_session_id: null, last_session_id: 's-3',
        resolved_at: null, resolved_note: null, recurrence_count: 1, created_at: daysAgo(40),
      },
      {
        id: 'i-3', car_profile_id: CAR_ID, user_id: USER_ID, canonical_key: 'battery_voltage_12v', title: '12V battery low', severity: 'warning',
        status: 'resolved', first_seen_at: daysAgo(30), last_seen_at: daysAgo(20), first_session_id: null, last_session_id: null,
        resolved_at: daysAgo(15), resolved_note: null, recurrence_count: 0, created_at: daysAgo(30),
      },
      {
        id: 'i-4', car_profile_id: CAR_ID, user_id: USER_ID, canonical_key: 'ai:engine_slow_warmup', title: 'Motor demorando a esquentar', severity: 'warning',
        status: 'active', first_seen_at: daysAgo(6), last_seen_at: daysAgo(1), first_session_id: null, last_session_id: 's-2',
        resolved_at: null, resolved_note: null, recurrence_count: 0, created_at: daysAgo(6),
        details: {
          source: 'ai',
          meaning: 'Nas últimas viagens o motor levou bem mais tempo que o normal para chegar à temperatura de trabalho.',
          action: 'Peça para verificarem a válvula termostática na próxima revisão.',
        },
      },
    ],
    vehicle_issue_occurrences: [],
    maintenance_events: [
      {
        id: 'm-1', car_profile_id: CAR_ID, user_id: USER_ID, event_type: 'oil_change', performed_at: daysAgo(45).slice(0, 10),
        odometer_km: 182400, cost: 320, currency: 'USD', shop: 'Auto Center Silva', notes: null, created_at: daysAgo(45),
      },
    ],
    shared_reports: [],
    session_photos: [],
    app_settings: [],
    chat_conversations: [],
    chat_messages: [],
    mcp_tokens: [],
    parameter_baselines: [],
  };
}

export const HARNESS_USER = {
  id: USER_ID,
  email: 'motorista@exemplo.com',
  user_metadata: { full_name: 'Ana' },
  app_metadata: {},
  aud: 'authenticated',
  created_at: daysAgo(90),
};
