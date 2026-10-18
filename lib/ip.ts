// Port of caiocdcs/comboios-rs IP adapter, MIT, Copyright 2025-2026 Caio Silva.
// Upstream pinned source and full license: vendor/comboios-rs/.
export const IP_BASE='https://www.infraestruturasdeportugal.pt';
export function journeyUrl(train:string,date:string) {
  if(!/^\d{1,6}$/.test(train)||!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Número do comboio ou data inválidos.');
  return `${IP_BASE}/negocios-e-servicos/horarios-ncombio/${train}/${encodeURIComponent(date)}`;
}
export function lisbonDate(d=new Date()) { return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon',year:'numeric',month:'2-digit',day:'2-digit'}).format(d); }
export function lisbonTimeToISO(value:string,date:string):string {
  if(!value) throw new Error('Horário em falta na fonte.');
  if(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return new Date(value).toISOString();
  const dateMatch=value.match(/(\d{4}-\d{2}-\d{2})/);
  const clock=value.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if(!clock||Number(clock[1])>23||Number(clock[2])>59) throw new Error('Formato de hora desconhecido na IP.');
  const wall=`${dateMatch?.[1]??date}T${clock[1]}:${clock[2]}:${clock[3]??'00'}`;
  const target=Date.parse(wall+'Z');
  const format=(ms:number)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Lisbon',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(ms)).replace(' ','T');
  const matches=[target,target-3600000].filter(ms=>format(ms)===wall);
  if(matches.length!==1) throw new Error('Hora ambígua ou inexistente na mudança de hora. Importação suspensa.');
  return new Date(matches[0]).toISOString();
}
export function parseIpJourney(payload:any,train:string,date:string) {
  const r=payload?.response;
  if(!r || typeof r!=='object' || !Array.isArray(r.NodesPassagemComboio)||r.NodesPassagemComboio.length<2) throw new Error('A IP não devolveu uma viagem reconhecida.');
  const stops=r.NodesPassagemComboio;
  const departure=lisbonTimeToISO(String(r.DataHoraOrigem??stops[0].HoraProgramada??''),date);
  let arrival=lisbonTimeToISO(String(r.DataHoraDestino??stops.at(-1).HoraProgramada??''),date);
  if(Date.parse(arrival)<Date.parse(departure)) {
    if(/\d{4}-\d{2}-\d{2}/.test(String(r.DataHoraDestino??''))) throw new Error('Datas de viagem inconsistentes.');
    const nextDate=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
    arrival=lisbonTimeToISO(String(r.DataHoraDestino??stops.at(-1).HoraProgramada),nextDate);
  }
  const text=String(r.SituacaoComboio??'');
  const match=text.match(/atraso de\s+(\d+)\s*min/i);
  return {train,travelDate:date,origin:String(r.Origem??''),destination:String(r.Destino??''),service:String(r.TipoServico??'Comboio'),departure,arrival,
    closesAt:new Date(Date.parse(departure)-10*60000).toISOString(),currentDelay:match?Number(match[1]):null,
    cancelled:/suprimid|cancelad/i.test(text),observations:text,
    // A clock having elapsed is NOT evidence of passage. Upstream inference is deliberately omitted.
    finalPassed:stops.at(-1)?.ComboioPassou===true,
    // Upstream explicitly maps actual_arrival to None. Never settle from Hora Prevista.
    actualDelay:null as number|null,
    stops:stops.map((s:any)=>({name:String(s.NomeEstacao??''),scheduled:String(s.HoraProgramada??''),passed:s.ComboioPassou===true,observations:String(s.Observacoes??'')}))};
}
export async function fetchIpJourney(train:string,date:string) {
  const url=journeyUrl(train,date);
  const r=await fetch(url,{cache:'no-store',headers:{Accept:'application/json','User-Agent':'RailBET/0.1 (fictional-credit hobby project)'},signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw new Error(`A IP respondeu HTTP ${r.status}. Tenta novamente mais tarde; nenhuma viagem foi inventada.`);
  const text=await r.text();
  if(text.length>500000) throw new Error('Resposta da IP demasiado grande.');
  let raw;try{raw=JSON.parse(text);}catch{throw new Error('A IP devolveu uma resposta que não é JSON.');}
  return {journey:parseIpJourney(raw,train,date),raw:text,url};
}
