# Tests for the same-origin DEW exposures proxy (dew_proxy.py). No network.
#   python manage.py test ncop_internal.tests_dew
import json
from unittest import mock

import requests
from django.test import RequestFactory, SimpleTestCase

from . import dew_proxy as dp


def _call(params=None):
    return dp.DewExposuresView.as_view()(RequestFactory().get("/api/dew/exposures/", params or {}))


class DewProxyTests(SimpleTestCase):
    def setUp(self):
        dp._state["down_until"] = 0.0

    def test_passes_upstream_through(self):
        up = mock.Mock(status_code=200, content=b'[{"id": 7, "remarks": "x"}]', headers={"Content-Type": "application/json"})
        with mock.patch.object(dp.requests, "get", return_value=up) as g:
            r = _call()
            self.assertEqual(json.loads(r.content), [{"id": 7, "remarks": "x"}])
            r = _call({"exposure_id": "7"})
            self.assertEqual(g.call_args.kwargs["params"], {"exposure_id": "7"})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("X-NCOP-Upstream", r)

    def test_unreachable_upstream_is_clean_and_memoised(self):
        with mock.patch.object(dp.requests, "get", side_effect=requests.ConnectionError()) as g:
            r = _call()
            self.assertEqual((r.status_code, json.loads(r.content), r["X-NCOP-Upstream"]), (200, [], "unavailable"))
            r = _call({"exposure_id": "7"})                     # within the outage memo: no new upstream call
            self.assertEqual((r.status_code, g.call_count), (503, 1))

    def test_rejects_odd_ids(self):
        self.assertEqual(_call({"exposure_id": "1;drop"}).status_code, 400)
