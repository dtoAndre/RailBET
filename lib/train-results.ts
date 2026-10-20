import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {archiveResponse, archiveURL, parseArchiveCSV} from './train-archive.ts';
import {lisbonTimeToISO} from './ip.ts';

export type ResultTarget = {
  id: string; archive_trip_id: string; archive_service_date: string;
  archive_destination_stop_id: string | null; arrival: string; departure: string;
};
type Row = Record<string, string>;
export type FinalResult = {
  marketId: string; tripId: string; serviceDate: string; destinationStopId: string;
  scheduledArrival: string; outcome: 'reported_arrival' | 'cancelled';
  reportedDelayMinutes: number | null; delayMinutes: number | null;
  reportedArrival: string | null; observedAt: string | null;
  retrievedAt: string; source: string; sha256: string; row: Row;
};
const localDay = (now: number) => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Lisbon'}).format(new Date(now));
const dateKey = (s: string) => s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
const isCancelled = (s: string) => /^(cancelled|canceled)$/i.test(s);
function instant(value: string, date: string): string | null {
  try { return value ? lisbonTimeToISO(value, date) : null; } catch { return null; }
}

// A completed daily file is evidence of the source's last published result.
// It is not independent proof of a physically measured arrival. In particular,
// no result is accepted from a live forecast, propagation, or a clock alone.
export function verifyFinalResult(rows: Row[], target: ResultTarget,
  metadata: {source: string; sha256: string; retrievedAt: string}, now = Date.now()
): {result: FinalResult | null; reason: string} {
  const reject = (reason: string) => ({result: null, reason});
  const date = target.archive_service_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= localDay(now)) return reject('service_day_not_closed');
  if (metadata.source !== archiveURL(date)) return reject('unexpected_daily_source');
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256)) return reject('missing_file_digest');
  if (!target.archive_destination_stop_id) return reject('missing_destination_code');
  const arrival = Date.parse(target.arrival);
  if (!Number.isFinite(arrival) || arrival > now) return reject('arrival_not_elapsed');
  const trip = rows.filter(r => r.trip_id === target.archive_trip_id && dateKey(r.service_date ?? '') === date);
  if (!trip.length) return reject('trip_not_in_daily_file');
  if (new Set(trip.map(r => r.trip_start_time || '')).size !== 1) return reject('ambiguous_trip_instance');
  const sequences = trip.map(r => r.stop_sequence?.trim() ? Number(r.stop_sequence) : NaN);
  if (trip.length < 2 || sequences.some(n => !Number.isSafeInteger(n) || n < 0) || new Set(sequences).size !== trip.length)
    return reject('ambiguous_stop_order');
  const lastSequence = Math.max(...sequences);
  const terminal = trip.filter(r => r.stop_id === target.archive_destination_stop_id);
  if (terminal.length !== 1 || Number(terminal[0].stop_sequence) !== lastSequence) return reject('destination_mismatch');
  const row = terminal[0];
  const scheduledArrival = instant(row.scheduled_arrival, date);
  if (!scheduledArrival || Date.parse(scheduledArrival) !== arrival) return reject('scheduled_arrival_mismatch');
  const first = trip[sequences.indexOf(Math.min(...sequences))];
  const scheduledDeparture = instant(first.scheduled_departure, date);
  if (!scheduledDeparture || Date.parse(scheduledDeparture) !== Date.parse(target.departure)) return reject('scheduled_departure_mismatch');
  // The caller passes the parsed daily file, which also contains every row.
  // Copy only provenance fields: spreading metadata sends the entire archive
  // with each result despite its narrower TypeScript type.
  const base = {marketId: target.id, tripId: target.archive_trip_id, serviceDate: date,
    destinationStopId: target.archive_destination_stop_id, scheduledArrival,
    source: metadata.source, sha256: metadata.sha256, retrievedAt: metadata.retrievedAt, row};
  if (trip.every(r => isCancelled(r.trip_status))) return {result: {...base, outcome:'cancelled',
    reportedDelayMinutes:null, delayMinutes:null, reportedArrival:null, observedAt:null}, reason:'cancelled_in_closed_daily_file'};
  if (trip.some(r => r.trip_status !== 'scheduled')) return reject('unsupported_or_conflicting_trip_status');
  if (row.stop_status && row.stop_status !== 'scheduled') return reject('destination_skipped_or_unavailable');
  if (!['feed', 'direct'].includes(row.delay_source)) return reject('destination_delay_not_direct');
  const rawDelay = row.arrival_delay_min?.trim() ? Number(row.arrival_delay_min) : NaN;
  if (!Number.isFinite(rawDelay) || rawDelay < -60 || rawDelay > 2880) return reject('missing_or_invalid_destination_delay');
  const reportedArrival = instant(row.predicted_arrival, date);
  if (!reportedArrival || Math.abs(Date.parse(reportedArrival) - (arrival + rawDelay * 60000)) > 1000)
    return reject('inconsistent_reported_arrival');
  if (Date.parse(reportedArrival) > now) return reject('reported_arrival_still_future');
  const observedAt = instant(row.observed_at, date);
  // Require the terminal update to have been seen at/after its reported arrival.
  // A forecast last seen before arrival remains pending, even in a daily file.
  if (!observedAt || Date.parse(observedAt) < Date.parse(reportedArrival) || Date.parse(observedAt) > now + 300000)
    return reject('no_post_arrival_destination_observation');
  return {result: {...base, outcome:'reported_arrival', reportedDelayMinutes:rawDelay,
    delayMinutes:Math.max(0, Math.trunc(rawDelay)), reportedArrival, observedAt}, reason:'verified_daily_destination'};
}

async function dailyRows(date: string, token: string, request: typeof fetch) {
  // One shared deadline covers redirects AND the body. The generic live-data
  // helper has an 18-second deadline intended for smaller live-data downloads.
  const deadline=AbortSignal.timeout(60000);
  const dailyRequest:typeof fetch=(url,init)=>request(url,{...init,signal:deadline});
  const source = archiveURL(date), response = await archiveResponse(source, token, dailyRequest);
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Train Archive daily HTTP ${response.status} (${date})`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty daily archive');
  const chunks: Buffer[] = []; let size = 0;
  try { while (true) { const {done, value} = await reader.read(); if (done) break;
    size += value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Daily archive exceeds 8 MB'); }
    chunks.push(Buffer.from(value));
  }} finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks), sha256 = createHash('sha256').update(bytes).digest('hex');
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, {maxOutputLength:32*1024*1024}) : bytes).toString('utf8');
  return {source, sha256, rows:parseArchiveCSV(text), retrievedAt:new Date().toISOString()};
}

export async function collectFinalResults(targets: ResultTarget[], token = process.env.TRAIN_ARCHIVE_API_KEY,
  request: typeof fetch = fetch, now = Date.now(), log:(message:string)=>void=()=>{}) {
  if (!token?.trim()) throw new Error('Configure TRAIN_ARCHIVE_API_KEY');
  const results: FinalResult[] = [], checks: {marketId:string; reason:string}[] = [];
  const dates = [...new Set(targets.map(t => t.archive_service_date))].sort();
  if (dates.length > 8) throw new Error('Too many daily files in one batch (maximum 8)');
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= localDay(now)) throw new Error('Worker selected a service day that has not closed');
    const started=Date.now();
    log(`[start] Train Archive daily ${date}`);
    let file:Awaited<ReturnType<typeof dailyRows>>;
    try {file=await dailyRows(date, token.trim(), request);}
    catch(error){throw new Error(`Train Archive daily ${date} failed after ${Math.round((Date.now()-started)/1000)}s: ${error instanceof Error?error.message:'download or parsing error'}`);}
    log(`[done] Train Archive daily ${date}: ${file?`${file.rows.length} rows`:'not ready (404)'} (${Math.round((Date.now()-started)/1000)}s)`);
    for (const target of targets.filter(t => t.archive_service_date === date)) {
      const decision = file ? verifyFinalResult(file.rows, target, file, now) : {result:null, reason:'daily_file_not_ready'};
      checks.push({marketId:target.id, reason:decision.reason});
      if (decision.result) results.push(decision.result);
    }
  }
  return {results, checks};
}
