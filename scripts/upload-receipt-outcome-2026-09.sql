-- ============================================================================
--  P4P — record whether the LINE chat receipt actually reached the chat
-- ============================================================================
--  The success receipt is sent by the physician's own browser through
--  liff.sendMessages() (upload/app.ts), so a send that fails — LIFF opened
--  outside a chat, from a group, a revoked permission — used to leave no
--  trace anywhere. The page now reports the outcome to POST /upload/receipt
--  (main.ts), which stamps it here with the service_role key and Telegrams
--  the admin when the receipt did not go out.
--
--  Purely additive, nullable columns: NULL means "no report" (a submission
--  from before this change, or a page closed before the report was sent).
--  No RLS/grant changes — physicians still never touch this table directly.
--  Safe to re-run.
-- ============================================================================

alter table public.p4p_upload_queue
  add column if not exists receipt_status      text,
  add column if not exists receipt_context     text,
  add column if not exists receipt_error       text,
  add column if not exists receipt_reported_at timestamptz;

alter table public.p4p_upload_queue
  drop constraint if exists p4p_upload_queue_receipt_status_check;
alter table public.p4p_upload_queue
  add constraint p4p_upload_queue_receipt_status_check
  check (receipt_status is null or receipt_status in
    ('sent', 'liff_init_failed', 'not_in_client', 'group_chat', 'send_failed'));

comment on column public.p4p_upload_queue.receipt_status is
  'Outcome of the browser-side liff.sendMessages() receipt, reported by /upload/receipt. NULL = never reported.';
comment on column public.p4p_upload_queue.receipt_context is
  'liff.getContext().type when the receipt was attempted (utou, group, room, external, none, …).';

-- Rows whose physician never got a chat receipt:
--   select full_name, month_key, received_at, receipt_status, receipt_context, receipt_error
--   from p4p_upload_queue
--   where receipt_status is distinct from 'sent' and received_at > now() - interval '7 days'
--   order by received_at desc;
