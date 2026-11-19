-- Everything on the 30-minute slot grid: service durations and booking start times.
-- Run once in Supabase Dashboard → SQL Editor, then supabase/tests/rls.sql. New projects get this from schema.sql.
-- Existing bookings are not touched (the trigger checks inserts only).

begin;

-- Durations off the grid are rounded up to the next half hour (on 2026-11-19: only "Barba" 15 min of PROVA2).
update public.services set minutes = greatest(30, ceil(minutes / 30.0)::int * 30) where minutes % 30 <> 0 or minutes < 30;
alter table public.services drop constraint services_minutes_check,
  add constraint services_minutes_check check (minutes between 30 and 480 and minutes % 30 = 0);

create or replace function public.check_booking() returns trigger language plpgsql set search_path = '' as $$
declare
  local_start timestamp := new.starts_at at time zone 'Europe/Rome';
  local_end   timestamp := new.ends_at at time zone 'Europe/Rome';
  hours       jsonb;
begin
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
  select week -> extract(dow from local_start)::int into hours from public.shops where id = new.shop_id;
  if jsonb_typeof(hours) is distinct from 'object' or local_end::date <> local_start::date
     or extract(hour from local_start) * 60 + extract(minute from local_start) < (hours ->> 'open')::int
     or extract(hour from local_end) * 60 + extract(minute from local_end) > (hours ->> 'close')::int then
    raise exception 'Il negozio è chiuso in questo orario.' using errcode = '23514';
  end if;
  return new;
end $$;

commit;
