import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('scheduled importer: privilege boundary, idempotence, immutable terms and no historical bets',async()=>{
 const db=new PGlite();const id=crypto.randomUUID();
 try{
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
 for(const file of ['001_railbet.sql','002_train_archive_sync.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 await db.query('insert into auth.users values($1)',[id]);await db.query("insert into public.players(id,nickname) values($1,'Admin')",[id]);await db.query('insert into public.admins values($1)',[id]);
 const dep=new Date(Date.now()+86400000),date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon'}).format(dep);
 const j={train:'125',travelDate:date,serviceDate:date,departure:dep.toISOString(),arrival:new Date(+dep+7200000).toISOString(),origin:'Lisboa',destination:'Porto',tripId:'opaque',service:'AP'};
 const run=items=>db.query("select public.railbet_sync_timetable($1::jsonb,'test') as result",[JSON.stringify(items)]);
 await db.exec('set role authenticated');await assert.rejects(run([j]),/permission denied/);
 await db.exec('reset role;set role anon');await assert.rejects(run([j]),/permission denied/);
 await db.exec('reset role;set role service_role');assert.equal((await run([j])).rows[0].result.inserted,1);
 assert.equal((await run([{...j,destination:'Changed'}])).rows[0].result.inserted,0);
 await db.exec('reset role');const m=(await db.query('select * from public.markets')).rows[0];assert.equal(m.destination,'Porto');assert.equal(m.actual_delay,null);assert.equal(m.current_delay,null);assert.equal(m.archive_trip_id,'opaque');
 const past=new Date(Date.now()-86400000);const pastdate=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon'}).format(past);
 assert.equal((await run([{...j,train:'126',travelDate:pastdate,departure:past.toISOString(),arrival:new Date(+past+7200000).toISOString()}])).rows[0].result.inserted,0);
 }finally{await db.close();}
});
