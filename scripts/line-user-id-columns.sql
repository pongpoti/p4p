-- ============================================================================
--  P4P — Denormalize LINE userId onto physician_directory / sender_physician_match
-- ============================================================================
--  Run scripts/bind-line-user.sql FIRST — this replaces bind_line_user_id()
--  again and depends on line_user_bindings, which stays the source of truth
--  (see that file: ON CONFLICT DO UPDATE only ever refreshes the display
--  name — the first bind's userId/bound_at are permanent).
--
--  Adds a line_user_id column directly to physician_directory and
--  sender_physician_match so it's visible right there in the Table Editor
--  without joining line_user_bindings. bind_line_user_id() now also writes to
--  whichever of these two tables has a row for that email — an allow-listed
--  email is guaranteed to be in at least one, sometimes both (see
--  line_binding_status's dedup logic for the "both" case).
--
--  The denormalized column always mirrors line_user_bindings's value (the
--  immutable, first-bind userId), not whatever a later call happens to pass
--  in — so if an admin later adds a NEW physician_directory row for an email
--  that was already bound via sender_physician_match (e.g. formally
--  onboarding someone who'd previously only auto-matched), re-running the
--  backfill query at the bottom fills in that new row from history instead of
--  it looking falsely "unmatched".
-- ============================================================================

--  NOTE: the SQL editor sends a pasted multi-statement script as one implicit
--  transaction — if anything below the ALTER TABLEs fails, Postgres rolls
--  EVERYTHING in this submission back, including columns that "succeeded"
--  moments earlier (this is almost certainly why the columns didn't stick the
--  first time). The explicit `commit;` below closes that transaction right
--  after the columns are added, so they're durable even if a later statement
--  errors.

alter table public.physician_directory   add column if not exists line_user_id text;
alter table public.sender_physician_match add column if not exists line_user_id text;
commit;

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

  update public.physician_directory
    set line_user_id = (select lb.line_user_id from public.line_user_bindings lb where lb.email = v_email)
    where lower(email) = v_email;

  update public.sender_physician_match
    set line_user_id = (select lb.line_user_id from public.line_user_bindings lb where lb.email = v_email)
    where lower(sender_email) = v_email;
end;
$$;
-- UPDATE 2026-11 (audit finding F10): retired and dropped (live per
-- DATA_EXPOSURE_ANALYSIS.md section 5, in source by
-- scripts/audit-fixes-2026-11.sql PART 4). Revoked here so that pasting
-- this retired file again leaves the function callable by nobody but the
-- owner.
revoke all on function public.bind_line_user_id(text, text) from public, anon, authenticated;
commit;

-- One-off backfill for rows that already existed (or were bound) before this
-- column existed. Safe to re-run any time — e.g. after adding a new
-- physician_directory row for an already-bound email.
update public.physician_directory d
  set line_user_id = lb.line_user_id
  from public.line_user_bindings lb
  where lb.email = lower(d.email) and d.line_user_id is distinct from lb.line_user_id;

update public.sender_physician_match m
  set line_user_id = lb.line_user_id
  from public.line_user_bindings lb
  where lb.email = lower(m.sender_email) and m.line_user_id is distinct from lb.line_user_id;
