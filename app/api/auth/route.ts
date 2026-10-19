import {configured,supabase} from '../../../lib/supabase/server';
export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(!configured())return Response.json({error:'Configura o Supabase antes de criar contas.'},{status:503});
 const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return Response.json({error:'Origem inválida.'},{status:403});
 if(!req.headers.get('content-type')?.includes('application/json'))return Response.json({error:'Pedido inválido.'},{status:415});
 const raw=await req.text();if(raw.length>3000)return Response.json({error:'Pedido demasiado grande.'},{status:413});
 try{const b=JSON.parse(raw),s=await supabase();
 if(b.action==='logout'){await s.auth.signOut();return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});}
 const email=String(b.email??'').trim(),password=String(b.password??'');if(!email.includes('@')||password.length<8||password.length>128)return Response.json({error:'Indica um email válido e uma palavra-passe com pelo menos 8 caracteres.'},{status:400});
 const result=b.action==='signup'?await s.auth.signUp({email,password,options:{emailRedirectTo:new URL('/auth/callback',req.url).href}}):b.action==='login'?await s.auth.signInWithPassword({email,password}):null;
 if(!result)return Response.json({error:'Ação desconhecida.'},{status:400});
 if(result.error)return Response.json({error:result.error.message},{status:400});
 return Response.json({ok:true,confirmationRequired:!result.data.session},{headers:{'Cache-Control':'no-store'}});
 }catch{return Response.json({error:'Não foi possível iniciar sessão.'},{status:400});}
}
