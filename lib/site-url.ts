export function siteURL(requestURL:string,env:Record<string,string|undefined>=process.env){
 const configured=env.SITE_URL?.trim()||env.NEXT_PUBLIC_SITE_URL?.trim();
 const base=configured||(env.VERCEL_PROJECT_PRODUCTION_URL?`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`:new URL(requestURL).origin);
 const url=new URL(base),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||(!local&&url.protocol!=='https:')||(local&&env.VERCEL==='1'))throw new Error('Configura SITE_URL com o endereço HTTPS público do RailBET.');
 return url.origin;
}
