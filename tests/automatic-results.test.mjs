import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {verifyFinalResult, collectFinalResults} from '../lib/train-results.ts';
import {createWorkerRPC,applyResultBatches} from '../lib/result-worker.ts';

const now = Date.parse('2026-10-20T21:00:00Z'), date = '2026-10-18';
const target = {id:crypto.randomUUID(), archive_trip_id:'121_20251214', archive_service_date:date,
  archive_destination_stop_id:'porto', departure:`${date}T07:00:00.000Z`, arrival:`${date}T09:00:00.000Z`};
const row = (stop_sequence, stop_id, extra={}) => ({trip_id:target.archive_trip_id,service_date:date,
  trip_start_time:'08:00:00',stop_sequence:String(stop_sequence),stop_id,
  stop_name:stop_id,scheduled_departure:`${date} ${stop_sequence ? '10':'08'}:00:00`,
  scheduled_arrival:`${date} ${stop_sequence ? '10':'08'}:00:00`,
  predicted_arrival:`${date} ${stop_sequence ? '10:13':'08:00'}:00`,
  arrival_delay_min:stop_sequence ? '13':'0',delay_source:'feed',trip_status:'scheduled',stop_status:'',
  observed_at:`${date} 10:15:00`,...extra});
const rows = [row(0,'lisboa'),row(1,'porto')];
const metadata = {source:`https://data.train-archive.eu/daily/provider=pt-cp/service=TripUpdate/date=${date}.csv.gz`,
  sha256:'a'.repeat(64),retrievedAt:new Date(now).toISOString()};
const verify = (rs=rows, t=target, meta=metadata) => verifyFinalResult(rs,t,meta,now);
const terminal = extra => [rows[0],row(1,'porto',extra)];

test('closed archive requires exact terminal, schedule and an observation after reported arrival', () => {
  const {result} = verify(); assert.equal(result.delayMinutes,13);
  assert.equal(result.reportedArrival,`${date}T09:13:00.000Z`);
  assert.equal(result.destinationStopId,'porto'); assert.equal(result.sha256,metadata.sha256);
  assert.equal(verify(terminal({observed_at:`${date} 10:05:00`})).reason,'no_post_arrival_destination_observation');
  assert.equal(verify(terminal({observed_at:''})).result,null);
  assert.equal(verify(rows,{...target,archive_service_date:'2026-10-20'}).reason,'service_day_not_closed');
  assert.equal(verify(rows,target,{...metadata,source:metadata.source.replace('/daily/','/')} ).result,null);
});

test('missing, propagated, skipped, ambiguous and mismatched data remain pending', () => {
  for (const extra of [{delay_source:'propagated'},{arrival_delay_min:''},{stop_status:'skipped'},
    {stop_status:'no_data'},{predicted_arrival:`${date} 10:20:00`},{trip_status:'added'},
    {scheduled_arrival:`${date} 10:01:00`}]) assert.equal(verify(terminal(extra)).result,null,JSON.stringify(extra));
  assert.equal(verify([rows[0]]).result,null);
  assert.equal(verify([...rows,rows[1]]).result,null);
  assert.equal(verify(rows,{...target,archive_destination_stop_id:'wrong'}).result,null);
  assert.equal(verify(rows,{...target,archive_destination_stop_id:null}).result,null);
  assert.equal(verify([rows[0],{...rows[1],trip_start_time:'09:00:00'}]).result,null);
  assert.equal(verify(rows,{...target,archive_trip_id:'1210_20251214'}).result,null);
  assert.equal(verify(rows,{...target,departure:`${date}T06:00:00Z`}).result,null);
});

test('full minutes, early arrivals and explicit cancellation follow game rules', () => {
  assert.equal(verify(terminal({arrival_delay_min:'13.5',predicted_arrival:`${date} 10:13:30`})).result.delayMinutes,13);
  assert.equal(verify(terminal({arrival_delay_min:'-2',predicted_arrival:`${date} 09:58:00`})).result.delayMinutes,0);
  const canceled=rows.map(r=>({...r,trip_status:'cancelled'}));
  assert.equal(verify(canceled).result.outcome,'cancelled');assert.equal(verify(canceled).result.delayMinutes,null);
  assert.equal(verify([canceled[0],rows[1]]).result,null);
});

test('worker reads a daily file once per date, handles not-yet-ready and reports decisions', async () => {
  const headers=Object.keys(rows[0]), csv=headers.join(',')+'\n'+rows.map(r=>headers.map(h=>r[h]).join(',')).join('\n');
  let calls=0;
  const request=async(url,options)=>{calls++;assert.equal(url,metadata.source);assert.equal(options.headers['X-Api-Key'],'test');return new Response(gzipSync(csv));};
  const got=await collectFinalResults([target,{...target,id:crypto.randomUUID()}],'test',request,now);
  assert.equal(calls,1);assert.equal(got.results.length,2);assert.match(got.results[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(got.checks[0].reason,'verified_daily_destination');
  const missing=await collectFinalResults([target],'test',async()=>new Response('',{status:404}),now);
  assert.equal(missing.results.length,0);assert.equal(missing.checks[0].reason,'daily_file_not_ready');
  await assert.rejects(collectFinalResults([target],'test',async()=>new Response('',{status:429}),now),/429/);
});

test('each market is saved in its own transaction without losing or duplicating a market',async()=>{
  const checks=Array.from({length:45},()=>({marketId:crypto.randomUUID(),reason:'verified_daily_destination'}));
  const results=checks.filter((_,i)=>i%2===0).map(c=>({...verify().result,marketId:c.marketId}));
  const calls=[];
  const totals=await applyResultBatches(results,checks,async(name,payload)=>{
    assert.equal(name,'railbet_apply_results');calls.push(payload);
    assert.ok(payload.p_items.every(i=>payload.p_checks.some(c=>c.marketId===i.marketId)));
    return {checked:payload.p_checks.length,settled:payload.p_items.length,voided:0,alreadyFinal:0};
  },()=>{});
  assert.equal(calls.length,45);assert.ok(calls.every(c=>c.p_checks.length===1));
  assert.equal(new Set(calls.flatMap(c=>c.p_checks.map(i=>i.marketId))).size,45);
  assert.equal(totals.checked,45);assert.equal(totals.settled,23);
  await assert.rejects(applyResultBatches(results,[...checks,checks[0]],async()=>{},()=>{}),/duplicate/);
});

test('timeouts and database failures identify the exact stage without exposing keys',async()=>{
  const messages=[];
  const rpc=createWorkerRPC('https://example.supabase.co','secret-never-log',async()=>{
    throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  },m=>messages.push(m));
  await assert.rejects(rpc('railbet_result_targets',{}),/Supabase railbet_result_targets failed.*request timeout/);
  assert.ok(messages.every(m=>!m.includes('secret-never-log')));
  const failed=createWorkerRPC('https://example.supabase.co','test',async()=>Response.json({code:'57014'},{status:500}),()=>{});
  await assert.rejects(failed('railbet_apply_results',{}),/railbet_apply_results.*database statement timeout/);
  await assert.rejects(collectFinalResults([target],'test',async()=>{throw new DOMException('Aborted','AbortError');},now),/Train Archive daily 2026-10-18 failed/);
});

test('database permissions, exactly-once payouts, refunds and audit evidence', async t => {
  const {PGlite}=await import(process.env.RAILBET_PGLITE_MODULE ?? '@electric-sql/pglite');
  const db=new PGlite();
  try {
    await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
    const base=process.env.RAILBET_BASE_ROOT;
    for (const f of ['001_railbet.sql','002_train_archive_sync.sql','003_live_observations.sql']) {
      const path=base?pathToFileURL(resolve(base,'supabase/migrations',f)):new URL('../supabase/migrations/'+f,import.meta.url);
      await db.exec(await readFile(path,'utf8'));
    }
    await db.exec(await readFile(new URL('../supabase/migrations/004_automatic_results.sql',import.meta.url),'utf8'));
    const lockMigration=await readFile(new URL('../supabase/migrations/005_result_lock_timeouts.sql',import.meta.url),'utf8');
    await db.exec(lockMigration);await db.exec(lockMigration);
    const players=[crypto.randomUUID(),crypto.randomUUID(),crypto.randomUUID()];
    for (const [i,id] of players.entries()) {await db.query('insert into auth.users values($1)',[id]);await db.query('insert into public.players(id,nickname) values($1,$2)',[id,'Player '+i]);}
    await db.query('insert into public.admins values($1)',[players[0]]);
    async function market(bets=true, count=3) {
      const id=crypto.randomUUID(),train=String(Math.floor(Math.random()*900000+100000));
      await db.query("insert into public.markets(id,train,travel_date,service,origin,destination,departure,arrival,closes_at,created_by,archive_trip_id,archive_service_date,archive_destination_stop_id,status) values($1,$2,$3,'AP','Lisboa','Porto',$4,$5,$4::timestamptz-interval '10 minutes',$6,$7,$3,'porto','locked')",[id,train,date,target.departure,target.arrival,players[0],target.archive_trip_id]);
      if (bets) for (let i=0;i<count;i++) {const stake=[100,200,100][i];await db.query('insert into public.bets(player_id,market_id,prediction,stake) values($1,$2,$3,$4)',[players[i],id,[10,13,15][i],stake]);await db.query('update public.players set balance=balance-$2 where id=$1',[players[i],stake]);}
      return {...verify().result,marketId:id,retrievedAt:new Date().toISOString()};
    }
    const apply=(items,checks=[])=>db.query('select public.railbet_apply_results($1,$2) as result',[JSON.stringify(items),JSON.stringify(checks)]);
    await t.test('players cannot forge a result or call the private payout helper',async()=>{
      await db.exec('set role authenticated');
      await assert.rejects(apply([]),/permission denied/);
      await assert.rejects(db.query('select public.railbet_result_targets()'),/permission denied/);
      await assert.rejects(db.query('select public._railbet_finalize_archive($1,13,$2)',[target.id,'{}']),/permission denied/);
      await db.exec('reset role');
      await db.exec('set role service_role');
      await assert.rejects(db.query('select public._railbet_apply_results_validated($1,$2)',['[]','[]']),/permission denied/);
      await db.exec('reset role');
    });
    await t.test('a verified result pays 90%, records evidence and is idempotent',async()=>{
      const item=await market();await db.exec('set role service_role');
      assert.equal((await apply([item])).rows[0].result.settled,1);
      assert.equal((await apply([item])).rows[0].result.alreadyFinal,1);
      await db.exec('reset role');
      const m=(await db.query('select * from public.markets where id=$1',[item.marketId])).rows[0];
      assert.equal(m.actual_delay,13);assert.equal(Number(m.house_cut),40);assert.equal(m.result_method,'archive_daily');
      assert.equal(m.verified_result.sha256,item.sha256);
      const bets=(await db.query('select prediction,payout from public.bets where market_id=$1 order by prediction',[item.marketId])).rows;
      assert.deepEqual(bets.map(b=>Number(b.payout)),[0,360,0]);
      assert.equal((await db.query('select * from public.ledger where market_id=$1',[item.marketId])).rows.length,3);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[players[0]]);
      await db.query("select public.railbet_resolve($1,99,'Manual retry must not repay')",[item.marketId]);
      assert.equal((await db.query('select actual_delay from public.markets where id=$1',[item.marketId])).rows[0].actual_delay,13);
    });
    await t.test('a manual result is never overwritten by an automatic retry',async()=>{
      const item=await market();await db.query("select public.railbet_resolve($1,15,'Manual confirmed source for this test')",[item.marketId]);
      assert.equal((await apply([item])).rows[0].result.alreadyFinal,1);
      assert.equal((await db.query('select actual_delay from public.markets where id=$1',[item.marketId])).rows[0].actual_delay,15);
    });
    await t.test('missing data only updates check status and never pays',async()=>{
      const item=await market();await apply([],[{marketId:item.marketId,reason:'daily_file_not_ready'}]);
      const m=(await db.query('select * from public.markets where id=$1',[item.marketId])).rows[0];
      assert.equal(m.status,'locked');assert.equal(m.actual_delay,null);assert.equal(m.result_check_reason,'daily_file_not_ready');
      assert.equal((await db.query('select * from public.ledger where market_id=$1',[item.marketId])).rows.length,0);
    });
    await t.test('database rejects propagation, wrong destination and pre-arrival evidence',async()=>{
      const item=await market();
      for(const changed of [{...item,destinationStopId:'wrong'}, {...item,row:{...item.row,delay_source:'propagated'}},
        {...item,observedAt:`${date}T08:00:00Z`}, {...item,delayMinutes:99}, {...item,sha256:'invalid'}]) await assert.rejects(apply([changed]));
      assert.equal((await db.query('select actual_delay from public.markets where id=$1',[item.marketId])).rows[0].actual_delay,null);
    });
    await t.test('cancellation refunds everyone, with no house cut',async()=>{
      const item=await market();const canceled={...item,outcome:'cancelled',delayMinutes:null,reportedDelayMinutes:null,reportedArrival:null,observedAt:null,row:{...item.row,trip_status:'cancelled'}};
      assert.equal((await apply([canceled])).rows[0].result.voided,1);
      const m=(await db.query('select * from public.markets where id=$1',[item.marketId])).rows[0];assert.equal(m.status,'void');assert.equal(Number(m.house_cut),0);
      const bets=(await db.query('select stake,payout from public.bets where market_id=$1',[item.marketId])).rows;assert.ok(bets.every(b=>Number(b.stake)===Number(b.payout)));
    });
    await t.test('one-participant markets refund instead of charging a fee',async()=>{
      const item=await market(true,1);assert.equal((await apply([item])).rows[0].result.voided,1);
      const m=(await db.query('select * from public.markets where id=$1',[item.marketId])).rows[0];assert.equal(m.actual_delay,13);assert.equal(Number(m.house_cut),0);
    });
    await t.test('weighted ties conserve every credit, including integer rounding',async()=>{
      const item=await market();
      for (let i=0;i<3;i++) await db.query('update public.bets set prediction=$3,stake=$4 where market_id=$1 and player_id=$2',[item.marketId,players[i],[12,14,99][i],[100,300,10][i]]);
      await apply([item]);
      const paid=(await db.query('select prediction,payout from public.bets where market_id=$1 order by prediction',[item.marketId])).rows;
      assert.deepEqual(paid.map(b=>Number(b.payout)),[92,277,0]);
      const m=(await db.query('select house_cut from public.markets where id=$1',[item.marketId])).rows[0];
      assert.equal(paid.reduce((s,b)=>s+Number(b.payout),0)+Number(m.house_cut),410);
    });
    await t.test('a lock failure leaves credits untouched and reports a retry instead of failing the job',async()=>{
      const item=await market();
      const definition=(await db.query("select pg_get_functiondef('public._railbet_apply_results_validated(jsonb,jsonb)'::regprocedure) as definition")).rows[0].definition;
      try {
        await db.exec("create or replace function public._railbet_apply_results_validated(p_items jsonb,p_checks jsonb default '[]') returns jsonb language plpgsql security definer set search_path='' as $$ begin insert into public.settings(key,value) values('lock-test','true'); raise exception using errcode='55P03',message='simulated player lock timeout';end $$;");
        const summary=(await apply([item],[{marketId:item.marketId,reason:'verified_daily_destination'}])).rows[0].result;
        assert.equal(summary.busy,1);assert.equal(summary.settled,0);
        assert.equal((await db.query("select * from public.settings where key='lock-test'")).rows.length,0);
        assert.equal((await db.query('select actual_delay from public.markets where id=$1',[item.marketId])).rows[0].actual_delay,null);
        assert.equal((await db.query('select * from public.ledger where market_id=$1',[item.marketId])).rows.length,0);
      } finally {await db.exec(definition);}
      assert.equal((await apply([item])).rows[0].result.settled,1);
    });
  } finally {await db.close();}
});
