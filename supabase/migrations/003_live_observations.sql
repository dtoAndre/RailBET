-- Run after 001 and 002. Observations do NOT settle bets.
begin;
alter table public.markets add column if not exists archive_destination_stop_id text;
alter table public.markets add column if not exists source_observed_at timestamptz;
alter table public.markets add column if not exists source_cancelled boolean not null default false;
create or replace function public.railbet_sync_timetable(p_journeys jsonb,p_version text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j jsonb; u uuid; dep timestamptz; arr timestamptz; d date; n integer:=0; affected integer;
begin
 select a.user_id into u from public.admins a join public.players p on p.id=a.user_id order by a.user_id limit 1;
 if u is null then raise exception 'Configure an administrator who has signed into RailBET first'; end if;
 if jsonb_typeof(p_journeys) is distinct from 'array' or jsonb_array_length(p_journeys)>300 then raise exception 'Invalid timetable batch'; end if;
 perform pg_advisory_xact_lock(49387012);
 for j in select value from jsonb_array_elements(p_journeys) loop
  dep:=(j->>'departure')::timestamptz; arr:=(j->>'arrival')::timestamptz; d:=(j->>'travelDate')::date;
  if dep is null or arr is null or d is null or arr<=dep or arr>dep+interval '48 hours'
   or coalesce(j->>'train','') !~ '^\d{1,6}$' or coalesce(j->>'tripId','')='' or length(j->>'tripId')>200
   or coalesce(j->>'origin','')='' or coalesce(j->>'destination','')=''
   or (dep at time zone 'Europe/Lisbon')::date<>d or j->>'serviceDate' is null
   then raise exception 'Invalid journey'; end if;
  if dep<=clock_timestamp()+interval '10 minutes' or dep>clock_timestamp()+interval '48 hours' then continue; end if;
  -- Immutable betting terms: repeated schedules do not change an existing market.
  insert into public.markets(train,travel_date,service,origin,destination,departure,arrival,closes_at,created_by,source_url,raw_source,checked_at,archive_trip_id,archive_service_date,archive_destination_stop_id)
   values(j->>'train',d,coalesce(j->>'service','Comboio'),j->>'origin',j->>'destination',dep,arr,dep-interval '10 minutes',u,
   'https://data.train-archive.eu/pt-cp/static/latest.json',jsonb_build_object('version',p_version,'journey',j)::text,now(),j->>'tripId',(j->>'serviceDate')::date,j->>'destinationStopId')
   on conflict(train,travel_date) do update set archive_destination_stop_id=excluded.archive_destination_stop_id
   where public.markets.archive_trip_id=excluded.archive_trip_id and public.markets.arrival=excluded.arrival
   and public.markets.destination=excluded.destination and public.markets.archive_destination_stop_id is null;
  get diagnostics affected=row_count; n:=n+affected;
 end loop;
 insert into public.settings(key,value) values('ip_status',jsonb_build_object('ok',true,'message','Horários sincronizados do Train Archive. Atrasos e resultados aguardam confirmação.','checkedAt',now()))
 on conflict(key) do update set value=excluded.value;
 return jsonb_build_object('inserted',n,'received',jsonb_array_length(p_journeys));
end $$;
create or replace function public.railbet_state() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_user(); result jsonb;
begin
 select jsonb_build_object(
  'me',(select to_jsonb(p)||jsonb_build_object('demo_balance',1000) from public.players p where id=u),
  'markets',coalesce((select jsonb_agg(t order by t.departure) from (
   select m.id,m.train,m.travel_date,m.service,m.origin,m.destination,m.departure,m.arrival,m.closes_at,
    case when m.status='open' and m.closes_at<=now() then 'locked' else m.status end as status,
    null::text as demo_owner,m.current_delay,m.actual_delay,m.evidence,m.result_method,m.house_cut,m.checked_at,m.source_observed_at,m.source_cancelled,
    coalesce(sum(b.stake),0) as total,count(b.id) as participants
   from public.markets m left join public.bets b on b.market_id=m.id group by m.id
  ) t),'[]'::jsonb),
  'bets',coalesce((select jsonb_agg(t order by t.created_at desc) from (
   select b.*,p.nickname,0 as bot from public.bets b join public.players p on p.id=b.player_id join public.markets m on m.id=b.market_id
   where b.player_id=u or m.closes_at<=now() or m.status in ('settled','void')
  ) t),'[]'::jsonb),
  'ledger',coalesce((select jsonb_agg(t order by t.created_at desc) from (select l.*,false as demo from public.ledger l where player_id=u order by created_at desc limit 100) t),'[]'::jsonb),
  'ranking',coalesce((select jsonb_agg(t order by t.profit desc,t.nickname,t.id) from (
   select p.id,p.nickname,p.balance,coalesce(sum(b.payout-b.stake) filter(where m.status='settled'),0) as profit,
    count(b.id) filter(where m.status='settled' and b.payout>b.stake) as wins
   from public.players p left join public.bets b on b.player_id=p.id left join public.markets m on m.id=b.market_id
   group by p.id order by profit desc,p.nickname,p.id limit 50
  ) t),'[]'::jsonb),
  'isOwner',exists(select 1 from public.admins where user_id=u),
  'source',(select value from public.settings where key='ip_status'),'serverTime',now()
 ) into result;
 return result;
end $$;


create or replace function public.railbet_worker_targets(p_market uuid default null) returns jsonb
language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(t),'[]'::jsonb) from (
 select id,archive_trip_id,archive_service_date,archive_destination_stop_id,destination,raw_source::jsonb->>'version' as archive_version
 from public.markets where status not in ('settled','void') and archive_trip_id is not null
 and departure<now()+interval '24 hours' and arrival>now()-interval '36 hours'
 and (p_market is null or id=p_market) order by departure limit 300
 ) t;
$$;
create or replace function public.railbet_live_targets(p_market uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin perform public._railbet_admin(); return public.railbet_worker_targets(p_market); end $$;
create or replace function public.railbet_apply_observations(p_items jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare j jsonb; observed timestamptz; n integer:=0; affected integer; delay integer;
begin
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>300 then raise exception 'Invalid observations'; end if;
 for j in select value from jsonb_array_elements(p_items) loop
  observed:=(j->>'observedAt')::timestamptz; delay:=(j->>'delay')::integer;
  if observed is null or observed>clock_timestamp()+interval '5 minutes' or (delay is not null and abs(delay)>2880)
   or coalesce(j->>'source','') !~ '^https://data[.]train-archive[.]eu/provider=pt-cp/service=TripUpdate/date=[0-9-]+/[0-9a-z:_-]+[.]parquet$'
   then raise exception 'Invalid observation'; end if;
  update public.markets set current_delay=case when coalesce((j->>'cancelled')::boolean,false) then null else delay end,
   archive_destination_stop_id=coalesce(archive_destination_stop_id,j->>'destinationStopId'),source_cancelled=coalesce((j->>'cancelled')::boolean,false),source_observed_at=observed,checked_at=clock_timestamp(),source_url=j->>'source'
   where id=(j->>'marketId')::uuid and archive_trip_id=j->>'tripId' and archive_service_date=(j->>'serviceDate')::date
   and (archive_destination_stop_id is null or archive_destination_stop_id=j->>'destinationStopId')
   and (delay is null or nullif(j->>'destinationStopId','') is not null)
   and status not in ('settled','void') and (source_observed_at is null or observed>source_observed_at);
  get diagnostics affected=row_count;n:=n+affected;
 end loop;
 update public.markets set status='locked' where status='open' and closes_at<=clock_timestamp();
 insert into public.settings(key,value) values('ip_status',jsonb_build_object('ok',true,'message',n||' observações novas do Train Archive. Resultados aguardam confirmação manual.','checkedAt',now())) on conflict(key) do update set value=excluded.value;
 return n;
end $$;
create or replace function public.railbet_refresh_observations(p_items jsonb) returns integer
language plpgsql security definer set search_path='' as $$
begin perform public._railbet_admin();return public.railbet_apply_observations(p_items);end $$;
revoke all on function public.railbet_worker_targets(uuid),public.railbet_live_targets(uuid),public.railbet_apply_observations(jsonb),public.railbet_refresh_observations(jsonb) from public,anon,authenticated;
grant execute on function public.railbet_worker_targets(uuid),public.railbet_apply_observations(jsonb) to service_role;
grant execute on function public.railbet_live_targets(uuid),public.railbet_refresh_observations(jsonb) to authenticated;
create or replace function public.railbet_bet(p_market uuid,p_prediction integer,p_stake integer) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_user(); m public.markets; p public.players; old public.bets; bid uuid:=gen_random_uuid();
begin
 if p_prediction is null or p_prediction not between 0 and 360 or p_stake is null or p_stake not between 10 and 500 or p_stake%10<>0 then raise exception 'Palpite ou aposta inválidos.'; end if;
 select * into m from public.markets where id=p_market for update;
 if not found then raise exception 'Viagem não encontrada.'; end if;
 select * into old from public.bets where market_id=p_market and player_id=u;
 if found then
  if old.prediction=p_prediction and old.stake=p_stake then return; end if;
  raise exception 'Já tens um palpite nesta viagem.';
 end if;
 if m.source_cancelled then raise exception 'A fonte indica que esta viagem foi suprimida. Aguarda confirmação.'; end if;
 if m.status<>'open' or m.closes_at<=clock_timestamp() then raise exception 'Os palpites desta viagem já fecharam.'; end if;
 select * into p from public.players where id=u for update;
 if p.balance<p_stake then raise exception 'Saldo insuficiente.'; end if;
 insert into public.bets(id,player_id,market_id,prediction,stake) values(bid,u,p_market,p_prediction,p_stake);
 update public.players set balance=balance-p_stake where id=u;
 insert into public.ledger(id,player_id,market_id,amount,kind) values('stake:'||bid,u,p_market,-p_stake,'stake');
end $$;


notify pgrst,'reload schema';
commit;
