-- RPC used by automation/supabase-client.js's bumpSenderMatch() to record one
-- successful live submission against sender_physician_match.
--
-- WHY A FUNCTION: the previous implementation did a plain JS read-then-upsert
-- (select email_count, then upsert email_count + 1). Two submissions from the
-- same sender processed concurrently (processBuffer runs attachments from one
-- email in parallel via Promise.allSettled, and separate emails can be
-- in-flight at once) could both read the same starting count and both write
-- count + 1, silently losing one increment. Folding the read-modify-write into
-- a single INSERT ... ON CONFLICT statement makes the increment atomic at the
-- database level regardless of how many callers race.
--
-- Run this in the Supabase SQL Editor after sender_physician_match.sql.

create or replace function public.bump_sender_match(
  p_sender_email        text,
  p_sender_display_name text,
  p_extracted_name      text,
  p_matched_physician   text,
  p_department          text,
  p_similarity          numeric
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.sender_physician_match (
    sender_email, sender_display_name, email_count,
    extracted_name, name_source, matched_physician, department, similarity,
    matched, updated_at
  )
  values (
    p_sender_email, p_sender_display_name, 1,
    p_extracted_name, 'live_pipeline', p_matched_physician, p_department, p_similarity,
    true, now()
  )
  on conflict (sender_email) do update set
    sender_display_name = coalesce(excluded.sender_display_name, public.sender_physician_match.sender_display_name),
    email_count          = public.sender_physician_match.email_count + 1,
    extracted_name        = excluded.extracted_name,
    name_source           = excluded.name_source,
    matched_physician     = excluded.matched_physician,
    department            = excluded.department,
    similarity            = excluded.similarity,
    matched               = excluded.matched,
    updated_at            = excluded.updated_at;
$$;

-- Only the automation (service_role) may call this. Never anon/authenticated.
revoke all on function public.bump_sender_match(text, text, text, text, text, numeric) from public;
grant execute on function public.bump_sender_match(text, text, text, text, text, numeric) to service_role;
