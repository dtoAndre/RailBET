-- Run AFTER 001. Only the trusted scheduled worker may execute this function.
begin;
alter table public.markets add column if not exists archive_trip_id text;
alter table public.markets add column if not exists archive_service_date date;
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
  insert into public.markets(train,travel_date,service,origin,destination,departure,arrival,closes_at,created_by,source_url,raw_source,checked_at,archive_trip_id,archive_service_date)
   values(j->>'train',d,coalesce(j->>'service','Comboio'),j->>'origin',j->>'destination',dep,arr,dep-interval '10 minutes',u,
   'https://data.train-archive.eu/pt-cp/static/latest.json',jsonb_build_object('version',p_version,'journey',j)::text,now(),j->>'tripId',(j->>'serviceDate')::date)
   on conflict(train,travel_date) do nothing;
  get diagnostics affected=row_count; n:=n+affected;
 end loop;
 insert into public.settings(key,value) values('ip_status',jsonb_build_object('ok',true,'message','Horários sincronizados do Train Archive. Atrasos e resultados aguardam confirmação.','checkedAt',now()))
 on conflict(key) do update set value=excluded.value;
 return jsonb_build_object('inserted',n,'received',jsonb_array_length(p_journeys));
end $$;
revoke all on function public.railbet_sync_timetable(jsonb,text) from public,anon,authenticated;
grant execute on function public.railbet_sync_timetable(jsonb,text) to service_role;
commit;
