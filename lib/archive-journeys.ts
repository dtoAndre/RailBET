export type Row=Record<string,string>;
export type Stop={name:string;time:string;delay:number|null;source:string;status:string};
export type Journey={id:string;tripId:string;date:string;train:string;service:string;origin:string;destination:string;departure:string;arrival:string;delay:number|null;source:string;cancelled:boolean;ordered:boolean;stops:Stop[]};
export const numeric=(s:string|undefined)=>s?.trim()&&Number.isFinite(Number(s))?Number(s):null;
export function trainNumber(r:Row){return /^\d{1,6}$/.test(r.trip_short_name??'')?String(Number(r.trip_short_name)):/^\d{1,6}(?:_\d{8})?$/.test(r.trip_id??'')?String(Number(r.trip_id.split('_')[0])):'';}
export function matchesTrain(r:Row,q:string){q=q.trim();return !q||r.trip_id===q||(/^\d{1,6}$/.test(q)&&trainNumber(r)===String(Number(q)));}
export function journeysFromRows(rows:Row[],date:string):Journey[]{
 const groups=new Map<string,Row[]>();
 for(const r of rows){const d=(r.service_date||date).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');if(!r.trip_id||d!==date)continue;const id=JSON.stringify([r.trip_id,d,r.trip_start_time||'']);groups.set(id,[...(groups.get(id)??[]),r]);}
 return [...groups].map(([id,rs])=>{
  const seq=rs.map(r=>numeric(r.stop_sequence)),times=rs.map(r=>r.scheduled_arrival||r.scheduled_departure||'');
  const bySeq=seq.every(n=>n!==null&&Number.isInteger(n)&&n>=0)&&new Set(seq).size===seq.length;
  const byTime=times.every(t=>/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(t))&&new Set(times).size===times.length;
  const ordered=rs.length>1&&(bySeq||byTime);
  const sorted=[...rs].sort((a,b)=>bySeq?Number(a.stop_sequence)-Number(b.stop_sequence):byTime?(a.scheduled_arrival||a.scheduled_departure).localeCompare(b.scheduled_arrival||b.scheduled_departure):0);
  const cancelled=rs.some(r=>/^(canceled|cancelled)$/i.test(r.trip_status));
  const stops=sorted.map(r=>({name:r.stop_name||'Estação desconhecida',time:r.scheduled_arrival||r.scheduled_departure||'',delay:cancelled||/^(skipped|no_data|canceled|cancelled)$/i.test(r.stop_status)?null:numeric(r.arrival_delay_min),source:r.delay_source||'',status:r.stop_status||''}));
  const a=sorted[0],z=sorted[sorted.length-1],last=stops[stops.length-1];
  return {id,tripId:a.trip_id,date,train:trainNumber(a),service:a.route||'',origin:ordered?stops[0].name:'Origem por confirmar',destination:ordered?last.name:'Destino por confirmar',departure:ordered?a.scheduled_departure||stops[0].time:'',arrival:ordered?last.time:'',delay:ordered?last.delay:null,source:ordered?last.source:'',cancelled,ordered,stops};
 });
}
export const delayText=(v:number|null)=>v===null?'Sem dados':v===0?'A horas':`${v>0?'+':'−'}${new Intl.NumberFormat('pt-PT',{maximumFractionDigits:1}).format(Math.abs(v))} min`;
export const sourceText=(s:string)=>s==='propagated'?'Propagado da paragem anterior':s==='feed'||s==='direct'?'Publicado pela fonte':'Origem não indicada';
