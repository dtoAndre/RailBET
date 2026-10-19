import {configured,supabase} from '../../../lib/supabase/server';
import {fetchArchive} from '../../../lib/train-archive';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
export async function POST(req:Request){
 if(!configured())return reply({error:'Configura o Supabase e entra como administrador.'},503);
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return reply({error:'Origem inválida.'},403);
 if(!req.headers.get('content-type')?.includes('application/json'))return reply({error:'Pedido inválido.'},415);
 try{
 const s=await supabase();const {data:{user}}=await s.auth.getUser();if(!user)return reply({error:'Inicia sessão.'},401);
 const state=await s.rpc('railbet_state');if(state.error)throw new Error('Não foi possível verificar a conta.');if(!state.data?.isOwner)return reply({error:'Apenas administradores.'},403);
 const text=await req.text();if(text.length>1000)return reply({error:'Pedido demasiado grande.'},413);
 const body=JSON.parse(text);if(typeof body.date!=='string'||(body.tripId!==undefined&&typeof body.tripId!=='string')||String(body.tripId??'').length>200)return reply({error:'Parâmetros inválidos.'},400);
 const gate=await s.rpc('railbet_import_gate');if(gate.error)throw new Error(gate.error.message.replace('entre consultas à IP', 'entre consultas às fontes'));
 return reply(await fetchArchive(body.date,body.tripId??''));
 }catch(e){return reply({error:e instanceof Error?e.message:'Não foi possível consultar o arquivo.'},400);}
}
