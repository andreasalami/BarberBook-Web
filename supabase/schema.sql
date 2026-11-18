-- BarberBook database. Run once on a new project: Supabase Dashboard → SQL Editor → paste → Run.
-- Every shop's data is isolated by Row Level Security (RLS): the server enforces it, not the app.
-- Verify with supabase/tests/rls.sql after running this file.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions; -- lets the exclusion constraint mix uuid "=" and range "&&"
create extension if not exists pg_cron with schema pg_catalog; -- nightly retention jobs (bottom of file)

-- 6 characters without look-alikes (no 0/O, 1/I). Not a secret: it only tells the app which shop to open.
create function public.new_shop_code() returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 6)
$$;

-- Tables ---------------------------------------------------------------------------------------------

create table public.shops (
  id       uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique default auth.uid() references auth.users on delete cascade, -- one shop per owner
  code     text not null unique default public.new_shop_code(),
  name     text not null check (char_length(name) between 1 and 80),
  week     jsonb not null check (jsonb_typeof(week) = 'array' and jsonb_array_length(week) = 7) -- [Sun..Sat] {open,close} | null
);

create table public.staff (
  id      uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops on delete cascade,
  name    text not null check (char_length(name) between 1 and 60),
  unique (id, shop_id) -- target of the bookings (staff_id, shop_id) foreign key
);

create table public.services (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  minutes     int  not null check (minutes between 5 and 480),
  price_cents int  not null check (price_cents between 0 and 1000000)
);

-- The only personal data: customer_name (free text, may be a nickname). Readable by its customer and the shop owner.
create table public.bookings (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops on delete cascade,
  staff_id      uuid not null,
  customer_id   uuid default auth.uid() references auth.users on delete cascade, -- null: booked by the owner (walk-in, phone)
  service_name  text not null check (char_length(service_name) between 1 and 80),
  customer_name text not null check (char_length(customer_name) between 1 and 60),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  check (ends_at > starts_at and ends_at - starts_at <= interval '8 hours'),
  foreign key (staff_id, shop_id) references public.staff (id, shop_id) on delete cascade, -- staff must belong to the shop
  -- No double booking: two bookings of the same staff member can never overlap. Touching ([) bounds) is fine.
  exclude using gist (staff_id with =, tstzrange(starts_at, ends_at) with &&)
);
create index on public.bookings (shop_id, starts_at);
create index on public.bookings (customer_id, starts_at);

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

-- Access rules -----------------------------------------------------------------------------------------

alter table public.shops    enable row level security;
alter table public.staff    enable row level security;
alter table public.services enable row level security;
alter table public.bookings enable row level security;

-- The app always holds a session (anonymous or Apple), so nothing is granted to the keyless "anon" role.
revoke all on public.shops, public.staff, public.services, public.bookings from anon;
grant select, insert, update, delete on public.shops, public.staff, public.services, public.bookings to authenticated;

-- True when the caller owns the shop. Runs with the caller's rights: shops are readable by every signed-in user.
create function public.owns(p_shop uuid) returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.shops where id = p_shop and owner_id = auth.uid())
$$;

-- Shop name, hours and catalogue are public business information for any signed-in user.
create policy "read shops" on public.shops for select to authenticated using (true);
create policy "create own shop" on public.shops for insert to authenticated
  with check (owner_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);
create policy "edit own shop" on public.shops for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "delete own shop" on public.shops for delete to authenticated using (owner_id = auth.uid());

create policy "read staff" on public.staff for select to authenticated using (true);
create policy "owner manages staff" on public.staff for all to authenticated
  using (public.owns(shop_id)) with check (public.owns(shop_id));

create policy "read services" on public.services for select to authenticated using (true);
create policy "owner manages services" on public.services for all to authenticated
  using (public.owns(shop_id)) with check (public.owns(shop_id));

create policy "read own or shop bookings" on public.bookings for select to authenticated
  using (customer_id = auth.uid() or public.owns(shop_id));
-- Checked after the check_booking trigger, which clears customer_id on the owner's own bookings.
create policy "book for yourself" on public.bookings for insert to authenticated
  with check ((customer_id = auth.uid() or (customer_id is null and public.owns(shop_id))) and starts_at > now());
create policy "cancel own or shop bookings" on public.bookings for delete to authenticated
  using (customer_id = auth.uid() or public.owns(shop_id));
-- No update policy: bookings are created or cancelled, never edited.

-- Functions called by the app --------------------------------------------------------------------------

-- Busy intervals of one staff member, without names: what a customer needs to see free slots.
-- SECURITY DEFINER on purpose (Security Advisor warns): customers cannot read other customers' bookings.
create function public.busy(p_staff uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select b.starts_at, b.ends_at from public.bookings b
  where b.staff_id = p_staff and b.starts_at < p_to and b.ends_at > p_from
    and p_to - p_from <= interval '2 days'
$$;

-- Deletes the caller's account; shop, staff, services and bookings go with it (on delete cascade).
-- SECURITY DEFINER on purpose (Security Advisor warns): only the database owner may delete from auth.users.
create function public.delete_me() returns void language sql volatile security definer set search_path = '' as $$
  delete from auth.users where id = auth.uid()
$$;

revoke execute on function public.new_shop_code(), public.owns(uuid), public.busy(uuid, timestamptz, timestamptz),
  public.delete_me() from public, anon;
grant execute on function public.new_shop_code(), public.owns(uuid), public.busy(uuid, timestamptz, timestamptz),
  public.delete_me() to authenticated;

-- Retention (runs every night as the database owner) ---------------------------------------------------

-- Bookings are kept 30 days after the appointment, then deleted with the customer name they hold.
select cron.schedule('delete-old-bookings', '17 3 * * *',
  $$delete from public.bookings where ends_at < now() - interval '30 days'$$);

-- Anonymous customers that never booked, or whose bookings were all deleted, are removed after 30 days.
-- If such a customer opens the app again, it silently starts a new anonymous session.
select cron.schedule('delete-idle-anonymous-users', '27 3 * * *',
  $$delete from auth.users u where u.is_anonymous and u.created_at < now() - interval '30 days'
    and not exists (select 1 from public.bookings b where b.customer_id = u.id)$$);
