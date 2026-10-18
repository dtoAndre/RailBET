import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settlePool,validateBet} from '../lib/rules.ts';
import {parseIpJourney,lisbonTimeToISO,journeyUrl} from '../lib/ip.ts';
test('nearest tied guesses split 900 credits in a 1:2 ratio',()=>{
 const r=settlePool([{id:'a',stake:100,prediction:12},{id:'b',stake:200,prediction:14},{id:'c',stake:300,prediction:25},{id:'d',stake:400,prediction:40}],13);
 assert.equal(r.houseCut,100);assert.deepEqual(r.payouts.map(p=>p.payout),[300,600,0,0]);
});
test('exact guess beats nearby guesses',()=>{const r=settlePool([{id:'a',stake:100,prediction:13},{id:'b',stake:200,prediction:12}],13);assert.deepEqual(r.payouts.map(p=>p.payout),[270,0]);});
test('integer rounding conserves the full prize for many pools',()=>{
 for(let n=2;n<35;n++)for(let delay=0;delay<40;delay++){
 const bets=Array.from({length:n},(_,i)=>({id:String(i).padStart(3,'0'),stake:10*(i%50+1),prediction:i%11}));
 const r=settlePool(bets,delay);assert.equal(r.payouts.reduce((s,p)=>s+p.payout,0)+r.houseCut,r.total);assert.ok(r.payouts.every(p=>Number.isInteger(p.payout)&&p.payout>=0));
 }
});
test('cancelled or singleton pools refund without a house cut',()=>{
 for(const [bets,delay] of [[[{id:'a',stake:100,prediction:0}],13],[[{id:'a',stake:100,prediction:0},{id:'b',stake:200,prediction:5}],null]]){
 const r=settlePool(bets,delay);assert.equal(r.houseCut,0);assert.equal(r.voided,true);assert.equal(r.payouts.reduce((s,b)=>s+b.payout,0),r.total);
 }
});
test('invalid stakes and delays rejected',()=>{
 for(const s of [-10,0,9,15,501,Infinity,NaN,'100'])assert.throws(()=>validateBet(13,s));
 for(const d of [-1,361,12.5,NaN,'12'])assert.throws(()=>validateBet(d,100));
 validateBet(0,10);validateBet(360,500);
});
test('Lisbon summer, winter and DST ambiguity',()=>{
 assert.equal(lisbonTimeToISO('12:00','2026-07-15'),'2026-07-15T11:00:00.000Z');
 assert.equal(lisbonTimeToISO('12:00','2026-12-15'),'2026-12-15T12:00:00.000Z');
 assert.throws(()=>lisbonTimeToISO('01:30','2026-10-25'));
 assert.throws(()=>lisbonTimeToISO('01:30','2026-03-29'));
});
test('IP forecasts and elapsed schedules never become a final result',()=>{
 const payload={response:{Origem:'Lisboa',Destino:'Porto',TipoServico:'AP',DataHoraOrigem:'08:00',DataHoraDestino:'11:00',SituacaoComboio:'Circula com atraso de 15 min.',NodesPassagemComboio:[{NomeEstacao:'Lisboa',HoraProgramada:'08:00',ComboioPassou:true},{NomeEstacao:'Porto',HoraProgramada:'11:00',ComboioPassou:false,Observacoes:'Hora Prevista:11:15'}]}};
 const j=parseIpJourney(payload,'125','2026-10-18');assert.equal(j.currentDelay,15);assert.equal(j.actualDelay,null);assert.equal(j.finalPassed,false);assert.equal(j.stops[1].passed,false);
});
test('upstream endpoint spelling is preserved and input cannot change the host',()=>{assert.equal(journeyUrl('125','2026-10-18'),'https://www.infraestruturasdeportugal.pt/negocios-e-servicos/horarios-ncombio/125/2026-10-18');assert.throws(()=>journeyUrl('../secret','2026-10-18'));});
