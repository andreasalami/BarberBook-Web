-- Separate customer and owner accounts, stronger booking limits, blocked customers, Web Push and the owner's daily
-- summary (Andrea, 2026-11-20). Applies on top of 20261119120000_30_minute_grid.
-- Customers are anonymous accounts; owners sign in with Google (Apple later, with the iPhone app). One account, one role.

begin;

-- 1. One role per account ------------------------------------------------------------------------------------

-- An account that booked as a customer (e.g. an anonymous user who linked Google) cannot open a shop.
alter policy "create own shop" on public.shops
  with check (owner_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
              and not exists (select 1 from public.bookings b where b.customer_id = auth.uid()));

-- Owners can block a customer account: its new bookings at that shop are refused.
create table public.blocked_customers (
  shop_id       uuid not null references public.shops on delete cascade,
  customer_id   uuid not null references auth.users on delete cascade,
  customer_name text not null check (char_length(customer_name) between 1 and 60), -- as shown when blocked
  created_at    timestamptz not null default now(),
  primary key (shop_id, customer_id)
);
alter table public.blocked_customers enable row level security;
grant select, insert, delete on public.blocked_customers to authenticated;
create policy "owner manages blocked customers" on public.blocked_customers for all to authenticated
  using (public.owns(shop_id)) with check (public.owns(shop_id));

-- Every customer booking, kept for a day even when cancelled, for the hourly limit (book-and-cancel churn).
-- Written only by check_booking (security definer): no grants, no policies.
create table public.booking_log (
  customer_id uuid not null references auth.users on delete cascade,
  created_at  timestamptz not null default now()
);
create index booking_log_customer_idx on public.booking_log (customer_id, created_at);
alter table public.booking_log enable row level security;

-- Same rules as 20261119120000, plus: owner accounts book only walk-ins in their own shop; blocked customers are
-- refused; at most 2 bookings a day per shop and 6 new bookings an hour per customer.
-- Security definer so the checks see every row (blocked list, log), whatever the caller may read.
create or replace function public.check_booking() returns trigger
language plpgsql security definer set search_path = '' as $$
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
    new.customer_id := null; -- walk-in or phone booking: no customer account
  elsif coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false then
    raise exception 'Gli account dei negozi non prenotano come clienti. Prenota dalla sezione Cliente.' using errcode = '23514';
  elsif new.customer_id is distinct from auth.uid() then -- booking for someone else, or passed off as a walk-in
    raise exception 'Operazione non permessa con questo account.' using errcode = '42501';
  else
    if exists (select 1 from public.blocked_customers where shop_id = new.shop_id and customer_id = new.customer_id) then
      raise exception 'Questo negozio non accetta più prenotazioni da questo telefono.' using errcode = '23514';
    end if;
    if (select count(*) from public.bookings
        where customer_id = new.customer_id and shop_id = new.shop_id and ends_at > now()) >= 4 then
      raise exception 'Hai già 4 prenotazioni in questo negozio. Disdicine una per prenotare ancora.' using errcode = '23514';
    end if;
    if (select count(*) from public.bookings
        where customer_id = new.customer_id and shop_id = new.shop_id
          and (starts_at at time zone tz)::date = local_start::date) >= 2 then
      raise exception 'Puoi avere al massimo 2 appuntamenti al giorno in questo negozio.' using errcode = '23514';
    end if;
    if (select count(*) from public.booking_log
        where customer_id = new.customer_id and created_at > now() - interval '1 hour') >= 6 then
      raise exception 'Troppe prenotazioni in poco tempo. Riprova tra un''ora.' using errcode = '23514';
    end if;
    insert into public.booking_log (customer_id) values (new.customer_id); -- rolled back if the insert fails later
  end if;
  if extract(minute from local_start)::int % 30 <> 0 or extract(second from local_start) <> 0 then
    raise exception 'Gli appuntamenti iniziano ogni mezz''ora.' using errcode = '23514';
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
revoke execute on function public.check_booking() from public, anon, authenticated;

-- Deleting an account never takes a shop with it by accident: an owner must ask for it (p_with_shop).
-- A customer's account goes with its own bookings only (on delete cascade).
drop function public.delete_me();
create function public.delete_me(p_with_shop boolean default false) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not p_with_shop and exists (select 1 from public.shops where owner_id = auth.uid()) then
    raise exception 'Questo account ha un negozio: eliminalo dalla sezione Negoziante.' using errcode = '42501';
  end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke execute on function public.delete_me(boolean) from public, anon;
grant execute on function public.delete_me(boolean) to authenticated;

-- 2. Web Push and the daily summary ------------------------------------------------------------------------------

-- A browser's push subscription (JSON with endpoint and keys) is stored as the device token.
alter table public.devices drop constraint devices_platform_check,
  add constraint devices_platform_check check (platform in ('ios', 'android', 'web'));
alter table public.notifications drop constraint notifications_kind_check,
  add constraint notifications_kind_check
    check (kind in ('reminder', 'new_booking', 'cancelled_by_shop', 'cancelled_by_customer', 'summary'));

-- summary_day: null = no summary, 'today' = in the morning for the same day, 'tomorrow' = in the evening for the next.
-- summary_minute: when, in minutes from midnight in the shop's time zone (15-minute steps).
alter table public.shops
  add column summary_day text check (summary_day in ('today', 'tomorrow')),
  add column summary_minute int not null default 1200 check (summary_minute between 0 and 1425 and summary_minute % 15 = 0),
  add column summary_sent_on date;

-- Runs every minute. A summary goes out once a day, within an hour of the chosen time: a missed cron run still sends
-- it, while choosing a time that already passed today waits for tomorrow.
create function public.queue_daily_summaries() returns void
language plpgsql security definer set search_path = '' as $$
declare
  shop      public.shops;
  local_now timestamp;
  now_min   int;
  day       date;
  n         int;
  lines     text;
begin
  for shop in select * from public.shops where summary_day is not null loop
    local_now := now() at time zone shop.time_zone;
    now_min := extract(hour from local_now)::int * 60 + extract(minute from local_now)::int;
    continue when now_min < shop.summary_minute or now_min >= shop.summary_minute + 60
               or shop.summary_sent_on is not distinct from local_now::date;
    day := local_now::date + case shop.summary_day when 'tomorrow' then 1 else 0 end;
    select count(*), string_agg(to_char(b.starts_at at time zone shop.time_zone, 'HH24:MI') || ' ' || b.service_name,
                                ', ' order by b.starts_at)
      into n, lines
      from public.bookings b
      where b.shop_id = shop.id and (b.starts_at at time zone shop.time_zone)::date = day;
    insert into public.notifications (user_id, kind, title, body)
    values (shop.owner_id, 'summary',
            case shop.summary_day when 'tomorrow' then 'Domani' else 'Oggi' end || ': '
              || case n when 0 then 'nessun appuntamento' when 1 then '1 appuntamento' else n || ' appuntamenti' end,
            coalesce(left(lines, 300), 'Agenda libera.'));
    update public.shops set summary_sent_on = local_now::date where id = shop.id;
  end loop;
end $$;
revoke execute on function public.queue_daily_summaries() from public, anon, authenticated;

select cron.schedule('queue-daily-summaries', '* * * * *', $$select public.queue_daily_summaries()$$);
select cron.schedule('delete-old-booking-log', '47 3 * * *',
  $$delete from public.booking_log where created_at < now() - interval '1 day'$$);

-- The sender is the Edge Function send-push (supabase/functions/send-push). Called only when something is due.
-- ponytail: the function takes no input and only sends what is already due, so it needs no secret; calls by
-- others cost invocations only. Add a shared secret (Vault + function secret) if that ever matters.
create extension if not exists pg_net with schema extensions; -- its functions live in the net schema
select cron.schedule('send-push', '* * * * *', $$
  select net.http_post(url := 'https://mhhajacrybeuqilyqjhe.supabase.co/functions/v1/send-push', body := '{}'::jsonb)
  where exists (select 1 from public.notifications where sent_at is null and send_at <= now())
$$);

commit;
