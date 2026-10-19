"""Import future GTFS journeys from Train Archive; never infer final delays."""
import io
import json
import os
import re
import sys
import urllib.request
import urllib.error
import urllib.parse
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

BASE = 'https://data.train-archive.eu/'
LISBON = ZoneInfo('Europe/Lisbon')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def archive_redirect(source, location, headers):
    target = urllib.parse.urljoin(source, location)
    src, dst = urllib.parse.urlsplit(source), urllib.parse.urlsplit(target)
    hosts = {'data.train-archive.eu', 'nbg1.your-objectstorage.com'}
    if (src.scheme != 'https' or src.hostname not in hosts or dst.scheme != 'https'
            or dst.hostname not in hosts or dst.username or dst.password or dst.port not in (None, 443)):
        raise ValueError('Blocked redirect: expected HTTPS Train Archive storage')
    resource = src.path.removeprefix('/gtfs-rt-storage') if src.hostname == 'nbg1.your-objectstorage.com' else src.path
    expected = '/gtfs-rt-storage'+resource if dst.hostname == 'nbg1.your-objectstorage.com' else resource
    if dst.path != expected or dst.fragment:
        raise ValueError('Blocked redirect: unexpected archive resource')
    # Do not follow a URL that embeds one of our credentials in its query/path.
    credentials = [v for k,v in headers.items() if k.lower() in ('x-api-key','authorization','apikey')]
    if any(v and v in urllib.parse.unquote(target) for v in credentials):
        raise ValueError('Blocked redirect: credential in destination URL')
    forwarded = dict(headers) if dst.hostname == src.hostname else {
        k:v for k,v in headers.items() if k.lower() in ('accept','user-agent')}
    return target, forwarded

def download(url, headers, payload=None):
    opener = urllib.request.build_opener(NoRedirect())
    for hop in range(4):
        request = urllib.request.Request(url, headers=headers, data=payload)
        try:
            with opener.open(request, timeout=45) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            break
        except urllib.error.HTTPError as exc:
            location = exc.headers.get('Location')
            if payload is not None or exc.code not in (301,302,303,307,308) or not location:
                raise
            exc.close()
            if hop == 3:
                raise ValueError('Too many archive redirects') from None
            url, headers = archive_redirect(url, location, headers)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('Response above 32 MB limit')
    return data

def table_url(path):
    url = path if path.startswith('https://') else BASE + path.lstrip('/')
    if not re.fullmatch(r'https://data\.train-archive\.eu/pt-cp/static/[A-Za-z0-9_-]+/[a-z_]+\.parquet', url):
        raise ValueError('Unexpected timetable URL')
    return url

def day(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).replace('-', '')
    return datetime.strptime(text, '%Y%m%d').date()

def active_services(tables, service_date):
    weekday = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'][service_date.weekday()]
    active = {str(r['service_id']) for r in tables.get('calendar', [])
              if day(r['start_date']) <= service_date <= day(r['end_date']) and str(r[weekday]) in ('1', 'True')}
    for r in tables.get('calendar_dates', []):
        if day(r['date']) == service_date:
            if int(r['exception_type']) == 1:
                active.add(str(r['service_id']))
            elif int(r['exception_type']) == 2:
                active.discard(str(r['service_id']))
    return active

def instant(service_date, clock):
    # GTFS defines times as elapsed seconds from local noon minus twelve hours.
    if not re.fullmatch(r'\d{1,2}:\d{2}:\d{2}', str(clock)):
        raise ValueError('Unsupported GTFS time')
    h, m, s = map(int, str(clock).split(':'))
    if h > 47 or m > 59 or s > 59:
        raise ValueError('Invalid GTFS time')
    noon = datetime.combine(service_date, datetime.min.time()).replace(hour=12, tzinfo=LISBON)
    return noon.astimezone(timezone.utc) + timedelta(seconds=h*3600+m*60+s-43200)

def journeys(tables, now, limit=20, train_filter=None):
    if not tables.get('calendar') and not tables.get('calendar_dates'):
        raise ValueError('No service calendar: cannot safely create markets')
    stations = {str(r['stop_id']): str(r['stop_name']) for r in tables['stops']}
    routes = {str(r['route_id']): str(r.get('route_short_name') or r.get('route_long_name') or 'Comboio') for r in tables['routes']}
    times = defaultdict(list)
    for r in tables['stop_times']:
        times[str(r['trip_id'])].append(r)
    frequency_trips = {str(r['trip_id']) for r in tables.get('frequencies', [])}
    result, skipped = [], 0
    today = now.astimezone(LISBON).date()
    for service_date in (today-timedelta(days=1), today, today+timedelta(days=1)):
        active = active_services(tables, service_date)
        candidates = []
        for trip in tables['trips']:
            tid = str(trip['trip_id'])
            if str(trip['service_id']) not in active or tid in frequency_trips:
                continue
            # Never extract digits from an opaque identifier and pretend it is a train number.
            train = str(trip.get('trip_short_name') or '')
            if not re.fullmatch(r'\d{1,6}', train):
                skipped += 1
                continue
            if train_filter and train not in train_filter:
                continue
            stops = sorted(times.get(tid, []), key=lambda r: int(r['stop_sequence']))
            if len(stops) < 2:
                skipped += 1
                continue
            try:
                departure = instant(service_date, stops[0]['departure_time'])
                arrival = instant(service_date, stops[-1]['arrival_time'])
                origin = stations[str(stops[0]['stop_id'])]
                destination = stations[str(stops[-1]['stop_id'])]
            except (ValueError, KeyError):
                skipped += 1
                continue
            if departure <= now+timedelta(minutes=10) or departure > now+timedelta(hours=48) or arrival <= departure:
                continue
            candidates.append(dict(train=train, travelDate=departure.astimezone(LISBON).date().isoformat(),
                service=routes.get(str(trip['route_id']), 'Comboio'), origin=origin, destination=destination,
                departure=departure.isoformat(), arrival=arrival.isoformat(), tripId=tid, serviceDate=service_date.isoformat()))
        result.extend(candidates)
    # Ambiguous train/date combinations must not silently pick one route.
    grouped = defaultdict(list)
    for item in result:
        grouped[(item['train'], item['travelDate'])].append(item)
    unique = [items[0] for items in grouped.values() if len(items) == 1]
    selected = []
    for d in sorted({r['travelDate'] for r in unique}):
        selected.extend(sorted((r for r in unique if r['travelDate'] == d), key=lambda r:r['departure'])[:limit])
    return selected, skipped

def main():
    token = os.environ['TRAIN_ARCHIVE_API_KEY'].strip()
    supabase = os.environ['SUPABASE_URL'].strip().rstrip('/')
    key = os.environ['SUPABASE_SERVICE_ROLE_KEY'].strip()
    if not re.fullmatch(r'https://[a-z0-9-]+\.supabase\.co', supabase):
        raise ValueError('SUPABASE_URL must be the HTTPS project URL')
    headers = {'X-Api-Key': token}
    latest = json.loads(download(BASE+'pt-cp/static/latest.json', headers))
    import pyarrow.parquet as pq
    tables = {}
    for name in ('stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates', 'frequencies'):
        path = latest['tables'].get(name)
        if path:
            tables[name] = pq.read_table(io.BytesIO(download(table_url(path), headers))).to_pylist()
    for required in ('stops', 'routes', 'trips', 'stop_times'):
        if not tables.get(required):
            raise ValueError('Required timetable table missing: '+required)
    limit = int(os.environ.get('RAILBET_DAILY_LIMIT', '20'))
    if not 1 <= limit <= 100:
        raise ValueError('RAILBET_DAILY_LIMIT must be 1..100')
    train_filter = set(filter(None, (s.strip() for s in os.environ.get('RAILBET_TRAINS', '').split(','))))
    items, skipped = journeys(tables, datetime.now(timezone.utc), limit, train_filter)
    print(f'Validated future journeys: {len(items)}; skipped unsupported records: {skipped}')
    if not items:
        print('Trip columns:', sorted(tables['trips'][0]))
        raise ValueError('No eligible future journeys; no fabricated schedules were inserted')
    payload = json.dumps({'p_journeys': items, 'p_version': str(latest.get('version', 'unknown'))}).encode()
    result = download(supabase+'/rest/v1/rpc/railbet_sync_timetable',
        {'apikey': key, 'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'}, payload)
    print('Supabase sync:', result.decode())

if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as exc:
        # Do not print request headers or upstream response bodies containing secrets.
        print(f'Sync failed: HTTP {exc.code} from {urllib.parse.urlsplit(exc.url).hostname}', file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        print('Sync failed:', type(exc).__name__, str(exc) if isinstance(exc, (ValueError, KeyError)) else 'Check connection/dependencies', file=sys.stderr)
        sys.exit(1)
