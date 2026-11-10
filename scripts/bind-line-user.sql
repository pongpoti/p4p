-- ============================================================================
--  P4P — Bind LINE userId to a verified email (first verification wins)
-- ============================================================================
--  Purpose: pure traceability, NOT an auth factor. When a physician completes
--  email OTP verification, the LIFF SDK's liff.getProfile() gives the app
--  their LINE userId. Recording it against their email lets an admin answer
--  "which LINE account is behind this email?" — e.g. while investigating a
--  suspicious access request, or confirming who actually submitted P4P data.
--
--  The binding is set once and never overwritten (ON CONFLICT DO UPDATE only
--  refreshes the display name, which can legitimately change over time — the
--  userId/bound_at from the FIRST successful verification stick permanently).
--  If the same email later verifies from a different LINE account, this table
--  will still show the original userId — that mismatch is exactly the kind of
--  thing worth noticing manually; no automatic alerting is added here.
--
--  Called by verify/app.js right after a successful OTP verification, via a
--  SECURITY DEFINER function that takes the email from the caller's own JWT
--  (auth.jwt() ->> 'email') rather than trusting a client-supplied value —
--  an authenticated user can only ever bind their OWN verified email.
-- ============================================================================

create table if not exists public.line_user_bindings (
  email              text primary key,
  line_user_id       text not null,
  line_display_name  text,
  bound_at           timestamptz not null default now()
);

alter table public.line_user_bindings enable row level security;

-- No anon/authenticated policies — RLS with zero policies denies all direct
-- access. Writes only happen through bind_line_user_id() below (SECURITY
-- DEFINER, bypasses RLS); reads are via the Supabase Table Editor / SQL
-- editor (service_role / postgres), same posture as sender_physician_match.
revoke all on public.line_user_bindings from anon, authenticated;
grant select, insert, update, delete on public.line_user_bindings to service_role;

create or replace function public.bind_line_user_id(p_line_user_id text, p_line_display_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(auth.jwt() ->> 'email');
begin
  if v_email is null or p_line_user_id is null or btrim(p_line_user_id) = '' then
    return;
  end if;

  insert into public.line_user_bindings (email, line_user_id, line_display_name, bound_at)
  values (v_email, p_line_user_id, nullif(btrim(coalesce(p_line_display_name, '')), ''), now())
  on conflict (email) do update
    set line_display_name = coalesce(excluded.line_display_name, public.line_user_bindings.line_display_name);
end;
$$;

-- UPDATE 2026-11 (audit finding F10): retired and dropped (live per
-- DATA_EXPOSURE_ANALYSIS.md section 5, in source by
-- scripts/audit-fixes-2026-11.sql PART 4). The grant that stood here is
-- removed, so pasting this retired file again leaves the function callable
-- by nobody but the owner.
revoke all on function public.bind_line_user_id(text, text) from public, anon, authenticated;
