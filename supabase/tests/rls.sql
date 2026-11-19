-- Tenant-isolation checks for supabase/schema.sql, with synthetic users. Nothing is kept: everything is rolled back.
-- Run in Supabase Dashboard → SQL Editor. Success = one row "RLS checks passed". Any failure stops with "FAIL: ...".
-- Users are simulated the way PostgREST does it: role "authenticated" + JWT claims in request.jwt.claims.

begin;

-- Test times in shop time (Europe/Rome): t(7, '10:00') = a week from today at 10:00, same weekday as today.
create function public.t(days int, hhmm text) returns timestamptz language sql stable as
  $$ select (((now() at time zone 'Europe/Rome')::date + days) + hhmm::time) at time zone 'Europe/Rome' $$;
grant execute on function public.t(int, text) to authenticated;

-- Synthetic accounts: two owners (Apple), two anonymous customers.
insert into auth.users (id, aud, role, is_anonymous) values
  ('a0000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', false), -- owner A
  ('b0000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', false), -- owner B
  ('c0000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', true),  -- customer C
  ('d0000000-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', true);  -- customer D

-- Owner A creates shop A with one staff member and one service.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
insert into public.shops (id, name, week) values ('a1000000-0000-4000-8000-000000000000', 'Shop A',
  (select jsonb_agg('{"open":540,"close":1140}'::jsonb) from generate_series(1, 7))); -- open every day 09:00-19:00
insert into public.staff (id, shop_id, name) values ('a2000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-000000000000', 'Anna');
insert into public.services (shop_id, name, minutes, price_cents) values ('a1000000-0000-4000-8000-000000000000', 'Taglio', 30, 1500);
do $$ begin
  if (select code from public.shops where id = 'a1000000-0000-4000-8000-000000000000') !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'FAIL: shop code format';
  end if;
  begin
    insert into public.services (shop_id, name, minutes, price_cents) values ('a1000000-0000-4000-8000-000000000000', 'Barba', 15, 1000);
    raise exception 'FAIL: 15-minute service accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.shops (name, week) values ('Second shop', '[null,null,null,null,null,null,null]');
    raise exception 'FAIL: owner created a second shop';
  exception when unique_violation then null;
  end;
end $$;
reset role;

-- Owner B creates shop B with one staff member.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
insert into public.shops (id, name, week) values ('b1000000-0000-4000-8000-000000000000', 'Shop B', '[null,null,null,null,null,null,null]');
insert into public.staff (id, shop_id, name) values ('b2000000-0000-4000-8000-000000000000', 'b1000000-0000-4000-8000-000000000000', 'Bruno');
insert into public.services (shop_id, name, minutes, price_cents) values ('b1000000-0000-4000-8000-000000000000', 'Taglio', 30, 1500);
reset role;

-- Customer C books at shop A.
select set_config('request.jwt.claims', '{"sub":"c0000000-0000-4000-8000-00000000000c","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
insert into public.bookings (id, shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
  ('c1000000-0000-4000-8000-000000000000', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000',
   'Taglio', 'Carlo', public.t(7, '10:00'), public.t(7, '10:30'));
do $$ begin
  -- Anonymous users cannot open a shop.
  begin
    insert into public.shops (name, week) values ('Fake', '[null,null,null,null,null,null,null]');
    raise exception 'FAIL: anonymous user created a shop';
  exception when insufficient_privilege then null;
  end;
  -- Customers cannot touch a shop catalogue.
  begin
    insert into public.services (shop_id, name, minutes, price_cents) values ('a1000000-0000-4000-8000-000000000000', 'X', 30, 0);
    raise exception 'FAIL: customer added a service';
  exception when insufficient_privilege then null;
  end;
  -- Staff of shop B cannot be booked under shop A.
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '11:00'), public.t(7, '11:30'));
    raise exception 'FAIL: booked staff of another shop';
  exception when foreign_key_violation then null;
  end;
  -- Bookings in the past are refused.
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(-7, '10:00'), public.t(-7, '10:30'));
    raise exception 'FAIL: booked in the past';
  exception when insufficient_privilege then null;
  end;
  -- Booking on behalf of someone else is refused.
  begin
    insert into public.bookings (shop_id, staff_id, customer_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'd0000000-0000-4000-8000-00000000000d',
       'Taglio', 'Dora', public.t(7, '12:00'), public.t(7, '12:30'));
    raise exception 'FAIL: booked as another customer';
  exception when insufficient_privilege then null;
  end;
  -- A customer cannot pass a booking off as the owner's (no customer account).
  begin
    insert into public.bookings (shop_id, staff_id, customer_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', null,
       'Taglio', 'Carlo', public.t(7, '12:00'), public.t(7, '12:30'));
    raise exception 'FAIL: customer booked without a customer account';
  exception when insufficient_privilege then null;
  end;
  -- Unknown service, wrong duration, outside opening hours, closed day: all refused by the server.
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'X', 'Carlo',
       public.t(7, '12:00'), public.t(7, '12:30'));
    raise exception 'FAIL: booked an unknown service';
  exception when check_violation then null;
  end;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '12:00'), public.t(7, '16:00'));
    raise exception 'FAIL: booked a 30-minute service for 4 hours';
  exception when check_violation then null;
  end;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '19:00'), public.t(7, '19:30'));
    raise exception 'FAIL: booked past closing time';
  exception when check_violation then null;
  end;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '08:30'), public.t(7, '09:00'));
    raise exception 'FAIL: booked before opening time';
  exception when check_violation then null;
  end;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '12:15'), public.t(7, '12:45'));
    raise exception 'FAIL: booked off the 30-minute grid';
  exception when check_violation then null;
  end;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '10:00'), public.t(7, '10:30'));
    raise exception 'FAIL: booked a shop on a closed day';
  exception when check_violation then null;
  end;
  -- At most 4 upcoming bookings per customer and shop.
  insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at)
  select 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
         public.t(7, h), public.t(7, h) + interval '30 minutes'
  from unnest(array['13:00', '14:00', '15:00']) h;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Carlo',
       public.t(7, '16:00'), public.t(7, '16:30'));
    raise exception 'FAIL: fifth upcoming booking accepted';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- Customer D: cannot see or cancel C's booking, sees only busy times, cannot double book.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
do $$
declare n int;
begin
  if exists (select 1 from public.bookings) then raise exception 'FAIL: customer D sees bookings of others'; end if;
  with gone as (delete from public.bookings where id = 'c1000000-0000-4000-8000-000000000000' returning 1)
  select count(*) into n from gone;
  if n <> 0 then raise exception 'FAIL: customer D cancelled a booking of C'; end if;
  select count(*) into n from public.busy('a2000000-0000-4000-8000-000000000000', public.t(7, '00:00'), public.t(8, '00:00'));
  if n <> 4 then raise exception 'FAIL: busy() returned % intervals, expected 4', n; end if;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Dora',
       public.t(7, '10:00'), public.t(7, '10:30'));
    raise exception 'FAIL: overlapping booking accepted';
  exception when exclusion_violation then null;
  end;
  -- Back-to-back (starts exactly when C ends) is allowed.
  insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
    ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Dora',
     public.t(7, '10:30'), public.t(7, '11:00'));
end $$;
reset role;

-- Owner B: sees nothing of shop A and cannot change it.
select set_config('request.jwt.claims', '{"sub":"b0000000-0000-4000-8000-00000000000b","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
do $$
declare n int;
begin
  if exists (select 1 from public.bookings) then raise exception 'FAIL: owner B sees bookings of shop A'; end if;
  with changed as (update public.shops set name = 'Hacked' where id = 'a1000000-0000-4000-8000-000000000000' returning 1)
  select count(*) into n from changed;
  if n <> 0 then raise exception 'FAIL: owner B renamed shop A'; end if;
  with gone as (delete from public.staff where shop_id = 'a1000000-0000-4000-8000-000000000000' returning 1)
  select count(*) into n from gone;
  if n <> 0 then raise exception 'FAIL: owner B deleted staff of shop A'; end if;
  begin
    insert into public.staff (shop_id, name) values ('a1000000-0000-4000-8000-000000000000', 'Intruder');
    raise exception 'FAIL: owner B added staff to shop A';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.shops set owner_id = 'a0000000-0000-4000-8000-00000000000a' where id = 'b1000000-0000-4000-8000-000000000000';
    raise exception 'FAIL: owner B handed shop B to someone else';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Owner A: sees both bookings of the shop with names, can cancel a customer's booking.
select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-00000000000a","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.bookings where customer_name in ('Carlo', 'Dora');
  if n <> 5 then raise exception 'FAIL: owner A sees % bookings, expected 5', n; end if;
  -- Walk-ins: no limit, and no customer account (so they never show up in the owner's own "Le mie").
  insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at)
  select 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Al banco',
         public.t(8, h), public.t(8, h) + interval '30 minutes'
  from unnest(array['09:00', '09:30', '10:00', '10:30', '11:00']) h;
  select count(*) into n from public.bookings where customer_name = 'Al banco' and customer_id is null;
  if n <> 5 then raise exception 'FAIL: owner walk-ins: % without customer account, expected 5', n; end if;
  begin
    insert into public.bookings (shop_id, staff_id, service_name, customer_name, starts_at, ends_at) values
      ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000000', 'Taglio', 'Al banco',
       public.t(8, '19:00'), public.t(8, '19:30'));
    raise exception 'FAIL: owner booked after closing time';
  exception when check_violation then null;
  end;
  with gone as (delete from public.bookings where id = 'c1000000-0000-4000-8000-000000000000' returning 1)
  select count(*) into n from gone;
  if n <> 1 then raise exception 'FAIL: owner A could not cancel a booking'; end if;
end $$;
reset role;

-- Customer D deletes their account: their booking disappears with it.
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-00000000000d","role":"authenticated","is_anonymous":true}', true);
set local role authenticated;
select public.delete_me();
reset role;
do $$ begin
  if exists (select 1 from auth.users where id = 'd0000000-0000-4000-8000-00000000000d') then raise exception 'FAIL: delete_me kept the user'; end if;
  if exists (select 1 from public.bookings where customer_name = 'Dora') then raise exception 'FAIL: delete_me kept the bookings'; end if;
end $$;

-- Keyless requests (no session) may browse the catalogue (since 20261118120000) but never see bookings.
set local role anon;
do $$ begin
  if not exists (select 1 from public.shops) then raise exception 'FAIL: anon role cannot browse shops'; end if;
  begin
    perform 1 from public.bookings;
    raise exception 'FAIL: anon role can read bookings';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin
  if exists (select 1 from public.free_slots('a2000000-0000-4000-8000-000000000000',
               (select id from public.services where shop_id = 'a1000000-0000-4000-8000-000000000000' limit 1),
               (now() at time zone 'Europe/Rome')::date + 7) s
             where extract(minute from s at time zone 'Europe/Rome')::int % 30 <> 0) then
    raise exception 'FAIL: free_slots off the 30-minute grid';
  end if;
  if not exists (select 1 from public.free_slots('a2000000-0000-4000-8000-000000000000',
               (select id from public.services where shop_id = 'a1000000-0000-4000-8000-000000000000' limit 1),
               (now() at time zone 'Europe/Rome')::date + 7)) then
    raise exception 'FAIL: free_slots returned nothing on an open day';
  end if;
end $$;

select 'RLS checks passed' as result; -- only reached when every check above passed
rollback;
