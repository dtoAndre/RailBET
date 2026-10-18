import {NextResponse} from 'next/server';
import {configured,supabase} from '../../../lib/supabase/server';
export async function GET(req:Request){const url=new URL(req.url);const code=url.searchParams.get('code');if(code&&configured()){const s=await supabase();const {error}=await s.auth.exchangeCodeForSession(code);if(!error)return NextResponse.redirect(new URL('/',url));}return NextResponse.redirect(new URL('/login?error=confirmation',url));}
