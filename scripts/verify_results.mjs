import {collectFinalResults} from '../lib/train-results.ts';
import {createWorkerRPC,applyResultBatches} from '../lib/result-worker.ts';

const base = process.env.SUPABASE_URL?.trim().replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!base || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base) || !key)
  throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
const rpc=createWorkerRPC(base,key);
try {
  const targets = await rpc('railbet_result_targets', {});
  console.log(`Selected ${targets.length} targets across ${new Set(targets.map(t=>t.archive_service_date)).size} service days.`);
  const {results, checks} = await collectFinalResults(targets,process.env.TRAIN_ARCHIVE_API_KEY,fetch,Date.now(),console.log);
  const summary = await applyResultBatches(results,checks,rpc);
  const reasons = {};
  for (const {reason} of checks) reasons[reason] = (reasons[reason] ?? 0) + 1;
  console.log(`Final result verification: ${JSON.stringify({targets:targets.length, verified:results.length, ...summary})}`);
  console.log(`Verification decisions: ${JSON.stringify(reasons)}`);
  console.log('Results use the closed daily archive. Live forecasts never trigger payouts.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Final result verification failed');
  process.exitCode = 1;
}
