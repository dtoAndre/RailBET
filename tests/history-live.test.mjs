import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {gzipSync} from 'node:zlib';
import {journeysFromRows,matchesTrain} from '../lib/archive-journeys.ts';import {fetchArchive} from '../lib/train-archive.ts';import {extractObservations,allowedArchiveURL} from '../lib/train-live.ts';import {siteURL} from '../lib/site-url.ts';import {marketStatus} from '../lib/market-status.ts';import {PGlite} from '@electric-sql/pglite';
const date='2026-10-18',r=(seq,delay,extra={})=>({trip_id:'121_20251214',service_date:date,stop_sequence:String(seq),stop_name:['Lisboa','Coimbra','Porto'][seq],scheduled_arrival:`${date} ${String(8+seq).padStart(2,'0')}:00:00`,arrival_delay_min:delay,delay_source:'feed',...extra});
test('group the complete trip before truncation, use destination delay rather than maximum',async()=>{
 const rows=[r(2,'3'),r(0,'0'),r(1,'15')];const [j]=journeysFromRows(rows,date);assert.equal(j.train,'121');assert.equal(j.destination,'Porto');assert.equal(j.delay,3);assert.deepEqual(j.stops.map(s=>s.delay),[0,15,3]);
 const headers=Object.keys(rows[0]);const all=Array.from({length:110},(_,i)=>rows.map(r=>({...r,trip_id:`${i+100}_20251214`}))).flat();const csv=headers.join(',')+'\n'+all.map(r=>headers.map(h=>r[h]).join(',')).join('\n');
 const result=await fetchArchive(date,'','secret',async()=>new Response(gzipSync(csv)));assert.equal(result.rows.length,300);assert.equal(result.journeys.length,110);assert.ok(result.journeys.every(j=>j.stops.length===3&&j.delay===3));
});
test('missing, propagated, cancelled and ambiguous destinations are not confirmed',()=>{
 assert.equal(journeysFromRows([r(0,'9'),r(2,'')],date)[0].delay,null);
 assert.equal(journeysFromRows([r(0,'0'),r(2,'9',{delay_source:'propagated'})],date)[0].source,'propagated');
 assert.equal(journeysFromRows([r(0,'0'),r(2,'9',{trip_status:'canceled'})],date)[0].delay,null);
 assert.equal(journeysFromRows([r(0,'0'),r(0,'9')],date)[0].ordered,false);
 assert.equal(journeysFromRows([r(0,'0',{service_date:'2026-10-17'}),r(2,'9')],date)[0].stops.length,1);
 assert.equal(matchesTrain(r(0,'0'),'121'),true);assert.equal(matchesTrain({...r(0,'0'),trip_id:'1210_20251214'},'121'),false);
 assert.equal(journeysFromRows([r(0,'0'),r(2,'-2')],date)[0].delay,-2);
});
const target={id:crypto.randomUUID(),archive_trip_id:'121_20251214',archive_service_date:date,archive_destination_stop_id:'porto'};
const source=`https://data.train-archive.eu/provider=pt-cp/service=TripUpdate/date=${date}/day.parquet`;
const record={trip_tripId:'121_20251214',trip_startDate:'20261018',lastSeen:'2026-10-18T14:00:00Z',stopTimeUpdate:[{stopId:'coimbra',arrival:{delay:1200}},{stopId:'porto',arrival:{delay:780}}]};
test('live observations match exact trip/date/destination and preserve absence and freshness',()=>{
 const run=rows=>extractObservations(rows,[target],source,Date.parse('2026-10-19'));
 assert.equal(run([record])[0].delay,13);assert.equal(run([{...record,trip_startDate:'20261017'}]).length,0);
 assert.equal(run([{...record,stopTimeUpdate:record.stopTimeUpdate.slice(0,1)}])[0].delay,null);
 assert.equal(run([{...record,trip_scheduleRelationship:3}])[0].cancelled,true);
 assert.equal(run([{...record,lastSeen:'2030-01-01'}]).length,0);
 assert.equal(run([{...record,lastSeen:'2026-10-18T12:00:00Z'},record])[0].observedAt,record.lastSeen.replace('Z','.000Z'));
 assert.throws(()=>allowedArchiveURL('https://evil.test/a.parquet'));
 assert.equal(allowedArchiveURL(source),source);
});
test('production redirect cannot fall back to localhost or an external next parameter',()=>{
 assert.equal(siteURL('http://localhost:3000/api/auth',{SITE_URL:'https://rail-bet.vercel.app',VERCEL:'1'}),'https://rail-bet.vercel.app');
 assert.throws(()=>siteURL('http://localhost:3000',{VERCEL:'1'}));
 assert.throws(()=>siteURL('https://rail-bet.vercel.app',{SITE_URL:'https://evil.test/path'}));
 assert.equal(siteURL('http://localhost:3000/login',{}),'http://localhost:3000');
});
test('elapsed scheduled arrival means pending confirmation, never settled',()=>{
 const m={status:'locked',departure:'2026-10-18T08:00Z',arrival:'2026-10-18T10:00Z',current_delay:13};
 assert.match(marketStatus(m,Date.parse('2026-10-18T07:59Z')),/aguarda partida/);
 assert.match(marketStatus(m,Date.parse('2026-10-18T10:05Z')),/Em viagem/);
 assert.match(marketStatus(m,Date.parse('2026-10-18T10:14Z')),/Aguarda confirmação/);
});
test('migration: observations require trusted role, never alter terms, pay or overwrite newer data',async()=>{
 const db=new PGlite();try{
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
 for(const f of ['001_railbet.sql','002_train_archive_sync.sql','003_live_observations.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'));
 const uid=crypto.randomUUID();await db.query('insert into auth.users values($1)',[uid]);await db.query("insert into public.players(id,nickname) values($1,'Admin')",[uid]);await db.query('insert into public.admins values($1)',[uid]);
 const dep=new Date(Date.now()+3600000),d=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon'}).format(dep),j={train:'121',tripId:'121_20251214',serviceDate:d,travelDate:d,departure:dep.toISOString(),arrival:new Date(+dep+7200000).toISOString(),origin:'Lisboa',destination:'Porto',destinationStopId:'porto',service:'AP'};
 await db.query("select public.railbet_sync_timetable($1,'test')",[JSON.stringify([j])]);const m=(await db.query('select * from public.markets')).rows[0];assert.equal(m.archive_destination_stop_id,'porto');
 const item={marketId:m.id,tripId:j.tripId,serviceDate:d,destinationStopId:'porto',delay:13,cancelled:false,observedAt:new Date().toISOString(),source};
 const apply=items=>db.query('select public.railbet_apply_observations($1) as count',[JSON.stringify(items)]);
 await db.exec('set role authenticated');await assert.rejects(apply([item]),/permission denied/);await assert.rejects(db.query('select public.railbet_live_targets()'),/conta/);
 await db.exec('reset role;set role service_role');assert.equal((await apply([item])).rows[0].count,1);
 assert.equal((await apply([{...item,delay:50,observedAt:'2020-01-01'}])).rows[0].count,0);
 assert.equal((await apply([{...item,destinationStopId:'wrong'}])).rows[0].count,0);
 await db.exec('reset role');const after=(await db.query('select * from public.markets')).rows[0];assert.equal(after.current_delay,13);assert.equal(after.actual_delay,null);assert.equal(+after.closes_at,+m.closes_at);assert.equal(after.status,'open');assert.equal((await db.query('select * from public.ledger')).rows.length,0);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
 await db.query('update public.markets set source_cancelled=true where id=$1',[m.id]);
 await db.exec('set role authenticated');
 await assert.rejects(db.query('select public.railbet_bet($1,10,100)',[m.id]),/suprimida/);
 await db.exec('reset role');
 assert.equal((await db.query('select * from public.bets')).rows.length,0);
 assert.equal((await db.query('select * from public.ledger')).rows.length,0);
 }finally{await db.close();}
});
