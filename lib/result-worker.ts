import type {FinalResult} from './train-results.ts';

type Log = (message:string) => void;
type RPC = (name:string,payload:Record<string,unknown>) => Promise<any>;

export function createWorkerRPC(base:string,key:string,request:typeof fetch=fetch,
  log:Log=console.log,timeoutMs=45000):RPC {
  return async (name,payload) => {
    const started=Date.now(), phase=`Supabase ${name}`;
    log(`[start] ${phase}`);
    try {
      const response=await request(`${base}/rest/v1/rpc/${name}`,{method:'POST',
        headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
      if(!response.ok){const error=await response.json().catch(()=>({}));
        const code=String(error.code??'unknown').replace(/[^a-zA-Z0-9]/g,'');
        throw new Error(`HTTP ${response.status}, code ${code}${code==='57014'?' (database statement timeout)':code==='55P03'?' (database lock timeout)':''}`);
      }
      const data=await response.json();
      log(`[done] ${phase} (${Math.round((Date.now()-started)/1000)}s)`);
      return data;
    } catch(error) {
      const timeout=error instanceof Error&&['TimeoutError','AbortError'].includes(error.name);
      throw new Error(`${phase} failed after ${Math.round((Date.now()-started)/1000)}s: ${timeout?`request timeout (${timeoutMs/1000}s limit)`:error instanceof Error?error.message:'network error'}`);
    }
  };
}

// Keep each payout transaction small. Checks and verified items for the same
// market always stay in one batch; retrying after interruption is idempotent.
export async function applyResultBatches(results:FinalResult[],checks:{marketId:string;reason:string}[],
  rpc:RPC,log:Log=console.log) {
  const checked=new Set(checks.map(c=>c.marketId));
  if(checked.size!==checks.length||new Set(results.map(r=>r.marketId)).size!==results.length||
    results.some(r=>!checked.has(r.marketId)))throw new Error('Invalid or duplicate verification targets');
  const totals={checked:0,settled:0,voided:0,alreadyFinal:0};
  for(let offset=0;offset<checks.length;offset+=20){
    const batch=checks.slice(offset,offset+20),ids=new Set(batch.map(c=>c.marketId));
    const items=results.filter(r=>ids.has(r.marketId));
    log(`[save] Batch ${offset/20+1}/${Math.ceil(checks.length/20)}: ${batch.length} checks, ${items.length} verified results`);
    const summary=await rpc('railbet_apply_results',{p_items:items,p_checks:batch});
    for(const name of Object.keys(totals) as (keyof typeof totals)[]) totals[name]+=Number(summary[name]??0);
  }
  return totals;
}
