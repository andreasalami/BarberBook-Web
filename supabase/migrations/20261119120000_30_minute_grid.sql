-- Everything on the 30-minute slot grid (Andrea, 2026-11-19): service durations, booking start times, free_slots.
-- Applies on top of 20261118120000_timezone_slots_notifications (live since 2026-11-18): check_booking keeps the
-- shop's own time zone. Existing bookings are not touched (the trigger checks inserts only).

begin;

-- Durations off the grid are rounded up to the next half hour (on 2026-11-19: only "Barba" 15 min of PROVA2).
update public.services set minutes = greatest(30, ceil(minutes / 30.0)::int * 30) where minutes % 30 <> 0 or minutes < 30;
alter table public.services drop constraint services_minutes_check,
  add constraint services_minutes_check check (minutes between 30 and 480 and minutes % 30 = 0);

-- Same rules as 20261118120000, plus: the appointment starts on the hour or half hour, in the shop's time zone.
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

-- Same as 20261118120000 with a 30-minute grid instead of 15. "create or replace" keeps the grants.
create or replace function public.free_slots(p_staff uuid, p_service uuid, p_day date)
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
  for m in select generate_series((hours ->> 'open')::int, (hours ->> 'close')::int - duration, 30) loop
    -- Wall-clock time in the shop, then converted: correct on the 23- and 25-hour days of daylight saving changes.
    s := (p_day + make_interval(mins => m)) at time zone tz;
    e := s + make_interval(mins => duration);
    if s > now() and not exists (select 1 from public.bookings b
                                 where b.staff_id = p_staff and b.starts_at < e and b.ends_at > s) then
      return next s;
    end if;
  end loop;
end $$;

commit;
