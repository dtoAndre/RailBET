export function marketStatus(m:{status:string;departure:string;arrival:string;current_delay:number|null;source_cancelled?:boolean},now:number){
 if(m.status==='settled')return 'Resultado confirmado';if(m.status==='void')return 'Anulada';
 if(m.source_cancelled)return 'Supressão indicada · por confirmar';
 if(m.status==='open')return 'Palpites abertos';
 if(now<Date.parse(m.departure))return 'Palpites fechados · aguarda partida';
 if(now<Date.parse(m.arrival)+Math.max(0,m.current_delay??0)*60000)return 'Em viagem · horário estimado';
 return 'Aguarda confirmação do resultado';
}
