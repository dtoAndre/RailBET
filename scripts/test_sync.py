import unittest
import json
from unittest.mock import patch
from datetime import datetime, date, timezone
from sync_timetable import active_services, instant, journeys, sync_journeys, table_url

class TimetableTests(unittest.TestCase):
    def fixture(self):
        return {'stops':[{'stop_id':'a','stop_name':'Lisboa'},{'stop_id':'b','stop_name':'Porto'}],
            'routes':[{'route_id':'r','route_short_name':'AP'}],
            'trips':[{'trip_id':'opaque-trip','trip_short_name':'125','route_id':'r','service_id':'s'}],
            'stop_times':[{'trip_id':'opaque-trip','stop_id':'b','stop_sequence':2,'arrival_time':'14:00:00'},
                {'trip_id':'opaque-trip','stop_id':'a','stop_sequence':1,'departure_time':'12:00:00'}],
            'calendar_dates':[{'service_id':'s','date':'20261019','exception_type':1}]}

    def test_active_exception_and_no_invented_days(self):
        t=self.fixture()
        self.assertEqual(active_services(t,date(2026,10,19)),{'s'})
        self.assertEqual(active_services(t,date(2026,10,20)),set())
        t['calendar']=[dict(service_id='s',start_date='20261001',end_date='20261031',monday=1)]
        t['calendar_dates'][0]['exception_type']=2
        self.assertEqual(active_services(t,date(2026,10,19)),set())

    def test_future_only_preserve_opaque_trip_id(self):
        t=self.fixture(); now=datetime(2026,10,19,9,tzinfo=timezone.utc)
        rows,_=journeys(t,now)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['departure'],'2026-10-19T11:00:00+00:00')
        self.assertEqual(rows[0]['tripId'],'opaque-trip')
        self.assertNotIn('actualDelay',rows[0])
        self.assertEqual(journeys(t,now.replace(hour=11))[0],[])
        t['trips'][0]['trip_short_name']=''
        self.assertEqual(journeys(t,now)[0],[])

    def test_overnight_and_gtfs_dst(self):
        self.assertEqual(instant(date(2026,10,19),'25:10:00').isoformat(),'2026-10-20T00:10:00+00:00')
        self.assertEqual(instant(date(2026,10,25),'12:00:00').isoformat(),'2026-10-25T12:00:00+00:00')
        with self.assertRaises(ValueError): instant(date(2026,10,19),'12:99:00')

    def test_ambiguity_and_frequency_are_not_guessed(self):
        t=self.fixture(); now=datetime(2026,10,19,9,tzinfo=timezone.utc)
        t['trips'].append(dict(t['trips'][0]))
        self.assertEqual(journeys(t,now)[0],[])
        t=self.fixture();t['frequencies']=[{'trip_id':'opaque-trip'}]
        self.assertEqual(journeys(t,now)[0],[])

    def test_url_allowlist(self):
        self.assertEqual(table_url('pt-cp/static/2026-10-17_17-18-00Z/trips.parquet'),'https://data.train-archive.eu/pt-cp/static/2026-10-17_17-18-00Z/trips.parquet')
        for path in ['https://evil.test/trips.parquet','pt-cp/static/../trips.parquet']:
            with self.assertRaises(ValueError): table_url(path)

    def test_only_explicit_ap_ic_ir_routes(self):
        now=datetime(2026,10,19,9,tzinfo=timezone.utc)
        for category, expected in [('AP',1),('IC',1),('IR',1),(' ir ',1),
                ('R',0),('U',0),('Linha de Sintra',0),('MIR',0),('',0)]:
            with self.subTest(category=category):
                t=self.fixture()
                t['routes'][0]['route_short_name']=category
                # Generic rail type and opaque IDs are not category evidence.
                t['routes'][0]['route_type']='2'
                t['routes'][0]['route_long_name']='AP'
                rows,_=journeys(t,now)
                self.assertEqual(len(rows),expected)
                if rows: self.assertEqual(rows[0]['service'],category.strip().upper())
        t=self.fixture();t['trips'][0]['route_id']='missing'
        self.assertEqual(journeys(t,now)[0],[])

    def test_all_services_all_day_and_tomorrow_without_twenty_limit(self):
        t=self.fixture();t['trips']=[];t['stop_times']=[]
        t['routes']=[dict(route_id=c,route_short_name=c) for c in ('AP','IC','IR','R','U')]
        t['calendar_dates'] += [dict(service_id='s',date=d,exception_type=1)
                               for d in ('20261020','20261021')]
        for i in range(125):
            tid=f'trip-{i}';hour=12 if i<100 else 21
            t['trips'].append(dict(trip_id=tid,trip_short_name=str(100+i),route_id=['AP','IC','IR','R','U'][i%5],service_id='s'))
            t['stop_times'] += [dict(trip_id=tid,stop_id='a',stop_sequence=1,departure_time=f'{hour}:00:00'),
                               dict(trip_id=tid,stop_id='b',stop_sequence=2,arrival_time=f'{hour+1}:00:00')]
        now=datetime(2026,10,19,9,tzinfo=timezone.utc)
        rows,_=journeys(t,now)
        self.assertEqual(len(rows),150)
        self.assertEqual({r['travelDate'] for r in rows},{'2026-10-19','2026-10-20'})
        self.assertEqual(sum(r['departure'].endswith('20:00:00+00:00') for r in rows),30)
        self.assertEqual({r['service'] for r in rows},{'AP','IC','IR'})
        self.assertEqual(len(journeys(t,now,train_filter={'100'})[0]),2)
        self.assertEqual(journeys(t,now,train_filter={'103'})[0],[])

    def test_previous_service_day_and_exclude_day_after_tomorrow(self):
        t=self.fixture()
        t['calendar_dates']=[dict(service_id='s',date=d,exception_type=1)
                             for d in ('20261018','20261019','20261020')]
        t['stop_times'][0]['arrival_time']='26:00:00'
        t['stop_times'][1]['departure_time']='25:00:00'
        rows,_=journeys(t,datetime(2026,10,18,23,30,tzinfo=timezone.utc))
        self.assertEqual([(r['serviceDate'],r['travelDate']) for r in rows],
                         [('2026-10-18','2026-10-19'),('2026-10-19','2026-10-20')])

    def test_batched_upload_preserves_all_items_and_stops_on_failure(self):
        items=[{'train':str(i)} for i in range(601)]
        batches=[]
        def respond(url,headers,payload):
            body=json.loads(payload)
            self.assertEqual(body['p_version'],'fixture-version')
            batches.append(body['p_journeys'])
            return json.dumps({'inserted':len(batches[-1]),'received':len(batches[-1])}).encode()
        with patch('sync_timetable.download',side_effect=respond), patch('builtins.print'):
            self.assertEqual(sync_journeys('https://project.supabase.co','test-key',items,'fixture-version'),
                             {'inserted':601,'received':601})
        self.assertEqual([len(b) for b in batches],[100,100,100,100,100,100,1])
        self.assertEqual([r for batch in batches for r in batch],items)
        with patch('sync_timetable.download',side_effect=[b'{"inserted":100,"received":100}',ValueError('failed')]) as send, patch('builtins.print'):
            with self.assertRaisesRegex(ValueError,'failed'):
                sync_journeys('https://project.supabase.co','test-key',items,'fixture-version')
            self.assertEqual(send.call_count,2)

if __name__=='__main__': unittest.main()

