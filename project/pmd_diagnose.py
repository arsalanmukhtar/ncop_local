"""
Standalone prod diagnostic for PMD Predictions.

Run from the project root under the app's venv:
    cd /home/cladmin/ncop_local/ncop_local_prod/project
    DJANGO_SETTINGS_MODULE=ncop_project.settings.prod python pmd_diagnose.py

Walks ONE forecast frame through the exact same auth-fetch → gdal.Warp →
gdal.DEMProcessing chain _mon_pred_convert_step uses in production, but
with verbose output at every step so you can see exactly which stage
produces the empty-raster result.

Prints:
  1. Auth session status + token length
  2. modelTimeList result (latest run)
  3. model result (first frame path)
  4. Fetched .tif size + magic bytes (proves it's real TIFF binary)
  5. gdal.Open metadata (dimensions, projection, geotransform, band stats)
  6. gdal.Warp result (dimensions, band stats, non-nodata pixel count)
  7. gdal.DEMProcessing PNG output (size, RGBA band stats)

Any stage that fails prints its reason inline and exits.
No prod state is mutated (writes to /tmp/pmd_diag_*, not MEDIA_ROOT).
Safe to run repeatedly.
"""
import os
import sys
import ssl
import time

# Django bootstrap so we get the same PROJ_LIB fix + PMD_MONITOR_* creds
# the running app has, without duplicating them here.
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "ncop_project.settings.prod")
import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402
import requests  # noqa: E402
import urllib3  # noqa: E402
from requests.adapters import HTTPAdapter  # noqa: E402
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# ------------------------------------------------------------------ helpers
def h(msg):
    print("\n" + "=" * 72)
    print(msg)
    print("=" * 72)


def fail(msg):
    print(f"\n✗ FAIL — {msg}")
    sys.exit(1)


BASE = getattr(settings, "PMD_MONITOR_URL", "").rstrip("/")
USER = getattr(settings, "PMD_MONITOR_USER", "")
PASS = getattr(settings, "PMD_MONITOR_PASS", "")


class _MonSSLAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try: ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
        except Exception: pass
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


# ------------------------------------------------------------------ 1. auth
h("1 · Env + auth")
print(f"BASE  = {BASE!r}")
print(f"USER  = {USER!r}")
print(f"PROJ_LIB  = {os.environ.get('PROJ_LIB')!r}")
print(f"GDAL_DATA = {os.environ.get('GDAL_DATA')!r}")
if not (BASE and USER and PASS):
    fail("PMD_MONITOR_* not set in the env — check settings/base.py + .env")

s = requests.Session()
s.mount("https://", _MonSSLAdapter())
s.headers.update({
    "User-Agent": "NCOP-diag/1.0",
    "Accept": "application/json, text/html, */*",
    "Referer": BASE + "/",
})
r = s.post(f"{BASE}/user/login", json={"username": USER, "password": PASS},
           timeout=15, verify=False, allow_redirects=False)
if r.status_code not in (200, 201):
    fail(f"login HTTP {r.status_code}: {r.text[:200]!r}")
body = r.json()
tok = body.get("token") or (body.get("data") or {}).get("token")
if not tok or len(tok) < 20:
    fail(f"no bearer token in login response body: {body!r}")
s.headers["Authorization"] = f"Bearer {tok}"
print(f"✓ login OK — token len={len(tok)}   code={body.get('code')}")


# ------------------------------------------------------------------ 2. modelTimeList (hourtpe)
h("2 · /api/modelTimeList (WRFPRS/HOURTPE)")
r = s.get(f"{BASE}/api/modelTimeList",
          params={"data_type": "WRFPRS", "element": "HOURTPE"},
          timeout=15, verify=False)
j = r.json()
runs = (j.get("data") or [])
print(f"HTTP {r.status_code}  runs={len(runs)}")
if not runs:
    fail(f"no runs returned; body={j!r}")
run = runs[0]["data_time"]
print(f"✓ latest run = {run}")


# ------------------------------------------------------------------ 3. /api/model
h("3 · /api/model (frame list for that run)")
r = s.get(f"{BASE}/api/model",
          params={"data_type": "WRFPRS", "element": "HOURTPE", "date_time": run},
          timeout=15, verify=False)
j = r.json()
ds = (j.get("ds") or [])
print(f"HTTP {r.status_code}  frames={len(ds)}")
if not ds:
    fail(f"empty frame list; body={j!r}")
first = ds[0]
print(f"✓ first frame:")
for k, v in first.items():
    print(f"    {k} = {v}")


# ------------------------------------------------------------------ 4. fetch one .tif
h("4 · Fetch the first frame's .tif")
tif_path = first["file_path"]  # e.g. /static/WRFPRS/2026072800/HOURTPE/....tif
r = s.get(f"{BASE}/{tif_path.lstrip('/')}", timeout=30, verify=False)
if r.status_code != 200:
    fail(f".tif fetch HTTP {r.status_code}: {r.text[:200]!r}")
tif_bytes = r.content
print(f"HTTP {r.status_code}  size={len(tif_bytes)} bytes")

magic = tif_bytes[:4]
looks_tif = magic in (b"II*\x00", b"MM\x00*", b"II\x2b\x00", b"MM\x00\x2b")
print(f"magic bytes = {magic!r}   looks-like-TIFF={looks_tif}")
if not looks_tif:
    preview = tif_bytes[:200].decode("latin1", errors="replace")
    fail(f"fetched content is NOT a TIFF — preview: {preview!r}\n"
         f"(This means the auth session isn't authorising the .tif "
         f"download, and PMD Monitor is serving an HTML error page. "
         f"In prod ncopenv311 vs staging, the requests SSL adapter "
         f"or session cookies may differ.)")

src_local = "/tmp/pmd_diag_src.tif"
with open(src_local, "wb") as f:
    f.write(tif_bytes)
print(f"✓ saved to {src_local}")


# ------------------------------------------------------------------ 5. gdal.Open the src
h("5 · gdal.Open the fetched .tif")
try: from osgeo import gdal, osr
except Exception as e: fail(f"osgeo import failed: {e}")

try: gdal.UseExceptions()
except Exception: pass

src_ds = gdal.Open(src_local)
if src_ds is None:
    fail("gdal.Open returned None — file is not a readable raster")

print(f"dimensions : {src_ds.RasterXSize} x {src_ds.RasterYSize}")
print(f"bands      : {src_ds.RasterCount}")
print(f"geotrans   : {src_ds.GetGeoTransform()}")
print(f"projection : {(src_ds.GetProjection() or '')[:200]!r}")

srs = osr.SpatialReference(src_ds.GetProjection() or "")
epsg = srs.GetAttrValue("AUTHORITY", 1) if srs.IsProjected() or srs.IsGeographic() else None
print(f"srs EPSG   : {epsg}")

for i in range(1, src_ds.RasterCount + 1):
    b = src_ds.GetRasterBand(i)
    try:
        mn, mx, mean, std = b.GetStatistics(False, True)
        print(f"band{i}: min={mn} max={mx} mean={mean:.3f} std={std:.3f} "
              f"nodata={b.GetNoDataValue()} dtype={gdal.GetDataTypeName(b.DataType)}")
    except Exception as e:
        print(f"band{i}: STATS FAILED — {e}")


# ------------------------------------------------------------------ 6. gdal.Warp
h("6 · gdal.Warp → EPSG:3857 (no bbox — same as WRFPRS layers)")
warped_local = "/tmp/pmd_diag_3857.tif"
if os.path.exists(warped_local): os.remove(warped_local)

try:
    warped_ds = gdal.Warp(warped_local, src_ds, options=gdal.WarpOptions(
        dstSRS="EPSG:3857", format="GTiff", resampleAlg="bilinear",
    ))
except Exception as e:
    fail(f"gdal.Warp RAISED: {e}")

if warped_ds is None:
    fail("gdal.Warp returned None (would have printed a GDAL ERROR to stderr above)")

print(f"warped dimensions : {warped_ds.RasterXSize} x {warped_ds.RasterYSize}")
print(f"warped bands      : {warped_ds.RasterCount}")
print(f"warped file size  : {os.path.getsize(warped_local)} bytes")

for i in range(1, warped_ds.RasterCount + 1):
    b = warped_ds.GetRasterBand(i)
    try:
        mn, mx, mean, std = b.GetStatistics(False, True)
        print(f"warped_band{i}: min={mn} max={mx} mean={mean:.3f} std={std:.3f} "
              f"nodata={b.GetNoDataValue()}")
        if mn == mx:
            print(f"    ⚠ WARP OUTPUT IS UNIFORM — all pixels are {mn}. "
                  f"This is the smoking gun: warp landed on NoData across "
                  f"the entire extent.")
    except Exception as e:
        print(f"warped_band{i}: STATS FAILED — {e}")
warped_ds = None


# ------------------------------------------------------------------ 7. gdal.DEMProcessing (color-relief)
h("7 · gdal.DEMProcessing color-relief → PNG")
ramp_local = "/tmp/pmd_diag_ramp.txt"
# Same 3h-precip ramp _MON_PRED_ELEMENTS['hourtpe']['stops'] emits.
with open(ramp_local, "w") as f:
    f.write("\n".join([
        "nv 0 0 0 0",
        "0 185 244 171 0",
        "0.1 185 244 171 255",
        "2.5 111 218 111 255",
        "5 56 188 57 255",
        "10 37 144 38 255",
        "25 98 184 255 255",
        "50 0 0 252 255",
        "100 250 0 250 255",
    ]))

png_local = "/tmp/pmd_diag.png"
if os.path.exists(png_local): os.remove(png_local)

try:
    colored_ds = gdal.DEMProcessing(
        png_local, warped_local, "color-relief",
        colorFilename=ramp_local, format="PNG", addAlpha=True,
    )
except Exception as e:
    fail(f"gdal.DEMProcessing RAISED: {e}")

if colored_ds is None:
    fail("gdal.DEMProcessing returned None")

png_size = os.path.getsize(png_local)
print(f"PNG size: {png_size} bytes")
if png_size < 4096:
    print(f"    ⚠ PNG IS TRIVIALLY SMALL — this is the failure mode you're seeing in prod.")

colored_ds = None
check_ds = gdal.Open(png_local)
print(f"PNG dims : {check_ds.RasterXSize} x {check_ds.RasterYSize}   bands: {check_ds.RasterCount}")
for i in range(1, check_ds.RasterCount + 1):
    b = check_ds.GetRasterBand(i)
    try:
        mn, mx, mean, std = b.GetStatistics(False, True)
        print(f"  png_band{i}: min={mn} max={mx} mean={mean:.3f} std={std:.3f}")
    except Exception as e:
        print(f"  png_band{i}: STATS FAILED — {e}")

h("Summary")
print(f"src   : {os.path.getsize(src_local)} bytes  ({src_ds.RasterXSize}x{src_ds.RasterYSize})")
print(f"warped: {os.path.getsize(warped_local)} bytes")
print(f"png   : {os.path.getsize(png_local)} bytes")
print("")
print("If src has real data (band1 min != max) BUT warped is uniform,")
print("    → GDAL warp is broken on this prod install. Report step 6's output.")
print("If src has real data AND warped has real data BUT png is tiny,")
print("    → DEMProcessing / color-relief is misbehaving. Report step 7's output.")
print("If src is a suspicious mime type / bad magic bytes,")
print("    → auth session fell through to an HTML error page. Report step 4's output.")