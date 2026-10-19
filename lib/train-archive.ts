import {gunzipSync} from 'node:zlib';

export function archiveURL(date:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Data inválida.');
 return `https://data.train-archive.eu/daily/provider=pt-cp/service=TripUpdate/date=${date}.csv.gz`;
}
export function parseArchiveCSV(text:string):Record<string,string>[] {
 const lines:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(Boolean))lines.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw new Error('CSV inválido: aspas por fechar.');if(field||row.length){row.push(field);lines.push(row);}
 const headers=lines.shift()?.map(h=>h.replace(/^\uFEFF/,''))??[];
 if(!headers.includes('trip_id')||!headers.includes('arrival_delay_min')||!headers.includes('stop_name'))throw new Error('Formato do Train Archive não reconhecido.');
 if(new Set(headers).size!==headers.length)throw new Error('Colunas duplicadas.');
 return lines.map(values=>{if(values.length!==headers.length)throw new Error('Linha CSV incompleta.');return Object.fromEntries(headers.map((h,i)=>[h,values[i]]));});
}
export function selectArchive(rows:Record<string,string>[],tripId:string){
 const selected=tripId?rows.filter(r=>r.trip_id===tripId):rows;
 return {totalRows:rows.length,matchedRows:selected.length,tripIds:[...new Set(rows.map(r=>r.trip_id))].slice(0,500),rows:selected.slice(0,300),truncated:selected.length>300,eligibleForAutomaticSettlement:false};
}
export async function fetchArchive(date:string,tripId:string,token=process.env.TRAIN_ARCHIVE_API_KEY,request:typeof fetch=fetch){
 const url=archiveURL(date);if(!token?.trim())throw new Error('Configura TRAIN_ARCHIVE_API_KEY no servidor.');
 let response:Response;
 try{response=await request(url,{headers:{'X-Api-Key':token.trim(),Accept:'application/gzip'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(18000)});}catch{throw new Error('Não foi possível contactar o Train Archive.');}
 if(!response.ok){await response.body?.cancel();throw new Error(response.status===404?'O ficheiro diário ainda não existe para esta data. Experimenta um dia anterior.':response.status===401||response.status===403?'O Train Archive recusou o acesso. Verifica o token.':response.status===429?'Limite de consultas atingido. Tenta mais tarde.':`Train Archive: HTTP ${response.status}.`);}
 const reader=response.body?.getReader();if(!reader)throw new Error('Resposta vazia.');const chunks:Buffer[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new Error('Ficheiro acima do limite de 8 MB.');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 const bytes=Buffer.concat(chunks);let text:string;
 try{text=(bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes,{maxOutputLength:32*1024*1024}):bytes).toString('utf8');}catch{throw new Error('Arquivo inválido ou demasiado grande.');}
 return {...selectArchive(parseArchiveCSV(text),tripId),date,url,checkedAt:new Date().toISOString()};
}
