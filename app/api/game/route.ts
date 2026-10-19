import {configured,supabase} from '../../../lib/supabase/server';
import {fetchIpJourney} from '../../../lib/ip';
import {collectLive} from '../../../lib/train-live';
import {validateBet} from '../../../lib/rules';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
const reply=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'private, no-store'}});
export async function GET(){
 if(!configured())return reply({demoOnly:true,configured:false});
 try{const s=await supabase();const {data:{user}}=await s.auth.getUser();if(!user)return reply({demoOnly:true,configured:true});
 const {data,error}=await s.rpc('railbet_state');if(error)throw error;return reply(data);
 }catch(e){console.error('RailBET state',e);return reply({error:'Não foi possível carregar a conta. Verifica a ligação e a configuração da base de dados.'},503);}
}
export async function POST(req:Request){
 if(!configured())return reply({error:'O modo partilhado ainda não foi configurado. Podes usar a demonstração.'},503);
 try{
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return reply({error:'Origem inválida.'},403);
 if(!req.headers.get('content-type')?.includes('application/json'))return reply({error:'Pedido inválido.'},415);
 const text=await req.text();if(text.length>6000)return reply({error:'Pedido demasiado grande.'},413);
 const b=JSON.parse(text),s=await supabase();const {data:{user}}=await s.auth.getUser();if(!user)return reply({error:'Entra na tua conta para jogar em viagens reais.'},401);
 let result:any;
 if(b.action==='bet'){validateBet(b.prediction,b.stake);result=await s.rpc('railbet_bet',{p_market:b.marketId,p_prediction:b.prediction,p_stake:b.stake});}
 else if(b.action==='profile')result=await s.rpc('railbet_profile',{p_nickname:String(b.nickname??'').trim()});
 else if(b.action==='grant')result=await s.rpc('railbet_grant');
 else if(b.action==='resolve')result=await s.rpc('railbet_resolve',{p_market:b.marketId,p_delay:b.void?null:b.delay,p_evidence:String(b.evidence??'')});
 else if(b.action==='refresh'){
   const gate=await s.rpc('railbet_import_gate');if(gate.error)throw gate.error;
   try{
    const targets=await s.rpc('railbet_live_targets',{p_market:b.marketId||null});if(targets.error)throw targets.error;
    if(!targets.data?.length)throw new Error('Sem viagens elegíveis para atualizar. Executa a sincronização dos horários.');
    const items=await collectLive(targets.data);
    if(!items.length)throw new Error('O arquivo não contém observações recentes para estas viagens.');
    result=await s.rpc('railbet_refresh_observations',{p_items:items});
   }catch(e){await s.rpc('railbet_source_status',{p_ok:false,p_message:e instanceof Error?e.message:'Não foi possível atualizar as observações.'});throw e;}
 }
 else if(b.action==='import'){
   // Atomic server-side throttle and admin check before contacting the upstream.
   const gate=await s.rpc('railbet_import_gate');if(gate.error)throw gate.error;
   try{
    let train=String(b.train??''),date=String(b.date??'');
    const {journey,raw,url}=await fetchIpJourney(train,date);
    result=await s.rpc('railbet_import',{p_journey:journey,p_raw:raw,p_source:url,p_refresh:false});
   }catch(e){await s.rpc('railbet_source_status',{p_ok:false,p_message:e instanceof Error?e.message:'A IP não respondeu.'});throw e;}
 }
 else return reply({error:'Ação desconhecida.'},400);
 if(result?.error)throw result.error;
 const state=await s.rpc('railbet_state');if(state.error)throw state.error;return reply(state.data);
 }catch(e){const msg=e instanceof Error?e.message:(e as any)?.message??'Não foi possível concluir a ação.';console.error('RailBET action',msg);return reply({error:msg},400);}
}
