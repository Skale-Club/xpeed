// Shared network-free chat/context fixtures.
export const ids = {
  user: '10000000-0000-4000-8000-000000000001', other: '10000000-0000-4000-8000-000000000002',
  session: '20000000-0000-4000-8000-000000000001', thread: '30000000-0000-4000-8000-000000000001',
  message: '40000000-0000-4000-8000-000000000001', track: '50000000-0000-4000-8000-000000000001', car: '60000000-0000-4000-8000-000000000001',
};
export const request = { sessionId: ids.session, conversationId: ids.thread, messageId: ids.message, message: 'What should I practise?' };
export function fixture() {
  return {
    chat_conversations: [{ id: ids.thread, user_id: ids.user, mode: 'virtual', sim_session_id: ids.session }],
    sim_sessions: [{ id: ids.session, user_id: ids.user, game: 'ac', track_id: ids.track, car_id: ids.car, kind: 'practice', lap_count: 5,
      started_at: '2026-11-18T12:00:00Z', ended_at: '2026-11-18T12:10:00Z', weather: null, air_temp_c: null, track_temp_c: null }],
    sim_track_catalog: [{ id: ids.track, name: 'Monza' }], sim_car_catalog: [{ id: ids.car, name: 'Test GT3' }],
    sim_laps: Array.from({ length: 5 }, (_, i) => ({ id: `70000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, user_id: ids.user,
      session_id: ids.session, lap_number: i + 1, time_ms: [90000, 90600, 90300, 70000, 60000][i], valid: true,
      plausible: i < 3 ? true : i === 3 ? false : null, in_lap: false, out_lap: false,
      sector_ms: [[30000, 30000, 30000], [29800, 30700, 30100], [30100, 29900, 30300]][i] ?? null, started_at: `2026-11-18T12:0${i}:00Z` })),
    chat_messages: [
      { id: 'previous', conversation_id: ids.thread, role: 'assistant', parts: [{ type: 'text', text: 'Earlier advice' }], created_at: '2026-11-18T12:00:00Z' },
      { id: ids.message, conversation_id: ids.thread, role: 'user', parts: [{ type: 'text', text: request.message }], created_at: '2026-11-18T12:10:00Z' },
      { id: 'later', conversation_id: ids.thread, role: 'assistant', parts: [{ type: 'text', text: 'Future answer' }], created_at: '2026-11-18T12:11:00Z' },
      { id: 'foreign', conversation_id: 'another-thread', role: 'user', parts: [{ type: 'text', text: 'Other conversation' }], created_at: '2026-11-18T12:00:00Z' },
    ],
  };
}
export function fakeDb(rows = fixture(), failTable) {
  const reads = [];
  return { reads, async rpc(name, args) {
    reads.push({ table: name, args });
    if (name === failTable) return { data: null, error: { message: 'offline' } };
    return { data: { goals: rows.sim_coach_goals ?? [], limit: 20, truncated: false }, error: null };
  }, from(table) {
    const filters = [], orders = []; let max = Infinity;
    const result = () => {
      reads.push({ table, filters: [...filters] });
      if (table === failTable) return { data: null, error: { message: 'offline' } };
      let data = (rows[table] ?? []).filter((r) => filters.every(([op, key, value]) => {
        if (op === 'eq') return r[key] === value;
        if (op === 'in') return value.includes(r[key]);
        if (op === 'like') return String(r[key]).startsWith(value.replace(/%$/, ''));
        return r[key] < value;
      }));
      data = [...data].sort((a, b) => {
        for (const [key, ascending] of orders) { if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (ascending ? 1 : -1); }
        return 0;
      }).slice(0, max);
      return { data, error: null };
    };
    const q = {
      select() { return q; }, eq(key, value) { filters.push(['eq', key, value]); return q; },
      lt(key, value) { filters.push(['lt', key, value]); return q; },
      in(key, value) { filters.push(['in', key, value]); return q; },
      like(key, value) { filters.push(['like', key, value]); return q; },
      order(key, options) { orders.push([key, options.ascending]); return q; }, limit(value) { max = value; return q; },
      async maybeSingle() { const r = result(); return { ...r, data: r.data?.[0] ?? null }; },
      then(ok, fail) { return Promise.resolve(result()).then(ok, fail); },
    };
    return q;
  } };
}
