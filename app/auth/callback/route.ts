import {NextResponse} from 'next/server';
import {configured,supabase} from '../../../lib/supabase/server';
import {siteURL} from '../../../lib/site-url';
export async function GET(req:Request){const url=new URL(req.url),base=siteURL(req.url);const code=url.searchParams.get('code');if(code&&configured()){const s=await supabase();const {error}=await s.auth.exchangeCodeForSession(code);if(!error)return NextResponse.redirect(new URL('/',base));}return NextResponse.redirect(new URL('/login?error=confirmation',base));}
