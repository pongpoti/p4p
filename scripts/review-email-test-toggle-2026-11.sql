-- ============================================================================
--  review-email-test-toggle-2026-11.sql — turn the auditor email's test mode
--  on and off from the ตรวจสอบ tab.
--
--  Pong, 2026-11-12: a switch on the ผู้จัดทำ side, in the left column under
--  the months, instead of editing test_to in the SQL editor. Test mode
--  (test_to set) sends every email to that one address only, its subject
--  marked [ทดสอบ]; off sends to review_email_settings.recipients.
--
--    test_addr   the test address, kept while test mode is off so turning it
--                back on needs nothing typed. Filled here once from test_to.
--    review_email_set_test(p_on)
--                on:  test_to = test_addr
--                off: test_to = '' (test_addr keeps the address). Refused
--                     with no recipients, or while an email is queued or
--                     being sent, so nothing queued as a test goes out for
--                     real.
--
--  Turning it off sends nothing by itself: real emails go when a month is
--  sent (ส่ง) or ส่งอีเมล is pressed.
--
--  Run after scripts/review-email-2026-11.sql, in the Supabase SQL editor.
--  Safe to re-run. No backslashes, so it pastes through chat. No addresses
--  here: this repository is public.
-- ============================================================================

alter table public.review_email_settings add column if not exists test_addr text not null default '';
update public.review_email_settings set test_addr = test_to where test_addr = '' and test_to <> '';

create or replace function public.review_email_set_test(p_on boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  s public.review_email_settings;
begin
  if p_on is null then raise exception 'review: bad switch'; end if;
  select * into s from public.review_email_settings where id = 1 for update;
  if not found then raise exception 'review: no email settings'; end if;
  if p_on then
    if s.test_addr = '' and s.test_to = '' then raise exception 'review: no test address'; end if;
    update public.review_email_settings
       set test_to = case when s.test_to <> '' then s.test_to else s.test_addr end,
           test_addr = case when s.test_to <> '' then s.test_to else s.test_addr end,
           updated_at = now()
     where id = 1
    returning * into s;
  else
    if coalesce(cardinality(s.recipients), 0) = 0 then raise exception 'review: no recipients'; end if;
    if exists (select 1 from public.review_emails where status in ('queued', 'sending')) then
      raise exception 'review: an email is still going out';
    end if;
    update public.review_email_settings
       set test_addr = case when s.test_to <> '' then s.test_to else s.test_addr end,
           test_to = '',
           updated_at = now()
     where id = 1
    returning * into s;
  end if;
  -- The same keys the tab reads from the table, with recipients counted.
  return jsonb_build_object(
    'test_to', s.test_to,
    'test_addr', s.test_addr,
    'recipients', coalesce(cardinality(s.recipients), 0));
end;
$$;

revoke all on function public.review_email_set_test(boolean) from public, anon, authenticated;
grant execute on function public.review_email_set_test(boolean) to service_role;
