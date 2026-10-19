import test from 'node:test';
import assert from 'node:assert/strict';
import {demoAction,demoState} from '../lib/demo.ts';
test('local demo: bet, weighted tie, persistence, duplicate protection and separate wallet',()=>{
 const memory=new Map();globalThis.localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
 let s=demoState(null);assert.equal(s.me.demo_balance,1000);assert.equal(s.localOnly,true);assert.equal(s.ranking.length,0);assert.equal(s.markets.length,3);
 const m=s.markets[0];demoAction('bet',{marketId:m.id,prediction:12,stake:100});demoAction('bet',{marketId:m.id,prediction:12,stake:100});
 s=demoState(null);assert.equal(s.me.demo_balance,900);assert.equal(s.bets.length,1);assert.equal(s.markets[0].total,900);
 demoAction('resolve',{marketId:m.id});demoAction('resolve',{marketId:m.id});s=demoState(null);assert.equal(s.me.demo_balance,1170);assert.equal(s.bets.find(b=>b.player_id===s.me.id).payout,270);assert.equal(s.ledger.length,2);
 const shared={...s,me:{...s.me,id:'authenticated-player',balance:777},markets:[],bets:[],ledger:[]};
 s=demoState(shared,true);assert.equal(s.me.balance,777);assert.equal(s.me.demo_balance,1170);assert.equal(s.bets.find(b=>!b.bot).player_id,'authenticated-player');
 assert.throws(()=>demoAction('grant'),/7 dias/);demoAction('demo');assert.equal(demoState(null).markets.length,4);
});
