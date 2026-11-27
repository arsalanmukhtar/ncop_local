# project/ncop_internal/flood_atlas.py
# ---------------------------------------------------------------------------
# Who and what stands on the flood plains: a one-off atlas per district, used
# for planning when a river threatens. Built once (about 5 minutes) into
# media/floodwatch/atlas.json (~150 KB); nothing here runs in a request.
#
#   observed  NCOP's own satellite flood extents (GeoServer), 2010-2025: land
#             mapped as flooded at least once / in three or more years. This is
#             the main measure.
#   modelled  JRC / Copernicus river flood hazard v2.1, 1-in-10/100/500-year.
#             It assumes NO embankments and covers far more land than any flood
#             mapped in Pakistan (1-in-10: 169,000 km2; 2010: 76,000 km2), so
#             it is used only as the upper limit.
#   people    JRC GHSL 2025, scaled to the 2023 census provincial totals
#   cropland  MODIS MCD12Q1
#   places    NCOP schools, hospitals and health posts, bridges, settlements
#
# Everything is counted on one 0.0025 degree grid (about 280 m x 240 m), so a
# point within that distance of water may be counted. These are potential
# exposures, not damage.
# ---------------------------------------------------------------------------

import io
import json
import logging
import os
import time
import uuid
import zipfile
from datetime import date

import numpy as np
import requests

from . import flood_store as fs

logger = logging.getLogger(__name__)

W, S, E, N = 60.5, 23.5, 77.5, 37.2
RES = 0.0025
NX, NY = round((E - W) / RES), round((N - S) / RES)      # 6800 x 5480
BLK = 1370                                               # rows per download
GEOSERVER = "http://172.18.7.35:8080/geoserver"
OBSERVED = {
    "2010": ["G15_Flood_Inundation_2010_SUPARCO"], "2011": ["G16_Flood_Inundation_2011_SUPARCO"],
    "2012": ["G17_Flood_Inundation_2012_SUPARCO"], "2013": ["G18_Flood_Inundation_2013_SUPARCO"],
    "2014": ["G19_Flood_Inundation_2014_SUPARCO"], "2015": ["G20_Flood_Inundation_2015_NDMA_GIS_Team"],
    "2022": ["flood_2022"], "2023": ["Flood_Extent2023"],
    "2025": ["FloodExtents_CummTill14Sep25Dis", "Flood_Extent_Comulated_5to21f"],
}
POINTS = {"schools": ("Schools_QC", None), "health": ("health_facilities", None), "bridges": ("Bridges_QC", None),
          "settlements": ("settlements", None)}
OUTSIDE = "Indian_Illegally_Occupied_Jammu_Kashmir"


def _path():
    return os.path.join(fs.root(), "atlas.json")


def load():
    try:
        with open(_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _ee_grid(ee, image, dtype):
    """One band on the atlas grid, downloaded in row blocks as raw arrays."""
    out = np.zeros((NY, NX), dtype)
    for top in range(0, NY, BLK):
        h = min(BLK, NY - top)
        for left in range(0, NX, 3400):
            w = min(3400, NX - left)
            tf = [RES, 0, W + left * RES, 0, -RES, N - top * RES]
            for attempt in range(3):
                try:
                    url = image.rename("b").unmask(0).getDownloadURL({"format": "NPY", "crs": "EPSG:4326", "crs_transform": tf, "dimensions": [w, h]})
                    r = requests.get(url, timeout=300)
                    r.raise_for_status()
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(8)
            out[top:top + h, left:left + w] = np.load(io.BytesIO(r.content), allow_pickle=False)["b"].astype(dtype)
    return out


# Fill only: the layers' own styles draw outlines, which swell narrow flood strips
# (2022 came out at 54,600 km2 that way; its polygons add up to 35,400).
_FILL = ('<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld"><NamedLayer><Name>{layer}</Name><UserStyle><FeatureTypeStyle><Rule>'
         '<PolygonSymbolizer><Fill><CssParameter name="fill">#000000</CssParameter></Fill></PolygonSymbolizer></Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>')


def _wms_mask(layers):
    from PIL import Image
    m = np.zeros((NY, NX), bool)
    for layer in layers:
        for top in range(0, NY, BLK):
            h = min(BLK, NY - top)
            for left in range(0, NX, 3400):
                w = min(3400, NX - left)
                bbox = (W + left * RES, N - (top + h) * RES, W + (left + w) * RES, N - top * RES)
                r = requests.get(f"{GEOSERVER}/gcop/wms", timeout=300, params={
                    "service": "WMS", "version": "1.1.1", "request": "GetMap", "srs": "EPSG:4326", "sld_body": _FILL.format(layer=f"gcop:{layer}"),
                    "bbox": ",".join(f"{x:.6f}" for x in bbox), "width": w, "height": h, "format": "image/png", "transparent": "true"})
                r.raise_for_status()
                a = np.array(Image.open(io.BytesIO(r.content)).convert("RGBA"))[..., 3]
                m[top:top + h, left:left + w] |= a >= 128            # at least half the cell is flooded
    return m


def _districts():
    """(district index grid, [{name, province}])."""
    from osgeo import gdal, ogr

    from . import gefs_districts as gd
    tmp = os.path.join(fs.root(), f"d{uuid.uuid4().hex[:6]}.zip")
    try:
        r = requests.get(gd.wfs_url(), timeout=120)
        r.raise_for_status()
        with open(tmp, "wb") as f:
            f.write(r.content)
        shp = next(n for n in zipfile.ZipFile(tmp).namelist() if n.lower().endswith(".shp"))
        ds = ogr.Open(f"/vsizip/{tmp.replace(os.sep, '/')}/{shp}")
        lay = ds.GetLayer()
        defn = lay.GetLayerDefn()
        low = {defn.GetFieldDefn(i).GetName().lower(): defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())}
        fn = next(low[k] for k in ("name", "district", "district_n", "dist_name", "adm2_en") if k in low)
        fp = next(low[k] for k in ("province", "province_n", "prov_name", "adm1_en") if k in low)
        mem = ogr.GetDriverByName("MEM" if ogr.GetDriverByName("MEM") else "Memory").CreateDataSource("x")
        ml = mem.CreateLayer("d", lay.GetSpatialRef(), ogr.wkbMultiPolygon)
        ml.CreateField(ogr.FieldDefn("i", ogr.OFTInteger))
        meta = []
        for f in lay:
            g = f.GetGeometryRef()
            if g is None:
                continue
            o = ogr.Feature(ml.GetLayerDefn())
            o.SetField("i", len(meta) + 1)
            o.SetGeometry(g.Clone())
            ml.CreateFeature(o)
            meta.append({"name": f.GetField(fn), "province": f.GetField(fp)})
        rs = gdal.GetDriverByName("MEM").Create("", NX, NY, 1, gdal.GDT_UInt16)
        rs.SetGeoTransform((W, RES, 0, N, 0, -RES))
        rs.SetProjection(lay.GetSpatialRef().ExportToWkt())
        gdal.RasterizeLayer(rs, [1], ml, options=["ATTRIBUTE=i"])
        grid = np.frombuffer(rs.GetRasterBand(1).ReadRaster(0, 0, NX, NY), dtype=np.uint16).reshape(NY, NX).copy()
        ds = None
        return grid, meta
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _points(layer):
    """(lon, lat) arrays of a point layer, coordinates only, page by page."""
    xs, ys, start = [], [], 0
    while True:
        r = requests.get(f"{GEOSERVER}/wfs", timeout=180, params={
            "service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": f"gcop:{layer}", "outputFormat": "application/json",
            "srsName": "EPSG:4326", "count": 20000, "startIndex": start, "propertyName": _geom_name(layer)})
        r.raise_for_status()
        fts = r.json().get("features") or []
        for f in fts:
            g = f.get("geometry") or {}
            c = g.get("coordinates") or []
            if g.get("type") == "MultiPoint" and c:
                c = c[0]
            if len(c) >= 2:
                xs.append(c[0])
                ys.append(c[1])
        if len(fts) < 20000:
            return np.array(xs, float), np.array(ys, float)
        start += 20000


def _geom_name(layer):
    t = requests.get(f"{GEOSERVER}/wfs", timeout=60, params={"service": "WFS", "version": "2.0.0", "request": "DescribeFeatureType",
                                                             "typeNames": f"gcop:{layer}", "outputFormat": "application/json"}).json()
    return next(p["name"] for p in t["featureTypes"][0]["properties"] if p["type"].startswith("gml:"))


def build(log=lambda s: None):
    from .flood_eo import _ee
    from .foodsec_ews import CENSUS_2023
    ee = _ee()
    grid, meta = _districts()
    nd = len(meta) + 1
    log(f"{len(meta)} districts on a {NX} x {NY} grid")
    jrc = ee.ImageCollection("JRC/CEMS_GLOFAS/FloodHazard/v2_1")
    zones = {}
    for rp in (10, 100, 500):
        band = f"RP{rp}_depth"
        img = jrc.select([band, "permanent_water_class", "spurious_depth_category"]).mosaic()
        # flooded by at least 10 cm, excluding permanent water
        z = img.select(band).gte(0.1).And(img.select("permanent_water_class").unmask(0).eq(0)).And(img.select("spurious_depth_category").unmask(0).eq(0))
        zones[f"rp{rp}"] = _ee_grid(ee, z, np.uint8).astype(bool)
        log(f"1-in-{rp}-year flood zone")
    pop = _ee_grid(ee, ee.Image("JRC/GHSL/P2023A/GHS_POP/2025").select("population_count").reduceResolution(ee.Reducer.sum().unweighted(), True, 64)
                   .reproject("EPSG:4326", [RES, 0, W, 0, -RES, N]).toFloat(), np.float32)
    lc = ee.ImageCollection("MODIS/061/MCD12Q1").sort("system:time_start", False).first().select("LC_Type1")
    crop = _ee_grid(ee, lc.eq(12).Or(lc.eq(14)), np.uint8).astype(bool)
    log("people and cropland")
    seen = {}
    for y, layers in OBSERVED.items():
        try:
            seen[y] = _wms_mask(layers)
            log(f"observed flood {y}: {int(seen[y].sum())} cells")
        except Exception as e:
            log(f"observed flood {y}: {type(e).__name__}")

    lat = N - (np.arange(NY) + 0.5) * RES
    km2 = ((RES * 111.32) ** 2 * np.cos(np.radians(lat)))[:, None].astype(np.float32) * np.ones((1, NX), np.float32)
    flat = grid.ravel()
    total = lambda w: np.bincount(flat, weights=w.ravel().astype(np.float64), minlength=nd)[1:]
    pop_d = total(pop)
    # census scaling by province
    prov = {}
    for i, m in enumerate(meta):
        prov.setdefault(m["province"], []).append(i)
    scale = np.ones(len(meta))
    for p, idx in prov.items():
        if p in CENSUS_2023 and pop_d[idx].sum():
            scale[idx] = CENSUS_2023[p] / pop_d[idx].sum()
    rows = [{"name": m["name"], "province": m["province"], "people": int(round(pop_d[i] * scale[i]))} for i, m in enumerate(meta)]
    area, crop_d = total(km2), total(km2 * crop)
    for i, r in enumerate(rows):
        r["km2"], r["crop_km2"] = round(area[i]), round(crop_d[i])
    for k, z in zones.items():
        a, b, c = total(pop * z), total(km2 * z), total(km2 * (z & crop))
        for i, r in enumerate(rows):
            r[k] = {"people": int(round(a[i] * scale[i])), "km2": round(b[i]), "crop_km2": round(c[i])}
    times = np.zeros((NY, NX), np.uint8)
    for y, z in seen.items():
        times += z
        a, b, c = total(pop * z), total(km2 * z), total(km2 * (z & crop))
        for i, r in enumerate(rows):
            r.setdefault("seen", {})[y] = {"people": int(round(a[i] * scale[i])), "km2": round(b[i]), "crop_km2": round(c[i])}
    often, once = times >= 3, times >= 1
    for key, z in (("often", often), ("once", once)):
        a, b, c = total(pop * z), total(km2 * z), total(km2 * (z & crop))
        for i, r in enumerate(rows):
            r[key] = {"people": int(round(a[i] * scale[i])), "km2": round(b[i]), "crop_km2": round(c[i])}
    for kind, (layer, _) in POINTS.items():
        try:
            x, yv = _points(layer)
        except Exception as e:
            log(f"{kind}: {type(e).__name__}")
            continue
        col, row = ((x - W) / RES).astype(int), ((N - yv) / RES).astype(int)
        ok = (col >= 0) & (col < NX) & (row >= 0) & (row < NY)
        col, row = col[ok], row[ok]
        d = grid[row, col]
        cnt = lambda sel: np.bincount(d[sel], minlength=nd)[1:]
        al, on, of = cnt(np.ones(d.size, bool)), cnt(once[row, col]), cnt(often[row, col])
        for i, r in enumerate(rows):
            r.setdefault("places", {})[kind] = [int(al[i]), int(on[i]), int(of[i])]         # all, seen flooded once, 3+ years
        log(f"{kind}: {d.size} points")
    rows = [r for r in rows if r["province"] != OUTSIDE]
    doc = {"built": date.today().isoformat(), "observed_years": sorted(seen), "grid_deg": RES, "districts": rows,
           "note": "Potential exposure, not damage. Modelled zones assume no embankments."}
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, _path())
    return {"districts": len(rows), "people_once": sum(r["once"]["people"] for r in rows), "people_rp100": sum(r["rp100"]["people"] for r in rows), "years": sorted(seen)}
