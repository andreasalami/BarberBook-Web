-- Test shop for trying the customer flow on the real project, with synthetic data only.
-- Run in Supabase Dashboard → SQL Editor. The app opens it with code PROVA2.
-- Remove everything it created (shop, staff, services, bookings) with:
--   delete from auth.users where id = 'e0000000-0000-4000-8000-00000000000e';

insert into auth.users (id, aud, role, is_anonymous)
values ('e0000000-0000-4000-8000-00000000000e', 'authenticated', 'authenticated', false); -- synthetic owner, cannot sign in

insert into public.shops (id, owner_id, code, name, week) values (
  'e1000000-0000-4000-8000-000000000000', 'e0000000-0000-4000-8000-00000000000e', 'PROVA2', 'Barberia di Prova',
  '[null, null, {"open":540,"close":1140}, {"open":540,"close":1140}, {"open":540,"close":1140}, {"open":540,"close":1140}, {"open":540,"close":1140}]');

insert into public.staff (shop_id, name) values
  ('e1000000-0000-4000-8000-000000000000', 'Luca'),
  ('e1000000-0000-4000-8000-000000000000', 'Marco');

insert into public.services (shop_id, name, minutes, price_cents) values
  ('e1000000-0000-4000-8000-000000000000', 'Taglio', 30, 1500),
  ('e1000000-0000-4000-8000-000000000000', 'Barba', 30, 1000);

select code, name from public.shops where id = 'e1000000-0000-4000-8000-000000000000';
