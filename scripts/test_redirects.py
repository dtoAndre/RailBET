import io
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from sync_timetable import archive_redirect, download

URL='https://data.train-archive.eu/pt-cp/static/latest.json'
TARGET='https://nbg1.your-objectstorage.com/gtfs-rt-storage/pt-cp/static/latest.json'

class RedirectTests(unittest.TestCase):
    def test_storage_redirect_drops_credentials(self):
        url, headers=archive_redirect(URL,TARGET,{'X-Api-Key':'secret-token','Authorization':'Bearer private','Accept':'application/json'})
        self.assertEqual(url,TARGET)
        self.assertEqual(headers,{'Accept':'application/json'})

    def test_unexpected_destinations_rejected(self):
        for target in ['http://nbg1.your-objectstorage.com/gtfs-rt-storage/pt-cp/static/latest.json',
                'https://evil.test/file','https://data.train-archive.eu/login',
                'https://nbg1.your-objectstorage.com/other/pt-cp/static/latest.json',TARGET+'?token=secret-token',
                'https://user:pass@nbg1.your-objectstorage.com/gtfs-rt-storage/pt-cp/static/latest.json']:
            with self.assertRaises(ValueError): archive_redirect(URL,target,{'X-Api-Key':'secret-token'})

    def test_download_follows_302_then_reads_bytes(self):
        with patch('sync_timetable.urllib.request.build_opener') as build:
            opener=build.return_value
            opener.open.side_effect=[HTTPError(URL,302,'Found',{'Location':TARGET},None),io.BytesIO(b'{"ok":true}')]
            self.assertEqual(download(URL,{'X-Api-Key':'secret-token'}),b'{"ok":true}')
            first=opener.open.call_args_list[0].args[0]
            second=opener.open.call_args_list[1].args[0]
            self.assertEqual(first.get_header('X-api-key'),'secret-token')
            self.assertIsNone(second.get_header('X-api-key'))

    def test_supabase_post_is_never_redirected(self):
        with patch('sync_timetable.urllib.request.build_opener') as build:
            build.return_value.open.side_effect=HTTPError('https://project.supabase.co',302,'Found',{'Location':TARGET},None)
            with self.assertRaises(HTTPError): download('https://project.supabase.co',{'Authorization':'Bearer private'},b'{}')
            self.assertEqual(build.return_value.open.call_count,1)

    def test_redirect_limit(self):
        with patch('sync_timetable.urllib.request.build_opener') as build:
            build.return_value.open.side_effect=lambda *a,**k: (_ for _ in ()).throw(HTTPError(URL,302,'Found',{'Location':URL},None))
            with self.assertRaisesRegex(ValueError,'Too many'): download(URL,{'X-Api-Key':'secret-token'})
            self.assertEqual(build.return_value.open.call_count,4)
