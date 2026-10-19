'use client';
import {useState} from 'react';
type Result={date:string;url:string;checkedAt:string;totalRows:number;matchedRows:number;tripIds:string[];rows:Record<string,string>[];truncated:boolean};
export default function ArchivePanel(){
 const [date,setDate]=useState(''),[trip,setTrip]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null);
 return <section className="panel"><h2>Train Archive — consultar atrasos</h2><p>Consulta um dia concluído. Escolhe depois o identificador exato da viagem. Os valores publicados não confirmam automaticamente a chegada efetiva.</p>
 <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setResult(null);try{const r=await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date,tripId:trip})});const data=await r.json();if(!r.ok)throw new Error(data.error);setResult(data);}catch(e){setError(e instanceof Error?e.message:'Falha na consulta.');}finally{setBusy(false);}}}>
 <label>Data <input required type="date" value={date} onChange={e=>{setDate(e.target.value);setResult(null);setTrip('');}}/></label>{' '}
 <label>Identificador da viagem <input list="archive-trips" value={trip} placeholder="Vazio para listar viagens" onChange={e=>setTrip(e.target.value)}/></label>
 <datalist id="archive-trips">{result?.tripIds.map(t=><option key={t} value={t}/>)}</datalist>{' '}<button className="button" disabled={busy}>{busy?'A consultar…':'Consultar arquivo'}</button></form>
 {error&&<p role="alert">{error}</p>}{result&&<><p role="status">{result.matchedRows} registos encontrados; {result.rows.length} apresentados. Consulta: {new Date(result.checkedAt).toLocaleString('pt-PT')}. <a href={`https://www.train-archive.eu/providers/pt-cp/${result.date}`} target="_blank" rel="noreferrer">Abrir fonte</a></p>
 <div className="table-scroll"><table><thead><tr>{['Viagem','Linha','Estação','Chegada programada','Atraso publicado (min)','Origem do atraso'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{result.rows.map((r,i)=><tr key={i}><td>{r.trip_id}</td><td>{r.route||'—'}</td><td>{r.stop_name}</td><td>{r.scheduled_arrival||'—'}</td><td>{r.arrival_delay_min||'Desconhecido'}</td><td>{r.delay_source==='propagated'?'Propagado da estação anterior':r.delay_source||'Não indicada'}</td></tr>)}</tbody></table></div>
 <p>Confirma a data, o comboio e o destino final antes de utilizar estes dados. Um valor propagado ou em falta não basta para confirmar o resultado. A confirmação de prémios continua manual.</p></>}
 </section>;
}
