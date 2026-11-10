/**
 * A tiny in-memory stand-in for the two HTTP backends processBuffer talks to
 * through global fetch: Supabase's REST API (supabase-js resolves fetch at
 * call time) and the Telegram Bot API. Anything else gets a network error,
 * so a test can never reach a real service. Not a test file itself: the
 * *.test.ts files that need it import it AFTER pointing SUPABASE_URL at
 * FAKE_SUPABASE_URL.
 *
 * Only what processBuffer's queries use is implemented: eq filters, limit,
 * the one `or=(submitted_at.is.null,submitted_at.gt."…")` filter saveScore
 * sends, PATCH, POST inserts and RPC calls.
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
    const eq = value.match(/^eq\.(.*)$/);
    if (!eq) throw new Error(`fake supabase: unsupported filter ${key}=${value}`);
    if (String(row[key] ?? "") !== eq[1]) return false;
  }
  return true;
}

export function installFakeBackends(tables: Record<string, FakeRow[]> = {}): FakeBackends {
  const state: FakeBackends = { tables, patches: [], inserts: [], rpcs: [], telegrams: [], telegramDown: false, failingTables: new Set() };

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
        state.rpcs.push({ fn: path.slice(4), args: JSON.parse(bodyText || "{}") });
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
