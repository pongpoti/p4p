/**
 * A tiny in-memory stand-in for the two HTTP backends processBuffer talks to
 * through global fetch: Supabase's REST API (supabase-js resolves fetch at
 * call time) and the Telegram Bot API. Anything else gets a network error,
 * so a test can never reach a real service. Not a test file itself: the
 * *.test.ts files that need it import it AFTER pointing SUPABASE_URL at
 * FAKE_SUPABASE_URL.
 *
 * Only what processBuffer's queries use is implemented: eq and gt filters
 * (gt compares strings, which is right for ISO times), limit, the one
 * `or=(submitted_at.is.null,submitted_at.gt."…")` filter saveScore sends,
 * PATCH, POST inserts and RPC calls. save_p4p_score works as the SQL does
 * (audit-fixes-2026-11.sql PART 5) when the test seeds a p4p_score_saves
 * table; without one it answers as PostgREST does for a function that is
 * not installed, so saveScore takes its plain-update fallback. Its score
 * write is recorded in `patches`, like a plain update.
 */

export const FAKE_SUPABASE_URL = "http://supabase.test";

export type FakeRow = Record<string, unknown>;

export interface FakeBackends {
  tables: Record<string, FakeRow[]>;
  patches: { table: string; body: FakeRow; query: string }[];
  inserts: { table: string; body: unknown }[];
  rpcs: { fn: string; args: Record<string, unknown> }[];
  telegrams: string[];
  /** Make the next Telegram calls fail (as if the bot API were down). */
  telegramDown: boolean;
  /** Tables whose reads fail with a PostgREST error. */
  failingTables: Set<string>;
  /** Tables whose PATCH updates fail with a PostgREST error (reads still work). */
  failingWrites: Set<string>;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function matches(row: FakeRow, params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (key === "select" || key === "limit" || key === "order" || key === "on_conflict" || key === "columns") continue;
    if (key === "or") {
      const m = value.match(/^\((\w+)\.is\.null,\1\.gt\."(.+)"\)$/);
      if (!m) throw new Error(`fake supabase: unsupported or filter ${value}`);
      const v = row[m[1]!];
      if (!(v === null || v === undefined || String(v) > m[2]!)) return false;
      continue;
    }
    const gt = value.match(/^gt\.(.*)$/);
    if (gt) {
      const v = row[key];
      if (v === null || v === undefined || !(String(v) > gt[1]!)) return false;
      continue;
    }
    const eq = value.match(/^eq\.(.*)$/);
    if (!eq) throw new Error(`fake supabase: unsupported filter ${key}=${value}`);
    if (String(row[key] ?? "") !== eq[1]) return false;
  }
  return true;
}

/** save_p4p_score(p_month_key, p_index, p_score, p_received_at), as the SQL behaves. */
function saveScoreRpc(state: FakeBackends, args: Record<string, unknown>): Response {
  const saves = state.tables["p4p_score_saves"];
  if (!saves) return json(404, { code: "PGRST202", message: "Could not find the function public.save_p4p_score in the schema cache" });
  const table = String(args.p_month_key);
  const index = String(args.p_index);
  const at = new Date(String(args.p_received_at)).getTime();
  if (state.failingWrites.has(table)) return json(503, { message: `fake failure writing ${table}`, code: "XX000" });
  const prev = saves.find((r) => r.month_key === table && String(r.roster_index) === index);
  if (prev && new Date(String(prev.received_at)).getTime() > at) return json(200, false);
  const target = (state.tables[table] ?? []).find((r) => String(r.index) === index);
  if (!target) return json(400, { code: "P0001", message: `save_p4p_score: no row ${index} in table ${table}` });
  if (prev) prev.received_at = args.p_received_at;
  else saves.push({ month_key: table, roster_index: index, received_at: args.p_received_at });
  target.score = args.p_score;
  state.patches.push({ table, body: { score: args.p_score }, query: `?index=eq.${index}` });
  return json(200, true);
}

export function installFakeBackends(tables: Record<string, FakeRow[]> = {}): FakeBackends {
  const state: FakeBackends = { tables, patches: [], inserts: [], rpcs: [], telegrams: [], telegramDown: false, failingTables: new Set(), failingWrites: new Set() };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : "";

    if (url.origin === "https://api.telegram.org") {
      if (state.telegramDown) return json(502, { ok: false, description: "Bad Gateway" });
      state.telegrams.push(String((JSON.parse(bodyText) as { text?: unknown }).text ?? ""));
      return json(200, { ok: true });
    }

    if (url.origin === FAKE_SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const path = decodeURIComponent(url.pathname.slice("/rest/v1/".length));
      if (path.startsWith("rpc/")) {
        const fn = path.slice(4);
        const args = JSON.parse(bodyText || "{}") as Record<string, unknown>;
        state.rpcs.push({ fn, args });
        if (fn === "save_p4p_score") return saveScoreRpc(state, args);
        return json(200, null);
      }
      if (state.failingTables.has(path)) return json(500, { message: `fake failure reading ${path}`, code: "XX000" });
      const rows = state.tables[path];
      if (!rows) return json(404, { message: `relation "public.${path}" does not exist`, code: "42P01" });
      if (method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") ?? "", 10);
        const hits = rows.filter((r) => matches(r, url.searchParams));
        return json(200, Number.isFinite(limit) ? hits.slice(0, limit) : hits);
      }
      if (method === "PATCH") {
        if (state.failingWrites.has(path)) return json(503, { message: `fake failure writing ${path}`, code: "XX000" });
        const body = JSON.parse(bodyText) as FakeRow;
        state.patches.push({ table: path, body, query: url.search });
        const hits = rows.filter((r) => matches(r, url.searchParams));
        for (const r of hits) Object.assign(r, body);
        return json(200, hits);
      }
      if (method === "POST") {
        state.inserts.push({ table: path, body: JSON.parse(bodyText || "null") });
        return json(201, []);
      }
    }

    throw new TypeError(`fetch failed (no network in tests): ${method} ${url.origin}`);
  }) as typeof fetch;

  return state;
}
