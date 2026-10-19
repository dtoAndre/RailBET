import {parquetReadObjects} from 'hyparquet';
import {compressors} from 'hyparquet-compressors';
import {archiveResponse} from './train-archive.ts';
export type Target={id:string;archive_trip_id:string;archive_service_date:string;archive_destination_stop_id:string|null;destination?:string;archive_version?:string};
export type Observation={marketId:string;tripId:string;serviceDate:string;destinationStopId:string|null;delay:number|null;cancelled:boolean;observedAt:string;source:string};
const BASE='https://data.train-archive.eu/';
export function allowedArchiveURL(value:string){const u=new URL(value,BASE);if(u.origin!==new URL(BASE).origin||u.search||u.hash||u.username||u.password||!/^\/provider=pt-cp\/service=TripUpdate\/date=\d{4}-\d{2}-\d{2}\/(?:day|[0-9:_-]+_to_[0-9:_-]+)\.parquet$/.test(u.pathname))throw new Error('Endereço inesperado no índice do Train Archive.');return u.href;}
async function readParquet(url:string,token:string,request:typeof fetch){
 const r=await archiveResponse(url,token,request);if(!r.ok){await r.body?.cancel();throw new Error(`Train Archive: HTTP ${r.status}.`);}
 const reader=r.body?.getReader();if(!reader)throw new Error('Arquivo vazio.');let size=0;const chunks:Buffer[]=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>16*1024*1024){await reader.cancel();throw new Error('Arquivo excede o limite de leitura.');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 const b=Buffer.concat(chunks);return parquetReadObjects({file:b.buffer.slice(b.byteOffset,b.byteOffset+b.length),compressors});
}
const iso=(v:unknown)=>{const d=new Date(v as string);return Number.isFinite(+d)?d.toISOString():null;};
const day=(v:unknown)=>v instanceof Date?v.toISOString().slice(0,10):String(v??'').slice(0,10);
export function extractObservations(rows:Record<string,any>[],targets:Target[],source:string,now=Date.now()):Observation[]{
 const out:Observation[]=[];
 for(const m of targets){
  const matching=rows.filter(r=>r.trip_tripId===m.archive_trip_id&&String(r.trip_startDate).replaceAll('-','')===m.archive_service_date.replaceAll('-','')&&!r.trip_startTime);
  // lastSeen is the last observation of an unchanged update, not a new arrival.
  matching.sort((a,b)=>Date.parse(iso(b.lastSeen??b.fetchTime)??'')-Date.parse(iso(a.lastSeen??a.fetchTime)??''));
  const r=matching[0];if(!r)continue;const observedAt=iso(r.lastSeen??r.fetchTime);if(!observedAt||Date.parse(observedAt)>now+300000)continue;
  const cancelled=[3,'CANCELED','CANCELLED'].includes(r.trip_scheduleRelationship);
  const stops=(Array.isArray(r.stopTimeUpdate)?r.stopTimeUpdate:[]).filter((s:any)=>m.archive_destination_stop_id&&s.stopId===m.archive_destination_stop_id);
  const s=stops.length===1?stops[0]:null,d=s?.arrival?.delay;
  const unavailable=[1,2,'SKIPPED','NO_DATA'].includes(s?.scheduleRelationship);
  const delay=!cancelled&&!unavailable&&typeof d==='number'&&Number.isFinite(d)&&Math.abs(d)<=172800?Math.trunc(d/60):null;
  out.push({marketId:m.id,tripId:m.archive_trip_id,serviceDate:m.archive_service_date,destinationStopId:m.archive_destination_stop_id,delay,cancelled,observedAt,source});
 }
 return out;
}
export async function collectLive(targets:Target[],token=process.env.TRAIN_ARCHIVE_API_KEY,request:typeof fetch=fetch,now=Date.now()){
 if(!token?.trim())throw new Error('Configura TRAIN_ARCHIVE_API_KEY no servidor.');
 if(!targets.length)return [];
 targets=await bindDestinations(targets,token.trim(),request);
 const index=await readParquet(BASE+'index.parquet',token.trim(),request);
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon'}).format(new Date(now));
 const yesterday=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon'}).format(new Date(now-86400000));
 const files=index.filter(r=>r.provider==='pt-cp'&&r.service==='TripUpdate'&&[today,yesterday].includes(day(r.date))&&['hourly','compacted'].includes(r.kind));
 const chosen:Record<string,any>[]=[];
 for(const date of [today,yesterday]){
  if(!targets.some(t=>t.archive_service_date<=date))continue;
  const daily=files.filter(r=>day(r.date)===date);
  const compact=daily.find(r=>r.kind==='compacted');
  if(compact)chosen.push(compact);else chosen.push(...daily.sort((a,b)=>Number(b.end_hour)-Number(a.end_hour)||String(b.url).localeCompare(String(a.url))).slice(0,3));
 }
 if(!chosen.length)throw new Error('O arquivo ainda não disponibilizou observações recentes.');
 const sets=await Promise.all(chosen.map(async f=>{const source=allowedArchiveURL(String(f.url));return extractObservations(await readParquet(source,token!.trim(),request),targets,source,now);}));
 const latest=new Map<string,Observation>();for(const o of sets.flat())if(!latest.has(o.marketId)||o.observedAt>latest.get(o.marketId)!.observedAt)latest.set(o.marketId,o);
 return [...latest.values()];
}

async function bindDestinations(targets:Target[],token:string,request:typeof fetch){
 const missing=targets.filter(t=>!t.archive_destination_stop_id&&t.archive_version&&t.destination);
 if(!missing.length)return targets;
 const response=await archiveResponse(BASE+'pt-cp/static/latest.json',token,request);
 if(!response.ok){await response.body?.cancel();throw new Error(`Train Archive metadata: HTTP ${response.status}.`);}
 const text=await response.text();if(text.length>100000)throw new Error('Metadados demasiado grandes.');
 const meta=JSON.parse(text);
 if(!missing.some(t=>t.archive_version===meta.version))return targets;
 const paths=['stops','stop_times'].map(name=>{const u=new URL(String(meta.tables?.[name]),BASE);if(u.origin!==new URL(BASE).origin||u.search||u.hash||!new RegExp('^/pt-cp/static/[0-9_TZ:-]+/'+name+'[.]parquet$').test(u.pathname))throw new Error('Metadados do horário inválidos.');return u.href;});
 const [stations,times]=await Promise.all(paths.map(p=>readParquet(p,token,request)));
 const names=new Map(stations.map(r=>[String(r.stop_id),String(r.stop_name)]));
 return targets.map(t=>{
  if(t.archive_destination_stop_id||t.archive_version!==meta.version)return t;
  const stops=times.filter(r=>r.trip_id===t.archive_trip_id).sort((a,b)=>Number(a.stop_sequence)-Number(b.stop_sequence));
  const last=stops.at(-1);if(stops.length<2||!last||names.get(String(last.stop_id))!==t.destination)return t;
  return {...t,archive_destination_stop_id:String(last.stop_id)};
 });
}
