# project/ncop_internal/layer_catalog_parser.py
# ---------------------------------------------------------------------------
# Statically extracts the sidebar layer catalog (`ncop_menu_items`, the
# single source of truth for every layer in the app, defined in
# frontend/src/modules/map-layers.js) as plain Python dicts, for the NCOP
# Assistant's ingestion pipeline (management/commands/ingest_chat_knowledge.py)
# to embed.
#
# Why this reads the JS as TEXT instead of executing it: map-layers.js is
# written for the browser (imports mapbox-gl, uses Vite's import.meta.glob
# for thumbnails) — and, more importantly, some of its generator functions
# run a REAL SYNCHRONOUS XMLHttpRequest as a side effect of the module
# merely being imported (confirmed live: importing it under Node/Vite's SSR
# module runner throws "XMLHttpRequest is not defined" from
# getLatestMeteoblueTimeSync, called at module top level). There is no safe
# way to "just run" this file outside the real browser app, so this module
# instead does a small hand-rolled, string-and-brace-aware scan of the
# source text — never evaluates any JS — to pull out exactly the fields the
# ingestion pipeline needs (label/information/geometry/type + the
# category/subcategory/itemType/itemKey path each entry lives at, mirroring
# frontend/src/modules/sourcelayer-control.js's own findLayerConfig()
# traversal), so Phase 2's navigation feature can key off the same
# itemKey/categoryKey/subcategoryKey/itemType shape without re-deriving it.
#
# This is a best-effort structural scan of first-party, trusted source
# (never adversarial input) — not a general JS parser. It is expected to be
# re-run whenever map-layers.js changes; if the object-literal shape it
# scans for ever changes significantly, re-validate against a few known
# entries (see the command's own summary output).
# ---------------------------------------------------------------------------

import re

_TYPE_SLOT_KEYS = {"toggle", "temporal", "button", "static"}

_LABEL_RE = re.compile(r'\blabel\s*:\s*"((?:[^"\\]|\\.)*)"')
_TYPE_RE = re.compile(r'\btype\s*:\s*"((?:[^"\\]|\\.)*)"')
_GEOMETRY_RE = re.compile(r'\bgeometry\s*:\s*"((?:[^"\\]|\\.)*)"')
_INFORMATION_RE = re.compile(r'\binformation\s*:\s*"((?:[^"\\]|\\.)*)"')
_DYNAMIC_LEGEND_RE = re.compile(r"\bdynamicLegend\s*:\s*\{")


def _unescape(s):
    return s.replace('\\"', '"').replace("\\n", " ").replace("\\\\", "\\") if s else s


def _find_object_start(source, marker):
    """Returns the index of the `{` that opens `export const <marker> = {`."""
    m = re.search(rf"\b{re.escape(marker)}\s*=\s*\{{", source)
    if not m:
        raise ValueError(f"Could not find `{marker} = {{` in source")
    return m.end() - 1  # index of the opening brace itself


def _tokenize(source, start):
    """String-and-brace-aware scan from `start` (index of an opening `{` or
    `[`). Yields (event, key, index) where event is "enter"/"exit" for every
    `{`/`}` and `[`/`]` encountered outside of a string literal or comment.
    `key` (enter events only) is the identifier/quoted-string property name
    immediately preceding a `{`/`[` — None for array elements / anonymous
    objects.
    """
    i = start
    n = len(source)
    in_str = None       # None, or the quote char currently inside
    in_line_comment = False
    in_block_comment = False

    def _preceding_key(idx):
        # Walk backwards from `idx` (the opening brace/bracket) over
        # whitespace, then over ": " / ":", then capture an identifier or a
        # quoted string.
        j = idx - 1
        while j >= 0 and source[j] in " \t\r\n":
            j -= 1
        if j < 0 or source[j] != ":":
            return None
        j -= 1
        while j >= 0 and source[j] in " \t\r\n":
            j -= 1
        end = j + 1
        if j >= 0 and source[j] in ('"', "'"):
            quote = source[j]
            k = j - 1
            while k >= 0 and source[k] != quote:
                k -= 1
            return source[k + 1:j]
        while j >= 0 and (source[j].isalnum() or source[j] in "_$"):
            j -= 1
        start_ident = j + 1
        ident = source[start_ident:end]
        return ident or None

    while i < n:
        ch = source[i]

        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == "*" and i + 1 < n and source[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if in_str is not None:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
            i += 1
            continue

        if ch == "/" and i + 1 < n and source[i + 1] == "/":
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and i + 1 < n and source[i + 1] == "*":
            in_block_comment = True
            i += 2
            continue
        if ch in ('"', "'", "`"):
            in_str = ch
            i += 1
            continue

        if ch in "{[":
            yield ("enter", _preceding_key(i), i)
        elif ch in "}]":
            yield ("exit", None, i)

        i += 1


def parse_layer_catalog(js_source):
    """Returns a list of dicts, one per leaf layer entry in `ncop_menu_items`:
    {itemKey, categoryKey, subcategoryKey, itemType, label, information,
     geometry, type, hasDynamicLegend}.
    """
    root_start = _find_object_start(js_source, "ncop_menu_items")

    records = []
    # stack entries: {"key": str|None, "open": int}. The tokenizer's very
    # first "enter" event is ncop_menu_items's OWN opening brace (key=None,
    # since `export const x = {` precedes it with `=`, not `:`, so
    # _preceding_key finds nothing) — so stack[0] is that root frame,
    # stack[1] is always a categoryKey object, stack[2] always a
    # subcategoryKey object, regardless of how many further wrapper levels
    # (type-slot, dropdown array/options, nested/subsections groups) sit
    # below that before reaching an actual item.
    stack = []

    for event, key, idx in _tokenize(js_source, root_start):
        if event == "enter":
            stack.append({"key": key, "open": idx})
        else:  # exit
            if not stack:
                continue
            frame = stack.pop()

            # An item is any object whose own key sits directly under a
            # type-slot key (toggle/temporal/button/static) or "options"
            # (dropdown), per findLayerConfig's own traversal — regardless
            # of how deep that is under category/subcategory.
            if frame["key"] and len(stack) >= 3:
                parent_key = stack[-1]["key"]
                item_type = None
                if parent_key in _TYPE_SLOT_KEYS:
                    item_type = parent_key
                elif parent_key == "options":
                    item_type = "dropdown"
                if item_type:
                    category_key = stack[1]["key"]
                    subcategory_key = stack[2]["key"]
                    if category_key and subcategory_key:
                        item_text = js_source[frame["open"] + 1: idx]
                        records.append(_extract_item(
                            item_key=frame["key"],
                            category_key=category_key,
                            subcategory_key=subcategory_key,
                            item_type=item_type,
                            item_text=item_text,
                        ))

    return records


def _prefix_before_first_nested_bracket(item_text):
    """The leading slice of an item's own body up to (not including) its
    first nested `{`/`[` — label/type/geometry consistently appear in this
    leading run in every observed entry shape, before any nested source/
    layers/dynamicLegend/dropdown-option sub-structure begins. Restricting
    the label/type/geometry search to this slice avoids accidentally
    matching a same-named field inside a nested sub-object (e.g. a vector
    source's own `"type": "vector"`, or a Mapbox layer's `"type": "fill"`)."""
    for ch in ("{", "["):
        pos = item_text.find(ch)
        if pos != -1:
            item_text = item_text[:pos]
    return item_text


def _extract_item(item_key, category_key, subcategory_key, item_type, item_text):
    prefix = _prefix_before_first_nested_bracket(item_text)
    label_m = _LABEL_RE.search(prefix)
    type_m = _TYPE_RE.search(prefix)
    geometry_m = _GEOMETRY_RE.search(prefix)
    # information can legitimately appear AFTER a nested block (e.g. after
    # `layers: [...]` closes) — searched across the item's full body.
    info_m = _INFORMATION_RE.search(item_text)
    return {
        "itemKey": item_key,
        "categoryKey": category_key,
        "subcategoryKey": subcategory_key,
        "itemType": item_type,
        "label": _unescape(label_m.group(1)) if label_m else "",
        "information": _unescape(info_m.group(1)) if info_m else "",
        "geometry": _unescape(geometry_m.group(1)) if geometry_m else None,
        "type": _unescape(type_m.group(1)) if type_m else None,
        "hasDynamicLegend": bool(_DYNAMIC_LEGEND_RE.search(item_text)),
    }
