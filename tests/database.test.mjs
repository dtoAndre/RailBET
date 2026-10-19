import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {settlePool} from '../lib/rules.ts';

test('Postgres: identity, private predictions and atomic credit lifecycle',async t=>{
 const db=new PGlite();
 const ids=Array.from({length:4},()=>crypto.randomUUID());
 const query=(s,p=[])=>db.query(s,p);
 const user=async id=>{await db.exec('reset role');await query("select set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(id?'set role authenticated':'set role anon');};
 const root=()=>db.exec('reset role');
 const rpc=async(name,args=[])=>{const r=await query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args);return r.rows[0].value;};
 let train=100,market;
 const journey=()=>({train:String(train++),travelDate:new Date(Date.now()+86400000).toISOString().slice(0,10),service:'AP',origin:'Lisboa',destination:'Porto',departure:new Date(Date.now()+86400000).toISOString(),arrival:new Date(Date.now()+90000000).toISOString(),currentDelay:null,cancelled:false});
 const create=async()=>{await user(ids[0]);const j=journey();await rpc('railbet_import',[j,'{}','https://example.test/evidence',false]);return (await rpc('railbet_state')).markets.find(m=>m.train===j.train).id;};
 const past=async id=>{await root();await query("update public.markets set departure=now()-interval '4 hours',closes_at=now()-interval '4 hours 10 minutes',arrival=now()-interval '1 hour' where id=$1",[id]);};
 try{
  await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
  for(const id of ids)await query('insert into auth.users values($1)',[id]);
  await db.exec(await readFile(new URL('../supabase/migrations/001_railbet.sql',import.meta.url),'utf8'));
  await t.test('anonymous users and direct table writes are denied',async()=>{
   await user(null);await assert.rejects(rpc('railbet_state'),/permission denied/);
   await user(ids[0]);const state=await rpc('railbet_state');assert.equal(state.me.balance,1000);assert.equal(state.isOwner,false);
   await assert.rejects(query('update public.players set balance=999999'),/permission denied/);
   await assert.rejects(rpc('_railbet_admin'),/permission denied/);
   await assert.rejects(rpc('railbet_import_gate'),/administrador/);
   await root();await query('insert into public.admins values($1)',[ids[0]]);
  });
  await t.test('stakes debit once, guesses stay private, closing time is enforced',async()=>{
   market=await create();
   for(let i=0;i<4;i++){await user(ids[i]);await rpc('railbet_bet',[market,[12,14,30,30][i],[100,200,500,200][i]]);}
   await user(ids[0]);await rpc('railbet_bet',[market,12,100]);let s=await rpc('railbet_state');
   assert.equal(s.me.balance,900);assert.equal(s.bets.length,1);assert.equal(s.markets[0].total,1000);assert.equal(s.markets[0].participants,4);
   await assert.rejects(rpc('railbet_bet',[market,20,100]),/Já tens/);
   await assert.rejects(rpc('railbet_bet',[market,12,11]),/inválidos/);
   await assert.rejects(rpc('railbet_resolve',[market,13,'Fonte: chegada observada às 18:13.']),/Aguarda/);
   await user(ids[1]);await assert.rejects(rpc('railbet_resolve',[market,13,'Fonte: chegada observada às 18:13.']),/administrador/);
   const closed=await create();await past(closed);await user(ids[2]);await assert.rejects(rpc('railbet_bet',[closed,10,10]),/fecharam/);
   const other=await create();await user(ids[2]);await rpc('railbet_bet',[other,10,500]);
   const third=await create();await user(ids[2]);await assert.rejects(rpc('railbet_bet',[third,10,10]),/Saldo insuficiente/);
  });
  await t.test('settlement pays proportional ties, preserves credits and is idempotent',async()=>{
   await past(market);
   await db.exec("create function public.test_fail_payout() returns trigger language plpgsql as $$begin if new.kind='payout' then raise exception 'test interruption'; end if;return new;end$$;create trigger test_failure before insert on public.ledger for each row execute function public.test_fail_payout();");
   await user(ids[0]);await assert.rejects(rpc('railbet_resolve',[market,13,'Fonte: chegada observada às 18:13.']),/test interruption/);
   const rolledBack=await rpc('railbet_state');assert.equal(rolledBack.me.balance,900);assert.equal(rolledBack.bets.find(b=>b.market_id===market).payout,null);
   await root();await db.exec('drop trigger test_failure on public.ledger;drop function public.test_fail_payout();');
   await user(ids[0]);await rpc('railbet_resolve',[market,13,'Fonte: chegada observada às 18:13.']);
   const s=await rpc('railbet_state'),m=s.markets.find(m=>m.id===market),bets=s.bets.filter(b=>b.market_id===market);
   assert.equal(s.me.balance,1200);assert.equal(m.house_cut,100);assert.equal(bets.find(b=>b.player_id===ids[0]).payout,300);assert.equal(bets.find(b=>b.player_id===ids[1]).payout,600);
   assert.equal(bets.reduce((a,b)=>a+b.payout,0)+m.house_cut,1000);
   await rpc('railbet_resolve',[market,50,'Tentativa repetida: outro resultado.']);assert.equal((await rpc('railbet_state')).me.balance,1200);
   assert.equal((await rpc('railbet_state')).ledger.filter(l=>l.kind==='payout'&&l.market_id===market).length,1);
  });
  await t.test('SQL remainder allocation matches the reference implementation',async()=>{
   await root();await query('update public.players set balance=1000');
   const m=await create();for(let i=0;i<4;i++){await user(ids[i]);await rpc('railbet_bet',[m,[12,12,12,50][i],[10,20,40,30][i]]);}
   await past(m);await user(ids[0]);await rpc('railbet_resolve',[m,12,'Fonte: atraso confirmado, doze minutos.']);
   const s=await rpc('railbet_state'),bets=s.bets.filter(b=>b.market_id===m),expected=settlePool(bets,12);
   for(const b of bets)assert.equal(b.payout,expected.payouts.find(p=>p.id===b.id).payout);
   assert.equal(bets.reduce((s,b)=>s+b.payout,0),90);
  });
  await t.test('single-participant and cancelled trips refund without a house cut',async()=>{
   for(const delay of [10,null]){const m=await create();await rpc('railbet_bet',[m,9,100]);const before=(await rpc('railbet_state')).me.balance;await past(m);await user(ids[0]);await rpc('railbet_resolve',[m,delay,'Fonte: viagem anulada ou participante único.']);const s=await rpc('railbet_state');assert.equal(s.me.balance,before+100);assert.equal(s.markets.find(x=>x.id===m).status,'void');assert.equal(s.markets.find(x=>x.id===m).house_cut,0);}
  });
  await t.test('weekly top-ups and upstream throttling cannot be repeated',async()=>{
   await user(ids[0]);await assert.rejects(rpc('railbet_grant'),/reposição/);
   await root();await query("update public.players set created_at=now()-interval '8 days' where id=$1",[ids[0]]);
   await user(ids[0]);const before=(await rpc('railbet_state')).me.balance;await rpc('railbet_grant');assert.equal((await rpc('railbet_state')).me.balance,before+500);await assert.rejects(rpc('railbet_grant'),/reposição/);
   await rpc('railbet_import_gate');await assert.rejects(rpc('railbet_import_gate'),/15 segundos/);
  });
  await t.test('source refresh keeps the original betting terms',async()=>{
   const m=await create(),s=await rpc('railbet_state'),original=s.markets.find(x=>x.id===m);
   await rpc('railbet_import',[{...journey(),train:original.train,travelDate:original.travel_date,destination:'Outra estação',currentDelay:20},'{}','https://example.test',true]);
   const updated=(await rpc('railbet_state')).markets.find(x=>x.id===m);
   assert.equal(updated.destination,original.destination);assert.equal(updated.closes_at,original.closes_at);assert.equal(updated.current_delay,20);
  });
 }finally{await db.close();}
});
