-- Apply AFTER 004. Preserve its verification rules and payment logic.
begin;
do $$
begin
 if to_regprocedure('public._railbet_apply_results_validated(jsonb,jsonb)') is null then
  if to_regprocedure('public.railbet_apply_results(jsonb,jsonb)') is null then
   raise exception 'Install migration 004 before 005';
  end if;
  alter function public.railbet_apply_results(jsonb,jsonb) rename to _railbet_apply_results_validated;
 end if;
end $$;

create or replace function public.railbet_apply_results(p_items jsonb,p_checks jsonb default '[]')
returns jsonb language plpgsql security definer
set search_path='' set lock_timeout='1500ms' as $$
declare market_id uuid; locked_id uuid; items jsonb; checks jsonb; summary jsonb;
 n_checked integer:=0;n_settled integer:=0;n_voided integer:=0;n_existing integer:=0;
 n_busy integer:=0;n_requested integer;
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>200
  or jsonb_typeof(p_checks) is distinct from 'array' or jsonb_array_length(p_checks)>200
  then raise exception 'Invalid result verification batch';end if;
 if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'marketId' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_checks) x group by x->>'marketId' having count(*)>1)
  then raise exception 'Duplicate result verification target';end if;
 select count(*) into n_requested from (
  select (value->>'marketId')::uuid as id from jsonb_array_elements(p_items)
  union select (value->>'marketId')::uuid from jsonb_array_elements(p_checks)
 ) ids;
 -- Never queue behind another automatic payout transaction. The nested
 -- validated function obtains this same transaction lock reentrantly.
 if not pg_try_advisory_xact_lock(49387013) then
  return jsonb_build_object('checked',0,'settled',0,'voided',0,'alreadyFinal',0,'busy',n_requested);
 end if;
 for market_id in
  select id from (
   select (value->>'marketId')::uuid as id from jsonb_array_elements(p_items)
   union select (value->>'marketId')::uuid from jsonb_array_elements(p_checks)
  ) ids order by id
 loop
  -- A savepoint per market rolls back any partial credits/evidence if a player,
  -- market or ledger lock cannot be acquired promptly. Successful other
  -- markets remain valid; busy markets will be retried on the next execution.
  begin
   select id into locked_id from public.markets where id=market_id for update skip locked;
   if not found then
    if not exists(select 1 from public.markets where id=market_id) then raise exception 'Unknown verification target';end if;
    n_busy:=n_busy+1;continue;
   end if;
   select coalesce(jsonb_agg(value),'[]'::jsonb) into items
    from jsonb_array_elements(p_items) where (value->>'marketId')::uuid=market_id;
   select coalesce(jsonb_agg(value),'[]'::jsonb) into checks
    from jsonb_array_elements(p_checks) where (value->>'marketId')::uuid=market_id;
   summary:=public._railbet_apply_results_validated(items,checks);
   n_checked:=n_checked+coalesce((summary->>'checked')::integer,0);
   n_settled:=n_settled+coalesce((summary->>'settled')::integer,0);
   n_voided:=n_voided+coalesce((summary->>'voided')::integer,0);
   n_existing:=n_existing+coalesce((summary->>'alreadyFinal')::integer,0);
  exception when lock_not_available or deadlock_detected then
   n_busy:=n_busy+1;
  end;
 end loop;
 return jsonb_build_object('checked',n_checked,'settled',n_settled,'voided',n_voided,
  'alreadyFinal',n_existing,'busy',n_busy);
end $$;
revoke all on function public._railbet_apply_results_validated(jsonb,jsonb)
 from public,anon,authenticated,service_role;
revoke all on function public.railbet_apply_results(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.railbet_apply_results(jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
