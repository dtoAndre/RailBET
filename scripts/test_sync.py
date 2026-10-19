import unittest
from datetime import datetime, date, timezone
from sync_timetable import active_services, instant, journeys, table_url

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

if __name__=='__main__': unittest.main()
