'use client';
import {useEffect, useState} from 'react';
import {ArrowRight, ArrowUpRight, Check, ChevronDown, Clock3, History, RefreshCw, Search, TrainFront, Trophy, Users} from 'lucide-react';
import type {Bet, Market} from '../lib/types';
import {marketStatus} from '../lib/market-status';
import {delayText} from '../lib/archive-journeys';
import {effectiveStatus, filterMarkets, lisbonDate, resultMethodLabel, serviceCode, serviceLabel, serviceOptions} from '../lib/market-board';

const clock = (v: string) => new Date(v).toLocaleTimeString('pt-PT', {timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit'});
const dateLabel = (v: string) => new Date(v).toLocaleDateString('pt-PT', {timeZone: 'Europe/Lisbon', day: '2-digit', month: 'short'});
const number = (v: number) => new Intl.NumberFormat('pt-PT').format(v);
const statuses = [['all', 'Todas'], ['open', 'Abertas'], ['locked', 'Fechadas'], ['settled', 'Concluídas'], ['void', 'Anuladas']] as const;

type Props = {markets: Market[]; mine: Bet[]; now: number; history: boolean; demo: boolean; selected: string | null; busy: boolean; onSelect: (m: Market) => void; onClear: () => void; onRefresh: () => Promise<void>; onDemo: () => void};
export default function MarketBoard({markets, mine, now, history, demo, selected, busy, onSelect, onClear, onRefresh, onDemo}: Props) {
  const [status, setStatus] = useState(history ? 'all' : 'open');
  const [service, setService] = useState('all');
  const [date, setDate] = useState(history ? lisbonDate(now) : '');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const base = filterMarkets(markets, {service, date, query, status: 'all'}, now);
  const rows = filterMarkets(base, {service: 'all', date: '', query: '', status}, now);
  useEffect(() => {if (selected && !rows.some(m => m.id === selected)) onClear();}, [selected, rows, onClear]);
  const pages = Math.max(1, Math.ceil(rows.length / 12));
  const current = Math.min(page, pages - 1);
  function reset() {setStatus(history ? 'all' : 'open'); setService('all'); setDate(history ? lisbonDate(now) : ''); setQuery(''); setPage(0);}
  return <section className="departure-board" aria-label={history ? 'Histórico de viagens' : 'Painel de apostas'}>
    <div className="section-heading"><div><p className="board-kicker">{history ? 'O DIA NA LINHA' : 'ESCOLHE A TUA PRÓXIMA VIAGEM'}</p><h2>{history ? 'Histórico dos comboios' : 'Apostas na plataforma'}</h2><p>{history ? 'Todas as viagens registadas no RailBET, com o último estado disponível.' : 'Um comboio. Um palpite. Quem chega mais perto?'}</p></div><button className="icon-btn" disabled={busy || refreshing} onClick={async () => {setRefreshing(true); try {await onRefresh();} finally {setRefreshing(false);}}} aria-label="Atualizar painel"><RefreshCw size={18} className={refreshing ? 'spin' : ''}/></button></div>
    <div className="journey-filters">
      <label className="service-filter">Tipo de comboio<select value={service} onChange={e => {setService(e.target.value); setPage(0);}}>{serviceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="date-filter">Dia da viagem<input type="date" value={date} onChange={e => {setDate(e.target.value); setPage(0);}}/></label>
      <div className="date-shortcuts"><button aria-pressed={date === lisbonDate(now)} onClick={() => {setDate(lisbonDate(now)); setPage(0);}}>Hoje</button><button aria-pressed={!date} onClick={() => {setDate(''); setPage(0);}}>Todos os dias</button></div>
      <label className="journey-search"><Search size={17}/><input type="search" aria-label="Pesquisar comboio ou estação" placeholder="Pesquisar comboio ou estação…" value={query} onChange={e => {setQuery(e.target.value); setPage(0);}}/></label>
    </div>
    <div className="journey-tabs" aria-label="Estado das apostas">{statuses.map(([value, label]) => <button key={value} aria-pressed={status === value} className={`${status === value ? 'selected' : ''} tab-${value}`} onClick={() => {setStatus(value); setPage(0);}}><span className="status-dot"/>{label}<small>{value === 'all' ? base.length : base.filter(m => effectiveStatus(m, now) === value).length}</small></button>)}</div>
    <div className="results-caption" role="status"><span>{rows.length} {rows.length === 1 ? 'viagem encontrada' : 'viagens encontradas'}{date ? ` · ${date.split('-').reverse().join('/')}` : ' · todos os dias'}</span><button onClick={reset}>Repor filtros</button></div>
    {!rows.length ? <div className="empty-state"><TrainFront size={34}/><h3>Esta linha está tranquila.</h3><p>{markets.length ? 'Não há viagens para esta combinação de filtros. Experimenta outro dia, serviço ou estado.' : demo ? 'Cria viagens de demonstração para experimentar.' : 'Ainda não há viagens registadas. O painel será preenchido após a sincronização dos horários.'}</p>{markets.length > 0 && <button className="button secondary" onClick={() => {setDate(''); setService('all'); setQuery(''); setStatus('all'); setPage(0);}}>Ver todas as viagens</button>}</div> : <div className="market-list">{rows.slice(current * 12, (current + 1) * 12).map(original => {
      const m = {...original, status: effectiveStatus(original, now)};
      const bet = mine.find(b => b.market_id === m.id);
      const open = expanded === m.id;
      const settled = m.status === 'settled';
      const stale = !!m.source_observed_at && now - Date.parse(m.source_observed_at) > 30 * 60000;
      return <article key={m.id} className={`market-card journey-card state-${m.status} ${selected === m.id ? 'chosen' : ''}`}>
        <div className="card-head"><span className={`service-badge service-${serviceCode(m.service)}`}>{serviceLabel(m.service)}</span><span className="train-id">#{m.train} · {dateLabel(m.departure)}</span><span className={`market-status ${m.status}`}><span/>{statuses.find(([s]) => s === m.status)?.[1] ?? m.status}</span></div>
        <button className="route-select" onClick={() => onSelect(m)} aria-label={`Selecionar comboio ${m.train}`}><div className="station"><strong>{clock(m.departure)}</strong><span>{m.origin}</span></div><div className="route-rail"><TrainFront size={17}/><span/><ArrowRight size={13}/><small>{Math.round((Date.parse(m.arrival) - Date.parse(m.departure)) / 60000)} min</small></div><div className="station arrival"><strong>{clock(m.arrival)}</strong><span>{m.destination}</span></div></button>
        <div className="journey-state"><Clock3 size={14}/><span>{marketStatus(m, now)}</span>{m.status === 'open' && <strong>Fecha às {clock(m.closes_at)}</strong>}</div>
        <div className={`observation-strip ${stale ? 'stale' : ''}`}><strong>{settled ? `Atraso final: ${delayText(m.actual_delay)}` : m.status === 'void' ? 'Aposta anulada · créditos devolvidos' : m.source_cancelled ? 'Supressão indicada pela fonte' : m.demo_owner ? 'Viagem simulada · sem observações reais' : m.current_delay === null ? 'Previsão no destino: sem dados' : `Previsão no destino: ${delayText(m.current_delay)}`}</strong><span>{settled ? resultMethodLabel(m.result_method) : !m.demo_owner && m.source_observed_at ? `${dateLabel(m.source_observed_at)} · ${clock(m.source_observed_at)}${stale ? ' · dados antigos' : ' · última observação'}` : !m.demo_owner && m.status !== 'void' ? 'Ainda sem observação da fonte' : ''}</span></div>
        <div className="card-foot"><div className="pool"><Trophy size={16}/><strong>{number(m.status === 'void' ? 0 : m.total * .9)} <small>cr</small></strong><span>prémio</span></div><span className="participants"><Users size={14}/>{m.participants} {demo ? 'incl. simulados' : 'palpites'}</span><button className="card-action" onClick={() => onSelect(m)}>{bet ? <><Check size={14}/>O teu palpite: {bet.prediction} min</> : m.status === 'open' && !m.source_cancelled ? <>Apostar <ArrowUpRight size={15}/></> : <>{settled || m.status === 'void' ? 'Ver resultado' : 'Ver viagem'} <ArrowUpRight size={15}/></>}</button></div>
        <button className="journey-detail-toggle" aria-expanded={open} aria-controls={`details-${m.id}`} onClick={() => setExpanded(open ? null : m.id)}><History size={14}/>Estado e detalhes da viagem<ChevronDown size={15} className={open ? 'rotated' : ''}/></button>
        {open && <div className="journey-details" id={`details-${m.id}`}>
          <ol className="journey-timeline"><li><span>Fecho das apostas</span><strong>{dateLabel(m.closes_at)} · {clock(m.closes_at)}</strong></li><li><span>Partida programada</span><strong>{dateLabel(m.departure)} · {clock(m.departure)}</strong></li><li><span>Chegada programada</span><strong>{dateLabel(m.arrival)} · {clock(m.arrival)}</strong></li><li><span>Resultado</span><strong>{settled ? delayText(m.actual_delay) : m.status === 'void' ? 'Anulada' : 'Por confirmar'}</strong></li></ol>
          {!m.demo_owner && <p>{m.source_observed_at ? `Última observação: ${dateLabel(m.source_observed_at)} às ${clock(m.source_observed_at)}.${stale ? ' Esta informação tem mais de 30 minutos.' : ''}` : 'A fonte ainda não disponibilizou uma observação para esta viagem.'} Horários e previsões não confirmam a chegada.</p>}
          {m.evidence && <p className="journey-evidence"><strong>Confirmação do resultado</strong>{m.evidence}</p>}
          {bet && <p>O teu palpite: <strong>{bet.prediction} min</strong> · Apostaste {number(bet.stake)} cr · {bet.payout === null ? 'Pagamento pendente' : `Recebeste ${number(bet.payout)} cr`}</p>}
        </div>}
      </article>;
    })}</div>}
    {pages > 1 && <nav className="journey-pagination" aria-label="Páginas de viagens"><button disabled={current === 0} onClick={() => setPage(current - 1)}>Anterior</button><span>{current + 1} / {pages}</span><button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Seguinte</button></nav>}
    {demo && <button className="button secondary new-demo" disabled={busy} onClick={onDemo}>Novas viagens de teste <ArrowRight size={15}/></button>}
    <div className="board-note"><Clock3 size={15}/><span>Fecho 10 minutos antes da partida. Horas de Portugal continental. O painel atualiza a cada minuto; as observações dependem da fonte.</span></div>
  </section>;
}
