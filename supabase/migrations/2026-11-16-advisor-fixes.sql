-- Security Advisor fixes for a project created with the first version of schema.sql (before 2026-11-16 fixes).
-- Run once in Supabase Dashboard → SQL Editor. New projects get the same result from schema.sql directly.

create schema if not exists extensions;
alter extension btree_gist set schema extensions;              -- "Extension in Public"
alter function public.new_shop_code() set search_path = '';    -- "Function Search Path Mutable"
alter function public.owns(uuid) security invoker;             -- not needed as SECURITY DEFINER

select 'advisor fixes applied' as result;
