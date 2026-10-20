-- Run after 003. All new worker RPCs are restricted to service_role.
begin;
alter table public.markets add column if not exists result_checked_at timestamptz;
alter table public.markets add column if not exists result_check_reason text;
alter table public.markets add column if not exists verified_result jsonb;

create or replace function public.railbet_result_targets() returns jsonb
language sql security definer set search_path='' as $$
 with eligible as (
  select id,archive_trip_id,archive_service_date,archive_destination_stop_id,
   arrival,departure,result_checked_at
  from public.markets
  where status not in ('settled','void') and archive_trip_id is not null
   and archive_service_date < (clock_timestamp() at time zone 'Europe/Lisbon')::date
   and archive_service_date >= (clock_timestamp() at time zone 'Europe/Lisbon')::date-30
   and arrival <= clock_timestamp()
 ), selected_days as (
  select archive_service_date from eligible group by archive_service_date
  order by min(coalesce(result_checked_at,'-infinity'::timestamptz)),archive_service_date limit 8
 ), batch as (
  select e.* from eligible e join selected_days using(archive_service_date)
  order by e.result_checked_at nulls first,e.arrival,e.id limit 200
 ) select coalesce(jsonb_agg(to_jsonb(batch)-'result_checked_at'),'[]'::jsonb) from batch;
$$;

-- Shares the existing game rules: 90% prize pool, closest prediction, weighted
-- ties, exact integer allocation, refunds for cancellation or <2 participants.
-- Private helper; only the validated worker function below can invoke it.
create or replace function public._railbet_finalize_archive(
 p_market uuid,p_delay integer,p_verified jsonb
) returns text language plpgsql security definer set search_path='' as $$
declare m public.markets; total bigint; prize bigint; n integer; best integer;
 voided boolean; b record;
begin
 select * into m from public.markets where id=p_market for update;
 if not found then raise exception 'Unknown market'; end if;
 if m.status in ('settled','void') then return 'already_final'; end if;
 select count(*),coalesce(sum(stake),0),min(abs(prediction-p_delay))
  into n,total,best from public.bets where market_id=p_market;
 voided:=p_delay is null or n<2; prize:=total-total/10;
 if voided then
  update public.bets set payout=stake where market_id=p_market;
 else
  update public.bets set payout=0 where market_id=p_market;
  with winners as (
   select id,stake,sum(stake) over() as winner_total from public.bets
   where market_id=p_market and abs(prediction-p_delay)=best
  ), shares as (
   select id,floor(prize::numeric*stake/winner_total)::bigint as base,
    row_number() over(order by mod(prize::numeric*stake,winner_total) desc,id) as pos
   from winners
  ), payouts as (
   select id,base+case when pos<=prize-sum(base) over() then 1 else 0 end as amount
   from shares
  ) update public.bets paid_bet set payout=p.amount from payouts p where paid_bet.id=p.id;
 end if;
 perform p.id from public.players p where p.id in
  (select player_id from public.bets where market_id=p_market) order by p.id for update;
 for b in select * from public.bets where market_id=p_market order by player_id loop
  update public.players set balance=balance+b.payout where id=b.player_id;
  insert into public.ledger(id,player_id,market_id,amount,kind)
   values('payout:'||b.id,b.player_id,p_market,b.payout,'payout');
 end loop;
 update public.markets set status=case when voided then 'void' else 'settled' end,
  actual_delay=p_delay,house_cut=case when voided then 0 else total/10 end,
  result_method='archive_daily',verified_result=p_verified,settled_at=now(),
  result_check_reason=case when p_delay is null then 'cancelled_in_closed_daily_file'
   when n<2 then 'verified_result_refunded_insufficient_participants' else 'verified_daily_destination' end,
  evidence=left('Resultado verificado automaticamente no arquivo diário do Train Archive. '
   ||'Último valor publicado para o destino; não é uma medição independente de chegada. '
   ||(p_verified->>'source')||' SHA-256: '||(p_verified->>'sha256'),2000)
 where id=p_market;
 return case when voided then 'voided' else 'settled' end;
end $$;

create or replace function public.railbet_apply_results(p_items jsonb,p_checks jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' as $$
declare j jsonb; m public.markets; outcome text; d numeric; delay integer;
 observed timestamptz; retrieved timestamptz; reported timestamptz; result text;
 n_settled integer:=0; n_voided integer:=0; n_existing integer:=0; n_checked integer:=0;
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>200
  or jsonb_typeof(p_checks) is distinct from 'array' or jsonb_array_length(p_checks)>200
  then raise exception 'Invalid result verification batch'; end if;
 -- Globally stable acquisition order across multiple market/player settlements.
 -- Manual resolutions also lock markets before players; market row locks and
 -- unique payout ledger ids prevent either route from paying a second time.
 perform pg_advisory_xact_lock(49387013);
 -- Acquire every market lock before any player lock, including when manual
 -- resolution is running concurrently on another market in this batch.
 perform k.id from public.markets k where k.id in (
  select (value->>'marketId')::uuid from jsonb_array_elements(p_items)
  union select (value->>'marketId')::uuid from jsonb_array_elements(p_checks)
 ) order by k.id for update;
 for j in select value from jsonb_array_elements(p_checks) loop
  if coalesce(j->>'reason','') !~ '^[a-z_]{3,100}$' then raise exception 'Invalid verification reason'; end if;
  update public.markets set result_checked_at=clock_timestamp(),result_check_reason=j->>'reason'
   where id=(j->>'marketId')::uuid and status not in ('settled','void');
  n_checked:=n_checked+1;
 end loop;
 for j in select value from jsonb_array_elements(p_items) order by value->>'marketId' loop
  select * into m from public.markets where id=(j->>'marketId')::uuid for update;
  if not found then raise exception 'Unknown verification target'; end if;
  if m.status in ('settled','void') then n_existing:=n_existing+1;continue; end if;
  if m.archive_trip_id is distinct from j->>'tripId'
   or m.archive_service_date is distinct from (j->>'serviceDate')::date
   or m.archive_destination_stop_id is null
   or m.archive_destination_stop_id is distinct from j->>'destinationStopId'
   or m.arrival is distinct from (j->>'scheduledArrival')::timestamptz
   or m.archive_service_date >= (clock_timestamp() at time zone 'Europe/Lisbon')::date
   or m.arrival>clock_timestamp()
   then raise exception 'Result does not match the closed journey'; end if;
  if j->>'source' is distinct from
   'https://data.train-archive.eu/daily/provider=pt-cp/service=TripUpdate/date='||m.archive_service_date::text||'.csv.gz'
   or coalesce(j->>'sha256','') !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(j->'row') is distinct from 'object'
   then raise exception 'Invalid daily archive evidence'; end if;
  retrieved:=(j->>'retrievedAt')::timestamptz;
  if retrieved is null or retrieved>clock_timestamp()+interval '5 minutes'
   then raise exception 'Invalid retrieval time'; end if;
  outcome:=j->>'outcome';delay:=null;
  if outcome='reported_arrival' then
   if coalesce(j->'row'->>'delay_source','') not in ('feed','direct')
    or j->'row'->>'trip_status' is distinct from 'scheduled'
    or coalesce(j->'row'->>'stop_status','') not in ('','scheduled')
    then raise exception 'A prediction or propagated delay cannot settle a result'; end if;
   d:=(j->>'reportedDelayMinutes')::numeric;delay:=(j->>'delayMinutes')::integer;
   observed:=(j->>'observedAt')::timestamptz;reported:=(j->>'reportedArrival')::timestamptz;
   if d is null or d not between -60 and 2880 or delay is null or delay<>greatest(0,trunc(d)::integer)
    or reported is null or abs(extract(epoch from (reported-m.arrival)) - d*60)>1
    or reported>clock_timestamp() or observed is null or observed<reported
    or observed>retrieved+interval '5 minutes'
    then raise exception 'No consistent post-arrival observation for this destination'; end if;
  elsif outcome='cancelled' then
   if coalesce(j->'row'->>'trip_status','') not in ('cancelled','canceled')
    or j->>'delayMinutes' is not null then raise exception 'Cancellation not confirmed in daily file'; end if;
  else raise exception 'Unsupported final outcome'; end if;
  result:=public._railbet_finalize_archive(m.id,delay,j);
  if result='settled' then n_settled:=n_settled+1;
  elsif result='voided' then n_voided:=n_voided+1;
  else n_existing:=n_existing+1;end if;
 end loop;
 return jsonb_build_object('checked',n_checked,'settled',n_settled,'voided',n_voided,'alreadyFinal',n_existing);
end $$;
revoke all on function public.railbet_result_targets(),public.railbet_apply_results(jsonb,jsonb),
 public._railbet_finalize_archive(uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.railbet_result_targets(),public.railbet_apply_results(jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
