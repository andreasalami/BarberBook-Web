-- Server-side booking rules and customer-less owner bookings, for a project created before 2026-11-17.
-- Run once in Supabase Dashboard → SQL Editor, then supabase/tests/rls.sql. New projects get this from schema.sql.

begin;

-- The owner's walk-in and phone bookings no longer belong to the owner's account.
alter table public.bookings alter column customer_id drop not null;
update public.bookings b set customer_id = null from public.shops s where s.id = b.shop_id and s.owner_id = b.customer_id;

-- Server-side booking rules, so a tampered client (or a script) cannot get around what the app shows:
-- the service exists with that exact duration, the shop is open for the whole appointment, and a customer holds at
-- most 4 upcoming bookings per shop. The owner's own bookings (walk-ins, phone calls) get no customer account.
-- ponytail: hours are read in Europe/Rome, as the app shows them; store a time zone per shop if shops abroad join.
create function public.check_booking() returns trigger language plpgsql set search_path = '' as $$
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
create trigger check_booking before insert on public.bookings for each row execute function public.check_booking();

drop policy "book for yourself" on public.bookings;
-- Checked after the check_booking trigger, which clears customer_id on the owner's own bookings.
create policy "book for yourself" on public.bookings for insert to authenticated
  with check ((customer_id = auth.uid() or (customer_id is null and public.owns(shop_id))) and starts_at > now());

commit;

select 'booking checks applied' as result;
