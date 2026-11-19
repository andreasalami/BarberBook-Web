-- Per-shop time zone and address, server-side free slots, browsing without login,
-- push device registry and the notification queue (reminders, cancellations, new bookings).
-- Additive only: existing clients keep working.

-- 1. Time zone and address -------------------------------------------------------------------

create function public.is_time_zone(tz text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  perform timestamptz '2000-01-01 00:00Z' at time zone tz;
  return true;
exception when others then
  return false;
end $$;

-- The app fills time_zone from the owner's phone when the shop is created; existing shops are in Italy.
alter table public.shops
  add column time_zone text not null default 'Europe/Rome' check (public.is_time_zone(time_zone)),
  add column address text check (address is null or char_length(address) between 1 and 200);

-- Same rules as before, but opening hours are read in the shop's own time zone.
create or replace function public.check_booking() returns trigger language plpgsql set search_path = '' as $$
declare
  tz          text;
  week        jsonb;
  hours       jsonb;
  local_start timestamp;
  local_end   timestamp;
begin
  select s.time_zone, s.week into tz, week from public.shops s where s.id = new.shop_id;
  local_start := new.starts_at at time zone tz;
  local_end   := new.ends_at at time zone tz;
  if public.owns(new.shop_id) then
    new.customer_id := null;
  elsif (select count(*) from public.bookings
         where customer_id = new.customer_id and shop_id = new.shop_id and ends_at > now()) >= 4 then
    raise exception 'Hai già 4 prenotazioni in questo negozio. Disdicine una per prenotare ancora.' using errcode = '23514';
  end if;
  if not exists (select 1 from public.services where shop_id = new.shop_id and name = new.service_name
                 and new.ends_at - new.starts_at = make_interval(mins => minutes)) then
    raise exception 'Il servizio è cambiato. Controlla la scelta e riprova.' using errcode = '23514';
  end if;
  hours := week -> extract(dow from local_start)::int;
  if jsonb_typeof(hours) is distinct from 'object' or local_end::date <> local_start::date
     or extract(hour from local_start) * 60 + extract(minute from local_start) < (hours ->> 'open')::int
     or extract(hour from local_end) * 60 + extract(minute from local_end) > (hours ->> 'close')::int then
    raise exception 'Il negozio è chiuso in questo orario.' using errcode = '23514';
  end if;
  return new;
end $$;

-- 2. Free slots computed on the server ---------------------------------------------------------
-- One source of truth for both apps: the shop's time zone, the server clock for "now", 15-minute grid.
-- p_day is a calendar day in the shop's time zone. Returns absolute instants; apps display them in that zone.

create function public.free_slots(p_staff uuid, p_service uuid, p_day date)
returns setof timestamptz language plpgsql stable security definer set search_path = '' as $$
declare
  tz       text;
  week     jsonb;
  hours    jsonb;
  duration int;
  m        int;
  s        timestamptz;
  e        timestamptz;
begin
  select sh.time_zone, sh.week, sv.minutes into tz, week, duration
  from public.services sv
  join public.shops sh on sh.id = sv.shop_id
  join public.staff st on st.shop_id = sv.shop_id and st.id = p_staff
  where sv.id = p_service;
  if not found then return; end if;
  hours := week -> extract(dow from p_day)::int;
  if jsonb_typeof(hours) is distinct from 'object' then return; end if;
  for m in select generate_series((hours ->> 'open')::int, (hours ->> 'close')::int - duration, 15) loop
    -- Wall-clock time in the shop, then converted: correct on the 23- and 25-hour days of daylight saving changes.
    s := (p_day + make_interval(mins => m)) at time zone tz;
    e := s + make_interval(mins => duration);
    if s > now() and not exists (select 1 from public.bookings b
                                 where b.staff_id = p_staff and b.starts_at < e and b.ends_at > s) then
      return next s;
    end if;
  end loop;
end $$;

revoke execute on function public.free_slots(uuid, uuid, date) from public;
grant execute on function public.free_slots(uuid, uuid, date) to anon, authenticated;

-- 3. Browse the catalogue without logging in (login is asked at the first booking) ---------------

grant select on public.shops, public.staff, public.services to anon;
alter policy "read shops" on public.shops to anon, authenticated;
alter policy "read staff" on public.staff to anon, authenticated;
alter policy "read services" on public.services to anon, authenticated;

-- 4. Push devices ----------------------------------------------------------------------------------
-- No table policies: apps go through register_device / unregister_device only.

create table public.devices (
  token      text primary key check (char_length(token) between 8 and 4096),
  user_id    uuid not null references auth.users on delete cascade,
  platform   text not null check (platform in ('ios', 'android')),
  sandbox    boolean not null default false, -- iOS debug builds get APNs sandbox tokens
  updated_at timestamptz not null default now()
);
create index devices_user_id_idx on public.devices (user_id);
alter table public.devices enable row level security;

-- A phone that logs in with another account moves its token to that account.
create function public.register_device(p_token text, p_platform text, p_sandbox boolean default false)
returns void language sql security definer set search_path = '' as $$
  insert into public.devices (token, user_id, platform, sandbox)
  values (p_token, auth.uid(), p_platform, p_sandbox)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, sandbox = excluded.sandbox, updated_at = now()
$$;

create function public.unregister_device(p_token text)
returns void language sql security definer set search_path = '' as $$
  delete from public.devices where token = p_token and user_id = auth.uid()
$$;

revoke execute on function public.register_device(text, text, boolean), public.unregister_device(text) from public, anon;
grant execute on function public.register_device(text, text, boolean), public.unregister_device(text) to authenticated;

-- 5. Notification queue --------------------------------------------------------------------------------
-- Written only by triggers, read only by the sender (service role). Cancelling a booking removes its
-- pending reminder in the same transaction, so a reminder for a cancelled appointment can never go out.

create table public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  booking_id uuid, -- no foreign key: the cancellation notice outlives its booking
  kind       text not null check (kind in ('reminder', 'new_booking', 'cancelled_by_shop', 'cancelled_by_customer')),
  title      text not null,
  body       text not null,
  send_at    timestamptz not null default now(),
  sent_at    timestamptz,
  attempts   int not null default 0,
  last_error text
);
create index notifications_due_idx on public.notifications (send_at) where sent_at is null;
create index notifications_booking_idx on public.notifications (booking_id) where sent_at is null;
alter table public.notifications enable row level security;

-- "mar 24/11 alle 10:30" in the shop's time zone, independent of the server locale.
create function public.local_label(p_at timestamptz, p_tz text) returns text
language sql stable set search_path = '' as $$
  select (array['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'])[extract(dow from p_at at time zone p_tz)::int + 1]
         || ' ' || to_char(p_at at time zone p_tz, 'DD/MM "alle" HH24:MI')
$$;

create function public.queue_booking_notifications() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b          public.bookings;
  shop       public.shops;
  staff_name text;
  what       text;
begin
  b := case when tg_op = 'INSERT' then new else old end;
  if tg_op = 'DELETE' then
    delete from public.notifications where booking_id = b.id and kind = 'reminder' and sent_at is null;
  end if;
  -- Past appointments (nightly cleanup) and owner walk-ins notify nobody.
  -- The shop is missing when the whole shop is being deleted.
  select * into shop from public.shops where id = b.shop_id;
  if b.customer_id is null or b.starts_at <= now() or shop.id is null then
    return null;
  end if;
  select name into staff_name from public.staff where id = b.staff_id;
  what := b.service_name || coalesce(' con ' || staff_name, '') || ', ' || public.local_label(b.starts_at, shop.time_zone);

  if tg_op = 'INSERT' then
    if b.starts_at - interval '1 hour' > now() then
      insert into public.notifications (user_id, booking_id, kind, title, body, send_at)
      values (b.customer_id, b.id, 'reminder', 'Tra un''ora da ' || shop.name, what, b.starts_at - interval '1 hour');
    end if;
    insert into public.notifications (user_id, booking_id, kind, title, body)
    values (shop.owner_id, b.id, 'new_booking', 'Nuova prenotazione', b.customer_name || ' · ' || what);
  elsif auth.uid() = shop.owner_id then
    insert into public.notifications (user_id, booking_id, kind, title, body)
    values (b.customer_id, b.id, 'cancelled_by_shop', 'Appuntamento annullato', shop.name || ' ha annullato: ' || what);
  elsif auth.uid() = b.customer_id then
    insert into public.notifications (user_id, booking_id, kind, title, body)
    values (shop.owner_id, b.id, 'cancelled_by_customer', 'Prenotazione disdetta', b.customer_name || ' ha disdetto: ' || what);
  end if;
  return null;
end $$;

create trigger queue_booking_notifications after insert or delete on public.bookings
  for each row execute function public.queue_booking_notifications();

-- Sender side: claim due notifications with their devices. A reminder more than 30 minutes late is dropped
-- (marked as failed) rather than sent after the appointment has started.
create function public.claim_due_notifications(p_limit int default 100)
returns table (id bigint, kind text, title text, body text, booking_id uuid, devices jsonb)
language sql security definer set search_path = '' as $$
  with expired as (
    update public.notifications n set last_error = 'expired', sent_at = now()
    where n.sent_at is null and n.kind = 'reminder' and n.send_at < now() - interval '30 minutes'
  ), due as (
    select n.id from public.notifications n
    where n.sent_at is null and n.send_at <= now() and n.attempts < 5
      and not (n.kind = 'reminder' and n.send_at < now() - interval '30 minutes')
    order by n.send_at
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.notifications n set attempts = n.attempts + 1
    from due where n.id = due.id
    returning n.id, n.user_id, n.kind, n.title, n.body, n.booking_id
  )
  select c.id, c.kind, c.title, c.body, c.booking_id,
         coalesce((select jsonb_agg(jsonb_build_object('token', d.token, 'platform', d.platform, 'sandbox', d.sandbox))
                   from public.devices d where d.user_id = c.user_id), '[]'::jsonb)
  from claimed c
$$;

revoke execute on function public.claim_due_notifications(int) from public, anon, authenticated;
grant execute on function public.claim_due_notifications(int) to service_role;
revoke execute on function public.queue_booking_notifications() from public, anon, authenticated;

select cron.schedule('delete-old-notifications', '37 3 * * *',
  $$delete from public.notifications where coalesce(sent_at, send_at) < now() - interval '30 days'$$);
