# project/ncop_internal/landslide_report_export.py
# ---------------------------------------------------------------------------
# Builds a self-contained, one-page Word (.docx) briefing report for one
# finished landslide-model job — mirrors flood_report_export.py's own
# layout/structure exactly (dark banner header, map snapshot + legend, a
# compact scenario table, a dense KPI table, a short prioritized
# mitigation list), but with landslide-specific CONTENT.
#
# Every pure, hazard-agnostic docx-building helper below is imported
# DIRECTLY from flood_report_export.py, not duplicated — _set_cell_
# shading/_set_cell_text/_fmt_num/_fmt/_decode_map_image/_configure_page/
# _no_borders have zero flood-specific logic (confirmed by direct read),
# so reusing them is the same "reuse unmodified" discipline this whole
# integration follows. Only the CONTENT-generating functions (banner
# text, KPI values, mitigation measures, scenario rows, the main
# orchestrator) are landslide-specific, written fresh here because
# landslide's own result shape (susceptibility/infinite_slope/rockfall/
# avalanche/exposure/validation) is genuinely different from flood's.
#
# Reads the job dict's own already-computed "result" directly (the SAME
# in-memory payload LandslideModelStatusView/the export view already
# read) — exports exactly what the user already saw, nothing recomputed.
# ---------------------------------------------------------------------------

import logging
from datetime import datetime
from io import BytesIO

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor

from . import landslide_model
from .flood_report_export import (
    _configure_page, _decode_map_image, _fmt, _fmt_num,
    _no_borders, _set_cell_shading, _set_cell_text,
)

logger = logging.getLogger(__name__)

# Same swatch convention as flood_report_export.py's own
# _AHP_ZONE_COLORS_HEX — landslide_model.py's zone GeoJSON features carry
# these exact hex values already (flood_model._AHP_ZONE_COLORS, reused
# unmodified — see build_landslide_zone_geometries's own docstring), not
# reinvented here.
_ZONE_COLORS_HEX = {"low": "FFC300", "medium": "FF5733", "high": "C70039"}
_ZONE_ORDER = ["low", "medium", "high"]
_ZONE_LABELS = {"low": "LOW", "medium": "MED", "high": "HIGH"}

_BANNER_BG = "1B2838"
_HEADER_ROW_BG = "2C3E50"
_ALT_ROW_BG = "EDEFF2"
_WHITE = "FFFFFF"

_MODE_LABELS = {
    "susceptibility": "Static susceptibility + infinite-slope + rockfall + avalanche + debris-flow screening",
    "trigger": "Rainfall-triggered dynamic check",
}

# Fewer, landslide-relevant KPI columns than flood's own 8 — matches what
# build_landslide_exposure_report actually computes for the HIGH zone
# (see that function's own docstring: exposure is reported for the
# single most severe zone, not a per-zone breakdown), not a fabricated
# multi-zone table landslide's own exposure report doesn't produce.
_KPI_COLUMNS = [
    ("area_km2", "High-zone\nArea (km²)"),
    ("population", "Pop."),
    ("children", "Child\n<5"),
    ("elderly", "Eld.\n65+"),
    ("buildings", "Bldgs"),
    ("roads_km", "Roads\n(km)"),
]


def _kpi_values(exposure):
    """Flattens landslide's own exposure-report shape (landslide_model.
    build_landslide_exposure_report — "landslide_high_zone_km2" instead
    of flood's "flood_zone_km2", otherwise the same field names) into
    the compact numeric set the KPI table renders."""
    exposure = exposure or {}
    buildings = exposure.get("buildings") or {}
    population = exposure.get("population") or {}
    roads = exposure.get("roads") or {}
    return {
        "area_km2": exposure.get("landslide_high_zone_km2"),
        "population": population.get("total"),
        "children": population.get("under5"),
        "elderly": population.get("elderly"),
        "buildings": buildings.get("buildings_in_flood_zone"),  # field name inherited unchanged from the shared exposure core
        "roads_km": roads.get("length_in_flood_zone_km"),  # same inheritance
    }


def _mitigation_measures(result, max_items=5):
    """Real, standard DRR/NDMA-style guidance, prioritized by what THIS
    run's own computed numbers show is actually at stake — landslide-
    specific (not flood's own bridge/hospital-continuity framing),
    incorporating the rockfall/avalanche typology findings (§3.8) a
    flood report has no equivalent of. No fabricated citations."""
    exposure = (result.get("exposure") or {})
    population = exposure.get("population") or {}
    buildings = exposure.get("buildings") or {}
    roads = exposure.get("roads") or {}
    rockfall = result.get("rockfall") or {}
    avalanche = result.get("avalanche") or {}

    measures = []
    pop_total = population.get("total")
    if pop_total:
        measures.append(f"~{pop_total:,.0f} people in the high-susceptibility zone — pre-identify safe evacuation routes clear of the mapped zone.")
    buildings_n = buildings.get("buildings_in_flood_zone")
    if buildings_n:
        measures.append(f"~{buildings_n:,.0f} buildings in the high-susceptibility zone — structural/slope-stability inspection priority.")
    roads_km = roads.get("length_in_flood_zone_km")
    if roads_km:
        measures.append(f"~{roads_km:,.1f} km road network in the high-susceptibility zone — monitor for cracking/settlement, especially after heavy rain.")
    rockfall_km2 = rockfall.get("susceptible_km2")
    if rockfall_km2:
        measures.append(
            f"~{rockfall_km2:,.1f} km² independently flagged rockfall-susceptible (steep rock face, "
            f"not soil slide) — a mechanically distinct hazard needing rock-cut/scaling inspection, not slope drainage measures."
        )
    debris_summary = (result.get("debris_flow") or {}).get("summary") or {}
    debris_km2 = (debris_summary.get("debris_flow") or {}).get("area_km2")
    if debris_km2:
        measures.append(
            f"~{debris_km2:,.1f} km² drains into channels morphometrically capable of debris flows "
            f"(Melton ratio > 0.6, short watersheds) — keep fan apexes/culverts clear and avoid new construction on active fans."
        )
    gate_fraction = avalanche.get("gate_applied_fraction")
    if gate_fraction and gate_fraction > 0.01:
        measures.append(
            f"~{gate_fraction*100:.1f}% of this catchment falls in seasonally-snow-relevant, avalanche-prone terrain "
            f"(elevation/slope gated, §3.8) — winter-specific monitoring, separate from the rainfall-triggered check."
        )
    if not measures:
        measures.append("No population/infrastructure exposure data computed for this result.")
    measures = measures[:max_items]
    measures.append(
        "Baseline: file this zonation with local DM focal points; re-run ahead of forecasted heavy rainfall; "
        "terrain-based hazard indication only — not a certified geotechnical assessment or real-time warning substitute."
    )
    return measures


def _scenario_rows(job, result, mode):
    if mode == "trigger":
        id_threshold = result.get("id_threshold") or {}
        rainfall = result.get("rainfall") or {}
        return [
            ("Rainfall source", _fmt(result.get("source"))),
            ("Rainfall / duration", f"{_fmt(rainfall.get('rainfall_mm'), ' mm')} / {_fmt(rainfall.get('duration_hr'), ' hr')}"),
            ("Intensity vs. ID threshold", f"{_fmt(id_threshold.get('intensity_mm_hr'), ' mm/hr')} vs. {_fmt(id_threshold.get('threshold_mm_hr'), ' mm/hr')}"),
            ("Static class", _fmt((result.get("static_susceptibility") or {}).get("dominant_class"))),
            ("ADVISORY", _fmt(result.get("advisory"))),
        ]

    susceptibility = result.get("susceptibility") or {}
    weights = susceptibility.get("weights") or {}
    top_weights = sorted(weights.items(), key=lambda kv: -(kv[1] or 0))[:3]
    infinite_slope = result.get("infinite_slope") or {}
    rockfall = result.get("rockfall") or {}
    avalanche = result.get("avalanche") or {}
    debris_summary = (result.get("debris_flow") or {}).get("summary") or {}
    calibrated = susceptibility.get("method") == "calibrated"
    return [
        ("Terrain class", _fmt(susceptibility.get("terrain_class"))),
        ("Susceptibility method", "Calibrated (data-driven, §L7)" if calibrated else "Literature AHP"),
        ("Top calibrated factors" if calibrated else "Top AHP factors",
         ", ".join(f"{k} ({v})" for k, v in top_weights) or "—"),
        ("Infinite-slope soil depth", _fmt(infinite_slope.get("soil_depth_m"), " m")),
        ("Rockfall-flagged area", _fmt(rockfall.get("susceptible_km2"), " km²")),
        ("Debris-flow-capable area", _fmt((debris_summary.get("debris_flow") or {}).get("area_km2"), " km²")),
        ("Avalanche-gated fraction", _fmt(
            round(avalanche.get("gate_applied_fraction") * 100, 2) if avalanche.get("gate_applied_fraction") is not None else None,
            "%",
        )),
    ]


def _accuracy_rows(result, mode):
    """Real, server-computed validation numbers only (L3's COOLR-based
    AUC, when include_validation was requested and COOLR itself was
    reachable) — never a fabricated confidence figure. See landslide_
    model.validate_landslide_susceptibility's own docstring: a "no_
    ground_truth" interpretation is a real, honest outcome, shown as-is,
    not hidden."""
    rows = []
    validation = result.get("validation")
    if isinstance(validation, dict):
        ahp_auc = (validation.get("ahp") or {})
        fs_auc = (validation.get("infinite_slope") or {})
        rows.append(("AHP AUC (COOLR)", f"{_fmt(ahp_auc.get('auc_mean'))} ({_fmt(ahp_auc.get('interpretation'))})"))
        rows.append(("Infinite-slope AUC (COOLR)", f"{_fmt(fs_auc.get('auc_mean'))} ({_fmt(fs_auc.get('interpretation'))})"))
        rows.append(("COOLR events used", _fmt(validation.get("n_coolr_events"))))
    return rows


def _add_banner(doc, catchment_label, mode, generated_at):
    table = doc.add_table(rows=2, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    for row in table.rows:
        _set_cell_shading(row.cells[0], _BANNER_BG)
    _set_cell_text(
        table.rows[0].cells[0], "LANDSLIDE EARLY WARNING — BRIEFING REPORT",
        bold=True, color_hex=_WHITE, size=14,
    )
    _set_cell_text(
        table.rows[1].cells[0],
        f"{catchment_label}   |   {_MODE_LABELS.get(mode, mode or 'Unknown')}   |   Generated {generated_at}",
        bold=False, color_hex=_WHITE, size=9,
    )
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def _add_map_and_scenario_row(doc, image_bytes, legend_items, scenario_rows, accuracy_rows):
    outer = doc.add_table(rows=1, cols=2)
    outer.autofit = False
    _no_borders(outer)
    left, right = outer.rows[0].cells
    left.width = Inches(2.9)
    right.width = Inches(4.2)

    if image_bytes:
        p = left.paragraphs[0]
        run = p.add_run()
        try:
            run.add_picture(BytesIO(image_bytes), width=Inches(2.75))
        except Exception:
            logger.warning("landslide_report_export: could not embed map snapshot image", exc_info=True)
        legend_p = left.add_paragraph()
        legend_p.paragraph_format.space_before = Pt(2)
        for label, hex_color in legend_items:
            swatch_run = legend_p.add_run("  ■ ")
            swatch_run.font.color.rgb = RGBColor.from_string(hex_color)
            swatch_run.font.size = Pt(8)
            label_run = legend_p.add_run(f"{label}   ")
            label_run.font.size = Pt(7.5)
    else:
        p = left.paragraphs[0]
        run = p.add_run("(No map snapshot captured for this export.)")
        run.italic = True
        run.font.size = Pt(8)

    combined_rows = [("SCENARIO", None)] + scenario_rows + [("ACCURACY & VALIDATION", None)] + (
        accuracy_rows or [("Not requested for this run (include_validation=false)", "")]
    )
    inner = right.add_table(rows=0, cols=2)
    inner.autofit = True
    for i, (label, value) in enumerate(combined_rows):
        cells = inner.add_row().cells
        if value is None:
            _set_cell_shading(cells[0], _HEADER_ROW_BG)
            _set_cell_shading(cells[1], _HEADER_ROW_BG)
            _set_cell_text(cells[0], label, bold=True, color_hex=_WHITE, size=8)
            cells[1].text = ""
        else:
            if i % 2 == 0:
                _set_cell_shading(cells[0], _ALT_ROW_BG)
                _set_cell_shading(cells[1], _ALT_ROW_BG)
            _set_cell_text(cells[0], label, bold=True, size=8)
            _set_cell_text(cells[1], "—" if value in (None, "") else str(value), size=8)
    right.paragraphs[0].text = ""


def _add_kpi_table(doc, zone_rows):
    has_zone_col = any(z is not None for z, _, _ in zone_rows)
    ncols = len(_KPI_COLUMNS) + (1 if has_zone_col else 0)
    table = doc.add_table(rows=1, cols=ncols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER

    header_cells = table.rows[0].cells
    col_offset = 0
    if has_zone_col:
        _set_cell_shading(header_cells[0], _HEADER_ROW_BG)
        _set_cell_text(header_cells[0], "ZONE", bold=True, color_hex=_WHITE, size=7.5, align=WD_ALIGN_PARAGRAPH.CENTER)
        col_offset = 1
    for i, (_, col_label) in enumerate(_KPI_COLUMNS):
        cell = header_cells[i + col_offset]
        _set_cell_shading(cell, _HEADER_ROW_BG)
        _set_cell_text(cell, col_label, bold=True, color_hex=_WHITE, size=7.5, align=WD_ALIGN_PARAGRAPH.CENTER)

    for row_i, (zone_key, zone_color, kpis) in enumerate(zone_rows):
        cells = table.add_row().cells
        row_bg = _ALT_ROW_BG if row_i % 2 == 1 else None
        if has_zone_col:
            _set_cell_shading(cells[0], zone_color or row_bg or _WHITE)
            _set_cell_text(
                cells[0], _ZONE_LABELS.get(zone_key, zone_key or "—"),
                bold=True, size=8, align=WD_ALIGN_PARAGRAPH.CENTER,
                color_hex=_WHITE if zone_color else None,
            )
        for i, (key, _) in enumerate(_KPI_COLUMNS):
            cell = cells[i + col_offset]
            if row_bg and not (has_zone_col and i == 0):
                _set_cell_shading(cell, row_bg)
            _set_cell_text(cell, _fmt_num(kpis.get(key)), size=8, align=WD_ALIGN_PARAGRAPH.CENTER)
    return table


def _add_mitigation_list(doc, measures):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(4)
    run = p.add_run("PRIORITY ACTIONS")
    run.bold = True
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor.from_string(_BANNER_BG)
    for i, measure in enumerate(measures, start=1):
        mp = doc.add_paragraph()
        mp.paragraph_format.space_after = Pt(1)
        mp.paragraph_format.left_indent = Pt(10)
        num_run = mp.add_run(f"{i}. ")
        num_run.bold = True
        num_run.font.size = Pt(8)
        text_run = mp.add_run(measure)
        text_run.font.size = Pt(8)


def build_landslide_model_docx_report(job, map_image_data_url=None):
    """Builds the full one-page briefing report for one finished
    landslide job (job["status"] == "done" — the caller,
    LandslideModelReportExportView, is responsible for that check).
    Returns raw .docx bytes.

    Same page-fit engineering note as flood_report_export.build_flood_
    model_docx_report's own docstring: narrow margins/small fonts are
    ENGINEERED for a one-page fit at this content volume, not measured
    against a real Word layout engine (none available in this
    environment)."""
    result = job.get("result") or {}
    mode = job.get("mode")
    catchment_key = job.get("catchment")
    cfg = landslide_model.PILOT_CATCHMENTS.get(catchment_key) or landslide_model.flood_model.PILOT_CATCHMENTS.get(catchment_key, {})
    catchment_label = cfg.get("label", catchment_key)
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")

    doc = Document()
    _configure_page(doc)
    _add_banner(doc, catchment_label, mode, generated_at)

    image_bytes = _decode_map_image(map_image_data_url)

    if mode == "trigger":
        legend_items = [("Rainfall-triggered advisory", "1E64C8")]
        _add_map_and_scenario_row(doc, image_bytes, legend_items, _scenario_rows(job, result, mode), [])
        doc_bytes = BytesIO()
        doc.save(doc_bytes)
        return doc_bytes.getvalue()

    legend_items = [(_ZONE_LABELS[z] + " susceptibility", _ZONE_COLORS_HEX[z]) for z in _ZONE_ORDER]
    _add_map_and_scenario_row(
        doc, image_bytes, legend_items,
        _scenario_rows(job, result, mode), _accuracy_rows(result, mode),
    )

    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    kpi_heading = doc.add_paragraph()
    kpi_run = kpi_heading.add_run("EXPOSURE — HIGH-SUSCEPTIBILITY ZONE")
    kpi_run.bold = True
    kpi_run.font.size = Pt(9)
    kpi_run.font.color.rgb = RGBColor.from_string(_BANNER_BG)

    exposure = result.get("exposure")
    if exposure:
        _add_kpi_table(doc, [("high", _ZONE_COLORS_HEX["high"], _kpi_values(exposure))])
    else:
        doc.add_paragraph("No exposure report computed for this run.")

    _add_mitigation_list(doc, _mitigation_measures(result))

    footer_p = doc.add_paragraph()
    footer_p.paragraph_format.space_before = Pt(6)
    footer_run = footer_p.add_run(
        "Terrain/hazard-model output for disaster-management planning use — not a certified geotechnical "
        "assessment. Rockfall/avalanche figures are independent screening layers (§3.8), not blended into "
        "the AHP susceptibility score above. Full attribute detail available via the separate GeoJSON export "
        "of this same result."
    )
    footer_run.italic = True
    footer_run.font.size = Pt(6.5)
    footer_run.font.color.rgb = RGBColor.from_string("666666")

    doc_bytes = BytesIO()
    doc.save(doc_bytes)
    return doc_bytes.getvalue()
