import type {Market} from './types.ts';

export const serviceOptions = [
  ['all', 'Todos os serviços'], ['AP', 'Alfa Pendular'], ['IC', 'Intercidades'],
  ['IR', 'InterRegional'], ['R', 'Regional'], ['other', 'Outros'],
] as const;
export function serviceCode(service: string) {
  const s = service.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  if (s === 'ap' || s.includes('alfa')) return 'AP';
  if (s === 'ic' || s.includes('intercidades')) return 'IC';
  if (s === 'ir' || s.includes('interregional') || s.includes('interregionais')) return 'IR';
  if (s === 'r' || s === 'regional' || s === 'regionais') return 'R';
  return 'other';
}
export function serviceLabel(service: string) {
  const code = serviceCode(service);
  return code === 'other' ? service : serviceOptions.find(([value]) => value === code)![1];
}
export const lisbonDate = (date: number | string = Date.now()) => new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Lisbon'}).format(new Date(date));
export const effectiveStatus = (m: Market, now: number) => m.status === 'open' && Date.parse(m.closes_at) <= now ? 'locked' : m.status;
export const normalizeSearch = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export function filterMarkets(markets: Market[], filters: {service: string; date: string; query: string; status: string}, now: number) {
  const q = normalizeSearch(filters.query);
  return markets.filter(m =>
    (filters.service === 'all' || serviceCode(m.service) === filters.service) &&
    (!filters.date || (m.travel_date || lisbonDate(m.departure)) === filters.date) &&
    (filters.status === 'all' || effectiveStatus(m, now) === filters.status) &&
    normalizeSearch(`${m.train} ${m.origin} ${m.destination} ${m.service} ${serviceLabel(m.service)}`).includes(q)
  ).sort((a, b) => Date.parse(a.departure) - Date.parse(b.departure) || a.train.localeCompare(b.train));
}
export const resultMethodLabel = (method: string | null) => method === 'simulation' ? 'Resultado simulado' : method === 'manual' ? 'Confirmação manual' : 'Resultado confirmado';
