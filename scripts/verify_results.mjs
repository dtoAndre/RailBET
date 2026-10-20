import {collectFinalResults} from '../lib/train-results.ts';

const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!base || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !key)
  throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
async function rpc(name, payload) {
  const r = await fetch(`${base}/rest/v1/rpc/${name}`, {method:'POST', headers:{apikey:key,
    Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:JSON.stringify(payload),
    signal:AbortSignal.timeout(30000), redirect:'error'});
  if (!r.ok) { const error = await r.json().catch(() => ({}));
    throw new Error(`Supabase HTTP ${r.status} (${String(error.code ?? 'unknown').replace(/[^a-zA-Z0-9]/g, '')}). Check migration 004 and worker credentials.`); }
  return r.json();
}
try {
  const targets = await rpc('railbet_result_targets', {});
  const {results, checks} = await collectFinalResults(targets);
  const summary = await rpc('railbet_apply_results', {p_items:results, p_checks:checks});
  const reasons = {};
  for (const {reason} of checks) reasons[reason] = (reasons[reason] ?? 0) + 1;
  console.log(`Final result verification: ${JSON.stringify({targets:targets.length, verified:results.length, ...summary})}`);
  console.log(`Verification decisions: ${JSON.stringify(reasons)}`);
  console.log('Results use the closed daily archive. Live forecasts never trigger payouts.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Final result verification failed');
  process.exitCode = 1;
}
