-- RailBET / Supabase Postgres. Run once in the SQL Editor of a new project.
begin;
create table public.players (
 id uuid primary key references auth.users(id) on delete restrict,
 nickname text not null check (char_length(nickname) between 2 and 24),
 balance bigint not null default 1000 check(balance>=0),
 created_at timestamptz not null default now()
);
create table public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
create table public.markets (
 id uuid primary key default gen_random_uuid(), train text not null,
 travel_date date not null, service text not null, origin text not null, destination text not null,
 departure timestamptz not null, arrival timestamptz not null, closes_at timestamptz not null,
 status text not null default 'open' check(status in ('open','locked','settled','void')),
 current_delay integer, actual_delay integer check(actual_delay between 0 and 2880),
 house_cut bigint not null default 0, evidence text, result_method text,
 raw_source text, source_url text, checked_at timestamptz, settled_at timestamptz,
 created_by uuid not null references public.players(id), created_at timestamptz not null default now(),
 unique(train,travel_date), check(arrival>departure), check(closes_at=departure-interval '10 minutes')
);
create table public.bets (
 id uuid primary key default gen_random_uuid(), player_id uuid not null references public.players(id),
 market_id uuid not null references public.markets(id),
 prediction integer not null check(prediction between 0 and 360),
 stake integer not null check(stake between 10 and 500 and stake%10=0),
 payout bigint check(payout>=0), created_at timestamptz not null default now(),
 unique(player_id,market_id)
);
create index bets_market on public.bets(market_id);
create table public.ledger (
 id text primary key, player_id uuid not null references public.players(id),
 market_id uuid references public.markets(id), amount bigint not null,
 kind text not null check(kind in ('stake','payout','weekly')), created_at timestamptz not null default now()
);
create index ledger_player on public.ledger(player_id,created_at desc);
create table public.settings (key text primary key, value jsonb not null);
alter table public.players enable row level security;
alter table public.admins enable row level security;
alter table public.markets enable row level security;
alter table public.bets enable row level security;
alter table public.ledger enable row level security;
alter table public.settings enable row level security;
revoke all on public.players,public.admins,public.markets,public.bets,public.ledger,public.settings from anon,authenticated;

-- Private helpers: identity always comes from a verified Supabase JWT, never a supplied player id.
create function public._railbet_user() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
 if u is null then raise exception 'Entra na tua conta para continuar.'; end if;
 insert into public.players(id,nickname) values(u,'Passageiro '||left(u::text,8)) on conflict(id) do nothing;
 return u;
end $$;
create function public._railbet_admin() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_user();
begin
 if not exists(select 1 from public.admins where user_id=u) then raise exception 'Esta ação exige uma conta de administrador.'; end if;
 return u;
end $$;
create function public.railbet_state() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_user(); result jsonb;
begin
 select jsonb_build_object(
  'me',(select to_jsonb(p)||jsonb_build_object('demo_balance',1000) from public.players p where id=u),
  'markets',coalesce((select jsonb_agg(t order by t.departure) from (
   select m.id,m.train,m.travel_date,m.service,m.origin,m.destination,m.departure,m.arrival,m.closes_at,
    case when m.status='open' and m.closes_at<=now() then 'locked' else m.status end as status,
    null::text as demo_owner,m.current_delay,m.actual_delay,m.evidence,m.result_method,m.house_cut,m.checked_at,
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

create function public.railbet_bet(p_market uuid,p_prediction integer,p_stake integer) returns void language plpgsql security definer set search_path='' as $$
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
 if m.status<>'open' or m.closes_at<=clock_timestamp() then raise exception 'Os palpites desta viagem já fecharam.'; end if;
 select * into p from public.players where id=u for update;
 if p.balance<p_stake then raise exception 'Saldo insuficiente.'; end if;
 insert into public.bets(id,player_id,market_id,prediction,stake) values(bid,u,p_market,p_prediction,p_stake);
 update public.players set balance=balance-p_stake where id=u;
 insert into public.ledger(id,player_id,market_id,amount,kind) values('stake:'||bid,u,p_market,-p_stake,'stake');
end $$;

create function public.railbet_resolve(p_market uuid,p_delay integer,p_evidence text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_admin(); m public.markets; total bigint; prize bigint; n integer; best integer; voided boolean; b record;
begin
 select * into m from public.markets where id=p_market for update;
 if not found then raise exception 'Viagem não encontrada.'; end if;
 if m.status in ('settled','void') then return; end if;
 if p_evidence is null or char_length(btrim(p_evidence)) not between 12 and 2000 then raise exception 'Indica a fonte e justificação do resultado (12 a 2000 caracteres).'; end if;
 if p_delay is not null and (p_delay not between 0 and 2880 or m.arrival>clock_timestamp()) then raise exception 'Aguarda a chegada programada e indica um atraso válido.'; end if;
 select count(*),coalesce(sum(stake),0),min(abs(prediction-p_delay)) into n,total,best from public.bets where market_id=p_market;
 voided:=p_delay is null or n<2; prize:=total-total/10;
 if voided then update public.bets set payout=stake where market_id=p_market;
 else
  update public.bets set payout=0 where market_id=p_market;
  with winners as (
   select id,stake,sum(stake) over() as winner_total from public.bets where market_id=p_market and abs(prediction-p_delay)=best
  ), shares as (
   select id,floor(prize::numeric*stake/winner_total)::bigint as base,
    row_number() over(order by mod(prize::numeric*stake,winner_total) desc,id) as pos from winners
  ), payouts as (
   select id,base+case when pos<=prize-sum(base) over() then 1 else 0 end as amount from shares
  ) update public.bets paid_bet set payout=p.amount from payouts p where paid_bet.id=p.id;
 end if;
 -- Lock players in a stable order for simultaneous resolutions on different trains.
 perform p.id from public.players p where p.id in (select player_id from public.bets where market_id=p_market) order by p.id for update;
 for b in select * from public.bets where market_id=p_market order by player_id loop
  update public.players set balance=balance+b.payout where id=b.player_id;
  insert into public.ledger(id,player_id,market_id,amount,kind) values('payout:'||b.id,b.player_id,p_market,b.payout,'payout');
 end loop;
 update public.markets set status=case when voided then 'void' else 'settled' end,
  actual_delay=p_delay,house_cut=case when voided then 0 else total/10 end,
  evidence=btrim(p_evidence),result_method='manual',settled_at=now() where id=p_market;
end $$;

create function public.railbet_profile(p_nickname text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_user();
begin
 if p_nickname is null or char_length(btrim(p_nickname)) not between 2 and 24 then raise exception 'A alcunha deve ter entre 2 e 24 caracteres.'; end if;
 update public.players set nickname=btrim(p_nickname) where id=u;
end $$;
create function public.railbet_grant() returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_user(); p public.players; last_at timestamptz;
begin
 select * into p from public.players where id=u for update;
 select coalesce(max(created_at),p.created_at) into last_at from public.ledger where player_id=u and kind='weekly';
 if last_at>now()-interval '7 days' then raise exception 'A próxima reposição ainda não está disponível. Volta 7 dias após a entrada ou a última reposição.'; end if;
 update public.players set balance=balance+500 where id=u;
 insert into public.ledger(id,player_id,amount,kind) values('weekly:'||gen_random_uuid(),u,500,'weekly');
end $$;

create function public.railbet_import_gate() returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_admin(); last_at timestamptz;
begin
 insert into public.settings(key,value) values('last_import','"1970-01-01T00:00:00Z"') on conflict do nothing;
 select (value#>>'{}')::timestamptz into last_at from public.settings where key='last_import' for update;
 if last_at>clock_timestamp()-interval '15 seconds' then raise exception 'Aguarda 15 segundos entre consultas à IP.'; end if;
 update public.settings set value=to_jsonb(clock_timestamp()) where key='last_import';
end $$;
create function public.railbet_source_status(p_ok boolean,p_message text) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_admin();
begin
 insert into public.settings(key,value) values('ip_status',jsonb_build_object('ok',p_ok,'message',left(p_message,1000),'checkedAt',now()))
 on conflict(key) do update set value=excluded.value;
end $$;
create function public.railbet_import(p_journey jsonb,p_raw text,p_source text,p_refresh boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare u uuid:=public._railbet_admin(); m public.markets; depart timestamptz; arrive timestamptz; cutoff timestamptz;
begin
 depart:=(p_journey->>'departure')::timestamptz; arrive:=(p_journey->>'arrival')::timestamptz; cutoff:=depart-interval '10 minutes';
 if depart is null or arrive is null or arrive<=depart or p_journey->>'train' !~ '^\d{1,6}$' or coalesce(p_journey->>'origin','')='' or coalesce(p_journey->>'destination','')='' then raise exception 'Horários ou estações inválidos.'; end if;
 if (depart at time zone 'Europe/Lisbon')::date<>(p_journey->>'travelDate')::date then raise exception 'Data de circulação inconsistente.'; end if;
 select * into m from public.markets where train=p_journey->>'train' and travel_date=(p_journey->>'travelDate')::date for update;
 if found then
  if m.status in ('settled','void') then raise exception 'Esta viagem já tem resultado.'; end if;
  -- Freeze the betting terms; refreshing predictions must not alter the closing time or destination.
  update public.markets set current_delay=(p_journey->>'currentDelay')::integer,raw_source=left(p_raw,500000),source_url=p_source,checked_at=now() where id=m.id;
 else
  if p_refresh then raise exception 'Viagem não encontrada.'; end if;
  if cutoff<=clock_timestamp() then raise exception 'Esta viagem já fechou para novos palpites.'; end if;
  if coalesce((p_journey->>'cancelled')::boolean,false) then raise exception 'A IP indica que a viagem foi suprimida.'; end if;
  insert into public.markets(train,travel_date,service,origin,destination,departure,arrival,closes_at,current_delay,raw_source,source_url,checked_at,created_by)
  values(p_journey->>'train',(p_journey->>'travelDate')::date,coalesce(p_journey->>'service','Comboio'),p_journey->>'origin',p_journey->>'destination',depart,arrive,cutoff,(p_journey->>'currentDelay')::integer,left(p_raw,500000),p_source,now(),u);
 end if;
 perform public.railbet_source_status(true,'Horários consultados na IP. O resultado final exige confirmação manual.');
end $$;

-- Supabase grants function execution to PUBLIC by default: explicitly restrict every function.
revoke all on function public._railbet_user(),public._railbet_admin(),public.railbet_state(),public.railbet_bet(uuid,integer,integer),public.railbet_resolve(uuid,integer,text),public.railbet_profile(text),public.railbet_grant(),public.railbet_import_gate(),public.railbet_source_status(boolean,text),public.railbet_import(jsonb,text,text,boolean) from public,anon,authenticated;
grant execute on function public.railbet_state(),public.railbet_bet(uuid,integer,integer),public.railbet_resolve(uuid,integer,text),public.railbet_profile(text),public.railbet_grant(),public.railbet_import_gate(),public.railbet_source_status(boolean,text),public.railbet_import(jsonb,text,text,boolean) to authenticated;
commit;
