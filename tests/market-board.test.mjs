import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveStatus, filterMarkets, lisbonDate, serviceCode, serviceLabel} from '../lib/market-board.ts';
const now = Date.parse('2026-07-15T12:00:00Z');
const market = (extra = {}) => ({id:'1', train:'121', service:'AP', travel_date:'2026-07-15', origin:'Lisboa Oriente', destination:'Porto Campanhã', departure:'2026-07-15T13:00:00Z', arrival:'2026-07-15T16:00:00Z', closes_at:'2026-07-15T12:50:00Z', status:'open', ...extra});
const filters = {service:'all', date:'', query:'', status:'all'};
test('InterRegionais are distinct from Regional across source spellings', () => {
  for (const s of ['IR', 'InterRegional', 'Inter-Regional', 'Inter Regionais']) {
    assert.equal(serviceCode(s), 'IR'); assert.equal(serviceLabel(s), 'InterRegional');
  }
  assert.equal(serviceCode('Regional'), 'R');
  assert.equal(serviceCode('Alfa Pendular'), 'AP');
  assert.equal(serviceCode('Intercidades'), 'IC');
  assert.equal(serviceLabel('Urbano'), 'Urbano');
});
test('service, day, status and accent-insensitive search combine without losing locked trains', () => {
  const rows = [market(), market({id:'2', service:'IR', closes_at:'2026-07-15T11:50:00Z'}), market({id:'3', service:'IR', travel_date:'2026-07-14'}), market({id:'4', service:'R'})];
  assert.deepEqual(filterMarkets(rows, {...filters, service:'IR', date:'2026-07-15', status:'locked', query:'campanha'}, now).map(m => m.id), ['2']);
  assert.equal(rows[1].status, 'open'); // Filtering must not mutate server data.
  assert.equal(filterMarkets(rows, {...filters, status:'open'}, now).length, 3);
  assert.equal(filterMarkets(rows, {...filters, query:'interregional'}, now).length, 2);
});
test('closed is separate from settled and void, even after scheduled arrival', () => {
  const rows = [market({status:'locked'}), market({id:'2', status:'settled'}), market({id:'3', status:'void'})];
  const late = now + 86400000;
  assert.equal(filterMarkets(rows, {...filters, status:'locked'}, late).length, 1);
  assert.equal(filterMarkets(rows, {...filters, status:'settled'}, late)[0].id, '2');
  assert.equal(filterMarkets(rows, {...filters, status:'void'}, late)[0].id, '3');
  assert.equal(effectiveStatus(market({closes_at:new Date(now).toISOString()}), now), 'locked');
});
test('Lisbon day handles midnight in summer; service date preserves overnight journeys', () => {
  assert.equal(lisbonDate('2026-07-14T23:30:00Z'), '2026-07-15');
  const overnight = market({departure:'2026-07-14T23:30:00Z', travel_date:'2026-07-14'});
  assert.equal(filterMarkets([overnight], {...filters, date:'2026-07-14'}, now).length, 1);
  assert.equal(filterMarkets([overnight], {...filters, date:'2026-07-15'}, now).length, 0);
});
