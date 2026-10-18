import {settlePool,validateBet} from './rules.ts';
import type {State,Market,Bet,Ledger} from './types.ts';
const KEY='railbet-demo-v1',PLAYER='local-demo';
type Demo={version:1;balance:number;nickname:string;createdAt:string;lastGrant:string;markets:Market[];bets:Bet[];ledger:Ledger[]};
const stamp=()=>new Date().toISOString();
function newRound(d:Demo){
 // Keep committed bets and their history; unplayed simulated trains can be replaced.
 d.markets=d.markets.filter(m=>d.bets.some(b=>b.market_id===m.id&&b.player_id===PLAYER));
 d.bets=d.bets.filter(b=>d.markets.some(m=>m.id===b.market_id));
 if(d.markets.filter(m=>m.status==='open').length>9)throw new Error('Conclui algumas viagens de teste antes de criar outra ronda.');
 const routes=[['125','AP','Lisboa Oriente','Porto Campanhã',60,170],['721','IC','Lisboa Santa Apolónia','Braga',95,245],['4501','R','Entroncamento','Coimbra-B',130,100]] as const;
 for(const [train,service,origin,destination,offset,duration] of routes){
  const id=crypto.randomUUID(),departure=new Date(Date.now()+offset*60000).toISOString();
  d.markets.push({id,train,service,origin,destination,departure,arrival:new Date(Date.parse(departure)+duration*60000).toISOString(),travel_date:departure.slice(0,10),closes_at:new Date(Date.parse(departure)-600000).toISOString(),status:'open',demo_owner:PLAYER,total:800,participants:4,current_delay:null,actual_delay:null,evidence:null,result_method:null,house_cut:0,checked_at:null});
  [5,12,20,35].forEach((prediction,i)=>d.bets.push({id:crypto.randomUUID(),market_id:id,player_id:'bot-'+i,prediction,stake:[100,200,300,200][i],payout:null,nickname:['Rita','Tomás','Inês','Miguel'][i]+' (simulado)',created_at:stamp(),bot:1}));
 }
}
function read():Demo{
 const raw=localStorage.getItem(KEY);
 if(raw){try{const d=JSON.parse(raw);if(d.version===1&&Number.isInteger(d.balance)&&d.balance>=0&&Array.isArray(d.markets)&&Array.isArray(d.bets)&&Array.isArray(d.ledger))return d;}catch{/* Unreadable local demo can be recreated. */}}
 const d:Demo={version:1,balance:1000,nickname:'Passageiro',createdAt:stamp(),lastGrant:stamp(),markets:[],bets:[],ledger:[]};newRound(d);save(d);return d;
}
function save(d:Demo){localStorage.setItem(KEY,JSON.stringify(d));}
export function demoState(server:State|null,configured=false):State{
 const d=read(),id=server?.me.id??PLAYER;
 return {...(server??{me:{id,nickname:d.nickname,balance:0,demo_balance:d.balance,created_at:d.createdAt},ranking:[],isOwner:false,source:null,serverTime:stamp()}),
  me:{...(server?.me??{id,nickname:d.nickname,balance:0,created_at:d.createdAt}),demo_balance:d.balance},
  localOnly:!server,configured,
  markets:[...(server?.markets??[]),...d.markets],
  bets:[...(server?.bets??[]),...d.bets.filter(b=>b.player_id===PLAYER||d.markets.find(m=>m.id===b.market_id)?.status==='settled').map(b=>({...b,player_id:b.player_id===PLAYER?id:b.player_id,nickname:b.player_id===PLAYER?(server?.me.nickname??d.nickname):b.nickname}))],
  ledger:[...(server?.ledger??[]),...d.ledger.map(l=>({...l,player_id:id}))].sort((a,b)=>b.created_at.localeCompare(a.created_at))};
}
export function demoAction(action:string,values:Record<string,unknown>={}){
 const d=read();
 if(action==='demo')newRound(d);
 else if(action==='profile'){
  const name=String(values.nickname??'').trim();if(name.length<2||name.length>24)throw new Error('Escolhe uma alcunha com 2 a 24 caracteres.');d.nickname=name;
 }else if(action==='grant'){
  if(Date.now()-Date.parse(d.lastGrant)<7*86400000)throw new Error('A reposição fica disponível 7 dias após a entrada ou a última reposição.');
  d.balance+=500;d.lastGrant=stamp();d.ledger.push({id:crypto.randomUUID(),player_id:PLAYER,amount:500,kind:'weekly',created_at:stamp(),demo:true});
 }else{
  const m=d.markets.find(m=>m.id===values.marketId);if(!m)throw new Error('Viagem de teste não encontrada.');
  const existing=d.bets.find(b=>b.market_id===m.id&&b.player_id===PLAYER);
  if(action==='bet'){
   validateBet(values.prediction,values.stake);
   if(existing){if(existing.prediction===values.prediction&&existing.stake===values.stake)return;throw new Error('Já tens um palpite nesta viagem.');}
   if(m.status!=='open'||Date.now()>=Date.parse(m.closes_at))throw new Error('Os palpites desta viagem já fecharam. Cria uma nova ronda de teste.');
   const stake=values.stake as number;if(d.balance<stake)throw new Error('Saldo insuficiente.');
   const b:Bet={id:crypto.randomUUID(),market_id:m.id,player_id:PLAYER,prediction:values.prediction as number,stake,payout:null,nickname:d.nickname,bot:0,created_at:stamp()};
   d.bets.push(b);d.balance-=stake;m.total+=stake;m.participants++;
   d.ledger.push({id:'stake:'+b.id,player_id:PLAYER,market_id:m.id,amount:-stake,kind:'stake',created_at:stamp(),demo:true});
  }else if(action==='resolve'){
   if(m.status==='settled'||m.status==='void')return;
   if(!existing)throw new Error('Regista primeiro um palpite nesta viagem.');
   const result=settlePool(d.bets.filter(b=>b.market_id===m.id),13);
   for(const p of result.payouts)d.bets.find(b=>b.id===p.id)!.payout=p.payout;
   d.balance+=existing.payout!;
   d.ledger.push({id:'payout:'+existing.id,player_id:PLAYER,market_id:m.id,amount:existing.payout!,kind:'payout',created_at:stamp(),demo:true});
   m.status='settled';m.actual_delay=13;m.house_cut=result.houseCut;m.result_method='simulation';m.evidence='Cenário de demonstração: chegada simulada com 13 minutos de atraso.';
  }else throw new Error('Ação de demonstração desconhecida.');
 }
 save(d);
}
