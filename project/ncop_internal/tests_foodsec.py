# Unit tests for the Food Security & Agriculture Watch digest (foodsec_watch.py).
# No network: the HDX price CSV is mocked.
#   python manage.py test ncop_internal.tests_foodsec
import json
import tempfile
from unittest import mock

from django.test import RequestFactory, SimpleTestCase, override_settings

from . import foodsec_watch as fw


def _csv(rows):
    """Quoted like the real HDX file (commodity names contain commas)."""
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow("date,admin1,admin2,market,market_id,latitude,longitude,category,commodity,commodity_id,unit,priceflag,pricetype,currency,price,usdprice".split(","))
    w.writerows(rows)
    return buf.getvalue()


def _price_rows():
    """5 markets x 6 years; flour rises 1 %/month plus +5 % every Nov->Dec;
    wage flat at 1400 PKR/day."""
    rows = []
    markets = [("Lahore", "PUNJAB", 31.5, 74.3), ("Karachi", "SINDH", 24.9, 67.0), ("Quetta", "BALOCHISTAN", 30.2, 67.0),
               ("Peshawar", "KHYBER PAKHTUNKHWA", 34.0, 71.6), ("Multan", "PUNJAB", 30.2, 71.5)]
    for y in range(2021, 2027):
        for m in range(1, 13):
            if (y, m) > (2026, 10):
                break
            k = (y - 2021) * 12 + (m - 1)
            flour = 50 * (1.01 ** k)
            for name, a1, lat, lon in markets:
                f = flour * (1.05 if m == 12 else 1.0)
                rows.append((f"{y}-{m:02d}-15", a1, name, name, 1, lat, lon, "cereals", "Wheat flour", 58, "KG", "actual", "Retail", "PKR", round(f, 2), 0))
                rows.append((f"{y}-{m:02d}-15", a1, name, name, 1, lat, lon, "labour", fw.WAGE, 99, "Day", "actual", "Retail", "PKR", 1400, 0))
    return rows


class _Resp:
    def __init__(self, text=None, js=None):
        self.text, self._js = text, js

    def json(self):
        return self._js


class HelperTests(SimpleTestCase):
    def test_month_add_crosses_years_both_ways(self):
        self.assertEqual(fw._month_add((2026, 10), -12), (2025, 10))
        self.assertEqual(fw._month_add((2026, 1), -1), (2025, 12))
        self.assertEqual(fw._month_add((2026, 11), 3), (2027, 2))
        self.assertEqual(fw._month_add((2026, 3), -24), (2024, 3))

    def test_name_matching_variants(self):
        lookup = {fw._norm(n): {"name": n, "province": p} for n, p in [
            ("Lower Kohistan", "KP"), ("Kolai Palas", "KP"), ("Upper Chitral", "KP"), ("Dera Ismail Khan", "KP"), ("Badin", "Sindh")]}
        self.assertEqual(fw._match(lookup, "Kohistan Lower")["name"], "Lower Kohistan")
        self.assertEqual(fw._match(lookup, "Kolai Palas Kohistan")["name"], "Kolai Palas")
        self.assertEqual(fw._match(lookup, "Chitral Upper")["name"], "Upper Chitral")
        self.assertEqual(fw._match(lookup, "D.I. Khan")["name"], "Dera Ismail Khan")
        self.assertEqual(fw._match(lookup, "BADIN DISTRICT")["name"], "Badin")
        self.assertIsNone(fw._match(lookup, "Nowhere"))


class PriceTests(SimpleTestCase):
    def _section(self):
        pkg = {"result": {"resources": [{"name": "Pakistan - Food Prices CSV", "url": "http://x/prices.csv"}]}}
        csv_text = _csv(_price_rows())

        def fake_get(url, timeout=None):
            return _Resp(js=pkg) if "package_show" in url else _Resp(text=csv_text)

        with mock.patch.object(fw.requests.Session, "get", side_effect=lambda url, **kw: fake_get(url)):
            return fw._prices_section()

    def test_yoy_seasonal_path_and_purchasing_power(self):
        p = self._section()
        self.assertEqual(p["latest_month"], "2026-10")
        flour = next(i for i in p["items"] if i["commodity"] == "Wheat flour")
        self.assertEqual(flour["unit"], "PKR/KG")
        self.assertAlmostEqual(flour["yoy_pct"], (1.01 ** 12 - 1) * 100, delta=0.2)
        self.assertEqual([o["month"] for o in flour["outlook"]], ["2026-11", "2026-12", "2027-01"])
        # Nov->Dec carries the +5 % seasonal jump on top of the 1 % trend
        nov, dec = flour["outlook"][0]["mid"], flour["outlook"][1]["mid"]
        self.assertAlmostEqual(dec / nov, 1.01 * 1.05, delta=0.004)
        for o in flour["outlook"]:
            self.assertLessEqual(o["lo"], o["mid"] + 1e-6)
            self.assertGreaterEqual(o["hi"], o["mid"] - 1e-6)
        tot = p["terms_of_trade"]
        self.assertAlmostEqual(tot["latest"], 1400 / flour["latest"], delta=0.1)
        self.assertGreater(tot["year_ago"], tot["latest"])           # flour rose, wage flat
        self.assertEqual(len(p["markets"]), 5)


class ViewTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ov = override_settings(MEDIA_ROOT=self.tmp.name)
        ov.enable()
        self.addCleanup(ov.disable)
        fw._state.update(doc=None, loaded_at=0.0, thread=None)

    def test_202_while_building_then_200_from_cache(self):
        with mock.patch.object(fw, "_build_async") as kick:
            r = fw.FoodSecurityWatchView.as_view()(RequestFactory().get("/api/foodsec/watch/"))
            self.assertEqual(r.status_code, 202)
            kick.assert_called_once()
        doc = {"generated_at": "x", "ipc": None, "crops": None, "prices": None, "outlook": None}
        with open(fw._path(), "w", encoding="utf-8") as f:
            json.dump(doc, f)
        with mock.patch.object(fw, "_build_async") as kick:
            r = fw.FoodSecurityWatchView.as_view()(RequestFactory().get("/api/foodsec/watch/"))
            self.assertEqual(r.status_code, 200)
            self.assertIn("age_s", json.loads(r.content))
            kick.assert_not_called()                                    # fresh file: no rebuild

    def test_failing_section_does_not_break_build(self):
        with mock.patch.object(fw, "_district_lookup", return_value={}), \
             mock.patch.object(fw, "_ipc_section", side_effect=RuntimeError("ipc down")), \
             mock.patch.object(fw, "_crops_section", return_value={"staples": []}), \
             mock.patch.object(fw, "_prices_section", side_effect=RuntimeError("hdx down")), \
             mock.patch.object(fw, "_outlook_section", return_value={"months": []}):
            doc = fw.build()
        self.assertIsNone(doc["ipc"])
        self.assertIsNone(doc["prices"])
        self.assertEqual(doc["crops"], {"staples": []})
