# project/ncop_internal/chatbot.py
# ---------------------------------------------------------------------------
# NCOP Assistant — Phase 1 RAG Q&A endpoint. A new, self-contained module
# rather than an addition to views.py (already 8,000+ lines and documented
# in CONTEXT.md as something to read by line-range, never in full) — this
# subsystem shares no private helpers with that file, so there's no benefit
# to living inside it.
#
# See chat_engine.py for the shared Chroma/embedding/Groq singletons this
# view calls into, and management/commands/ingest_chat_knowledge.py for how
# the knowledge base gets built.
# ---------------------------------------------------------------------------

import json

from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework.views import APIView
from rest_framework.throttling import AnonRateThrottle
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from . import chat_engine
from .assistant_tools import ALL_TOOLS, DATA_TOOL_NAMES, TOOL_EXECUTORS

MAX_QUESTION_CHARS = 2000
MAX_HISTORY_TURNS = 6  # 3 user/assistant exchanges — bounds both Groq token cost and session size
# 8, not 5 — a query like "precipitation layers" can genuinely match several
# DISTINCT layers scattered across different subcategories (Meteoblue
# Forecast, PMD Predictions, ...), not one clean group; the model needs
# enough retrieved candidates in view to actually notice that ambiguity
# (see the DISAMBIGUATION system-prompt rule) rather than only ever seeing
# whichever single one happened to embed closest.
TOP_K = 8
SESSION_HISTORY_KEY = "ncop_chat_history"

SYSTEM_PROMPT_HEADER = (
    "You are the NCOP Assistant, embedded in NCOP (National Contingency/"
    "Common Operating Picture for Pakistan), a Django + Mapbox disaster-"
    "monitoring dashboard covering floods, fires, landslides, cyclones, "
    "seismic risk, drought, heatwaves, air quality, crop conditions, and "
    "weather forecasting.\n\n"
    "GROUNDING: base every FACTUAL claim about NCOP on the CONTEXT below "
    "(retrieved from NCOP's own documentation, code-structure summary, "
    "sidebar layer catalog, and map-rail/control catalog) — never invent "
    "details the context doesn't support. Conversation history is a "
    "separate, legitimate source for resolving what the user is referring "
    "to (\"it\", \"that layer\", a follow-up) even when this turn's CONTEXT "
    "wasn't re-retrieved for that exact subject. If CONTEXT genuinely "
    "doesn't cover the question, call search_knowledge_base with a "
    "differently-worded query before giving up — only say you don't know "
    "after that still comes back empty.\n\n"
    "LIVE MAP STATE: a block below CONTEXT reports which layer(s) are "
    "ACTUALLY active on the map right now — real, live ground truth from "
    "the running app, not a retrieval guess. This is what backs any "
    "question about what's currently displayed/shown/on the map, what the "
    "map represents right now, what data source is currently visible, or "
    "what a temporal layer's current date/step is. Never answer those from "
    "CONTEXT alone when LIVE MAP STATE has the real answer, and never "
    "describe a layer as active if LIVE MAP STATE doesn't list it — if it "
    "says no layers are active, say that plainly.\n\n"
    "FORMATTING — every reply, always: write clean Markdown — a short bold "
    "header line or two when it helps scanning, **bold** on key terms/"
    "numbers/names, bullet or numbered lists for anything with more than "
    "two items, a short table for tabular data. Use one or two relevant "
    "emoji naturally (📍 for locations, 🌧️ rain, 🌡️ temperature, ⚠️ "
    "alerts, ✅ confirmations, 🗺️ layers/maps) — sparingly, not on every "
    "line. Keep it tight: a couple of sentences or a short list, not an "
    "essay, unless the user's question genuinely needs more.\n\n"
    "LAYERS, SUBCATEGORIES, CATEGORIES, AND CONTROLS — never answer with "
    "just a pointer phrase like \"Here's X\" or \"That's the X button\" and "
    "nothing else. Every time you mention a specific layer, subcategory, "
    "category, or control, actually describe what it shows/does/contains "
    "in 1-3 sentences, grounded in its CONTEXT entry (for a subcategory or "
    "category, name a few of the actual layers inside it, pulled from "
    "CONTEXT). For a CONTROL specifically, also say what happens when it's "
    "used.\n\n"
    "DISAMBIGUATION — before calling navigate_to, check whether the user's "
    "own wording matches a REAL category_key or subcategory string that "
    "appears in CONTEXT (e.g. \"air quality\" genuinely IS the air_quality "
    "category; \"radar layers\" genuinely IS the Radar Layers subcategory). "
    "If so, that's a clean category/subcategory case — proceed normally, "
    "target_type \"category\"/\"subcategory\". If the user's wording is "
    "instead a general topic/keyword (\"precipitation\", \"weather "
    "stations\", \"temperature\") that ISN'T itself a real category or "
    "subcategory name, look at how many DIFFERENT layers in CONTEXT that "
    "topic could mean. One obvious match → proceed normally, target_type "
    "\"layer\". Several different, genuinely distinct layers (different "
    "item_keys, different purposes/timeframes — e.g. weekly vs. hourly vs. "
    "radar-rate precipitation, or two different weather-station point "
    "layers) → this is the ambiguous case: do NOT call navigate_to and do "
    "NOT pick a category as a shortcut around picking one layer — instead "
    "reply with a short Markdown table (columns: Layer, What it shows, "
    "Category/Subcategory) listing every real candidate from CONTEXT, then "
    "ask which one they mean. Once they name one in a follow-up, that's a "
    "normal single-layer request. Never fabricate a candidate not in "
    "CONTEXT, and never present one option as the only one when CONTEXT "
    "shows several.\n\n"
    "NAVIGATION vs. ACTIONS — the app itself auto-opens the sidebar and "
    "highlights whatever navigate_to points at the instant you call it, "
    "with NO click or confirmation from the user — so never say things "
    "like \"would you like me to open it\" for a plain navigate_to. The "
    "app ONLY asks the user to explicitly confirm two things, and only "
    "those two: turning a LAYER on, and opening a CONTROL's panel — never "
    "phrase those as already done, since they genuinely wait on the user's "
    "click.\n\n"
    "TOOLS — you have navigate_to plus live-data tools (currently "
    "get_rainfall_report, get_heatwave_monitoring, get_pmd_daily_forecast, "
    "get_ffd_bulletins, get_nwfc_weekly_outlook, get_weather_forecast — all "
    "backed by the same live PMD/NWFC/FFD/Open-Meteo feeds the dashboard's "
    "own Weather Report panel and heatwave charts already use). "
    "navigate_to: call it whenever the user asks where something is, wants "
    "to find/open/see a specific layer, a whole CATEGORY of layers, or a "
    "control, or asks you to show them something. Use target_type "
    "\"category\" (not \"control\") for a group of layers (\"where are the "
    "air quality layers\") rather than routing a category question to the "
    "generic Sidebar Menu control — that control is only for genuinely "
    "generic \"how do I open the sidebar\" questions. target_id MUST be an "
    "item_key/category_key/frontend_id that literally appears in CONTEXT; "
    "never invent one, and never call it for something not present in "
    "CONTEXT (say you couldn't find it instead). ALWAYS pair it with the "
    "real description required above, never a bare pointer. Data tools: "
    "call one when the user asks about CURRENT/live conditions, an "
    "upcoming forecast, or published PMD/FFD/NWFC material rather than "
    "what a layer generally shows — answer using ONLY the numbers/text a "
    "tool actually returns, never invented ones; if a tool returns a "
    "`pdf_url`/`url` field, share that link so the user can open the "
    "source document itself; if a tool errors, say that data source is "
    "temporarily unavailable rather than guessing. When a tool resolves a "
    "SPECIFIC city, the app automatically flies the map camera there for "
    "you — never say things like \"let me know if you'd like me to zoom "
    "in\", it already happened. Which tool: get_rainfall_report = today's/"
    "recent rainfall totals; get_heatwave_monitoring = a specific city's "
    "(pass `city`) or the country's CURRENT/live temperature/heatwave "
    "conditions only; get_weather_forecast = a specific city's (`city`, "
    "required) MULTI-DAY (up to 16 days, `days` optional, default 5) "
    "forecast — use this, not get_heatwave_monitoring, for any forward-"
    "looking \"what will the weather be like\" question; get_pmd_daily_"
    "forecast = today's provincial forecast text (pass `province` for one "
    "region); get_nwfc_weekly_outlook = the published hazard outlook for "
    "the COMING WEEK; get_ffd_bulletins = flood bulletins/advisories and "
    "river/barrage flood-level warnings from the Flood Forecasting "
    "Division."
)

# OpenAI-style tool schema (Groq's function-calling follows the same
# convention langchain-groq already speaks) — bound onto the LLM per-request
# in _navigate_tool_response below. Purely declarative on the backend: a
# navigate_to call is never executed server-side, it's just validated and
# passed through to the frontend as a structured action (see
# frontend/src/modules/ncop-assistant.js's action-button rendering), since
# the actual DOM work (open sidebar, scroll, highlight, offer to toggle)
# can only happen client-side.
NAVIGATE_TOOL = {
    "type": "function",
    "function": {
        "name": "navigate_to",
        "description": (
            "Point the user to a specific NCOP layer, a sidebar SUBCATEGORY "
            "(e.g. \"Radar Layers\" under Weather Systems), a whole top-level "
            "CATEGORY (e.g. Air Quality, Flood), or a map-rail control that "
            "was retrieved in CONTEXT — pick the granularity that matches "
            "how the user phrased it. Every layer's own CONTEXT entry shows "
            "\"(category: ..., subcategory: ...)\" — if the user's wording "
            "names something close to a real subcategory (\"radar layers\", "
            "\"meteoblue forecast layers\"), use target_type \"subcategory\" "
            "with target_id \"<category_key>::<subcategory>\" (exact values "
            "from that layer's own CONTEXT entry, joined with ::). If it "
            "names a whole top-level category instead (\"air quality "
            "layers\"), use target_type \"category\" with just the "
            "category_key. Never invents a target — only call this with an "
            "item_key/subcategory pair/category_key/frontend_id that "
            "actually appears in CONTEXT."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target_type": {"type": "string", "enum": ["layer", "subcategory", "category", "control"]},
                "target_id": {
                    "type": "string",
                    "description": (
                        "layer: item_key. subcategory: \"<category_key>::<subcategory>\" "
                        "(exact strings from CONTEXT, joined with ::). category: category_key. "
                        "control: frontend_id. Copy every value verbatim from CONTEXT."
                    ),
                },
                "label": {"type": "string", "description": "Human-readable name to show the user."},
            },
            "required": ["target_type", "target_id", "label"],
        },
    },
}


# Agentic re-retrieval — lets the model itself decide the fixed TOP_K
# retrieval done up front didn't cover the question and pull a second,
# differently-worded search mid-turn, instead of ever answering "I don't
# know" just because the user's own wording embedded poorly. Executed
# server-side like the data tools (see EXECUTABLE_TOOL_NAMES/TOOL_EXECUTORS
# below), bounded to a single hop — see post()'s search_calls handling.
SEARCH_KB_TOOL = {
    "type": "function",
    "function": {
        "name": "search_knowledge_base",
        "description": (
            "Search NCOP's knowledge base (documentation, code-structure summary, sidebar "
            "layer catalog, and control catalog) with a DIFFERENT or more specific query than "
            "the CONTEXT already given was retrieved with. Use this when that CONTEXT doesn't "
            "actually cover the question — e.g. the user's own phrasing embedded poorly, or "
            "you need a second, differently-worded look before you can ground an answer or a "
            "navigate_to call. Only call this once per turn; a second call is ignored."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "A focused search query — rephrase/narrow the user's question, don't just repeat it verbatim.",
                },
            },
            "required": ["query"],
        },
    },
}


def _run_search_knowledge_base(args, existing_chunks):
    """Executes an agentic re-retrieval call: embeds the model's OWN
    rephrased query (never the user's raw message — that's what the fixed
    up-front retrieval already tried) and returns fresh chunks, deduped
    against what's already retrieved this turn by chunk text (same
    underlying content can otherwise reappear under a different chunk id).
    Returns (tool_result_dict, new_chunks) — new_chunks is folded into the
    turn's chunk list by the caller so CONTEXT, navigate_to's valid-target
    whitelist, and "sources" all reflect the expanded set, exactly as if it
    had been retrieved up front."""
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "No query provided."}, []
    seen_texts = {c["text"] for c in existing_chunks}
    fresh = [c for c in chat_engine.retrieve(query, top_k=TOP_K) if c["text"] not in seen_texts]
    if not fresh:
        return {"result": "No additional relevant content found for this query."}, []
    return {"result": f"Found {len(fresh)} additional relevant item(s) — now included in CONTEXT below."}, fresh


# ---- Live map state (what's actually on the map right now) ----------------
# The frontend (ncop-assistant.js's #buildMapStateSnapshot) sends this with
# every message — TOGGLE layers from sourceLayerControl.activeLayers, the
# one active TEMPORAL layer (if any) separately from
# window.getCurrentTemporalState(), matching the same ground-truth split
# gis-export-control.js already established. Untrusted request body, so
# sanitized the same way MAX_QUESTION_CHARS bounds the chat message itself.
MAX_MAP_STATE_LAYERS = 30
MAX_ITEM_KEY_CHARS = 120


def _sanitize_map_state(raw):
    if not isinstance(raw, dict):
        return {"active_layers": [], "temporal": None}
    active_layers = raw.get("active_layers")
    if not isinstance(active_layers, list):
        active_layers = []
    active_layers = [
        k[:MAX_ITEM_KEY_CHARS] for k in active_layers[:MAX_MAP_STATE_LAYERS] if isinstance(k, str) and k
    ]
    temporal = raw.get("temporal")
    if not isinstance(temporal, dict) or not isinstance(temporal.get("layer_key"), str) or not temporal.get("layer_key"):
        temporal = None
    else:
        step_index = temporal.get("step_index")
        temporal = {
            "layer_key": temporal["layer_key"][:MAX_ITEM_KEY_CHARS],
            "date": str(temporal["date"])[:100] if temporal.get("date") else None,
            "step_index": step_index if isinstance(step_index, int) else None,
        }
    return {"active_layers": active_layers, "temporal": temporal}


def _resolve_layer_descriptions(item_keys):
    """{item_key: chunk_text} via a single batched Chroma lookup — map-state
    descriptions always reuse the SAME ingested layer-catalog text used
    everywhere else (never fabricated/re-derived). Silently drops any
    item_key not found (e.g. a stale/renamed layer) rather than erroring —
    map-state grounding is always best-effort, same convention as
    chat_engine.retrieve()."""
    if not item_keys:
        return {}
    try:
        result = chat_engine.get_collection().get(
            where={"item_key": {"$in": item_keys}}, include=["documents", "metadatas"]
        )
    except Exception:
        return {}
    resolved = {}
    for doc, meta in zip(result.get("documents") or [], result.get("metadatas") or []):
        key = (meta or {}).get("item_key")
        if key and key not in resolved:  # item_key isn't globally unique — first match wins, good enough for a live snapshot
            resolved[key] = doc
    return resolved


def _build_map_state_context(map_state):
    """Renders the LIVE MAP STATE prompt block — grounded via the same
    ingested layer-catalog text as normal retrieval. This is what lets the
    assistant answer "what's on the map right now" / "what layer is this" /
    "what does the map represent" from the app's ACTUAL current state
    instead of a documentation guess."""
    active_layers, temporal = map_state["active_layers"], map_state["temporal"]
    if not active_layers and not temporal:
        return "No layers are currently active on the map — it's showing only the base map."

    all_keys = list(active_layers)
    if temporal and temporal["layer_key"] not in all_keys:
        all_keys.append(temporal["layer_key"])
    descriptions = _resolve_layer_descriptions(all_keys)

    lines = []
    if active_layers:
        lines.append(f"{len(active_layers)} layer(s) currently active on the map:")
        for key in active_layers:
            lines.append(f"- {descriptions.get(key, f'Layer: {key} (no catalog description found)')}")
    if temporal:
        desc = descriptions.get(temporal["layer_key"], f"Layer: {temporal['layer_key']}")
        step_bits = []
        if temporal.get("date"):
            step_bits.append(f"showing {temporal['date']}")
        if temporal.get("step_index") is not None:
            step_bits.append(f"step index {temporal['step_index']}")
        step_note = f" ({', '.join(step_bits)})" if step_bits else ""
        lines.append(f"Active TEMPORAL/time-series layer{step_note}: {desc}")
    return "\n".join(lines)


class NcopAssistantChatThrottle(AnonRateThrottle):
    scope = "ncop_assistant_chat"


@method_decorator(csrf_exempt, name="dispatch")
class NcopAssistantModelsView(APIView):
    """Read-only GET so the frontend's model picker never hardcodes its own
    copy of the model list — a single source of truth
    (chat_engine.SUPPORTED_MODELS) that can never drift between the two
    layers. Same open/unauthenticated posture as the chat endpoint itself
    (see NcopAssistantChatView's own comment on why authentication_classes
    must stay empty); no throttle needed — it's static config, not an LLM
    call."""
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        return JsonResponse({
            "models": [
                {"id": model_id, "label": spec["label"], "provider": spec["provider"], "description": spec["description"]}
                for model_id, spec in chat_engine.SUPPORTED_MODELS.items()
            ],
            "default": chat_engine.DEFAULT_MODEL,
        })


def _category_label(category_key):
    """Best-effort human label for a chat reply — the frontend resolves
    and displays the REAL rendered accordion title once it actually
    navigates (see sidebar-menu.js's navigateToCategory), so this only
    needs to read reasonably in the meantime. Categories that are already
    human-readable in ncop_menu_items (quoted keys like "ocean/coastal",
    "Disaster Early Warning (DEW)") pass through mostly as-is; snake_case
    keys (air_quality, agriculture_monitoring) get title-cased."""
    return category_key.replace("_", " ").replace("/", " / ").title() if "_" in category_key else category_key


def _valid_navigate_targets(chunks):
    """{(target_type, target_id): label} for every layer/control chunk
    actually retrieved this turn — the whitelist navigate_to calls are
    checked against, so the model can only point at something it was
    just shown, never an invented id. Every layer chunk's own category AND
    category::subcategory pair also become valid targets (deduped via dict
    keys) — a question like "where are the air quality layers" naturally
    retrieves several layer_catalog chunks that ALL share
    category_key="air_quality" (or, for "radar layers", all share
    subcategory "Radar Layers" under category "weather"), which is enough
    signal that grouping was genuinely surfaced this turn, not invented."""
    targets = {}
    for chunk in chunks:
        meta = chunk["metadata"]
        if meta.get("source_type") == "layer_catalog" and meta.get("item_key"):
            targets[("layer", meta["item_key"])] = None
            if meta.get("category_key"):
                targets[("category", meta["category_key"])] = _category_label(meta["category_key"])
            if meta.get("category_key") and meta.get("subcategory_key"):
                sub_id = f"{meta['category_key']}::{meta['subcategory_key']}"
                targets[("subcategory", sub_id)] = meta["subcategory_key"]
        elif meta.get("source_type") == "control" and meta.get("frontend_id"):
            targets[("control", meta["frontend_id"])] = None
    return targets


def _extract_navigate_actions(response, valid_targets):
    actions = []
    for tool_call in (getattr(response, "tool_calls", None) or []):
        if tool_call.get("name") != "navigate_to":
            continue
        args = tool_call.get("args") or {}
        target_type = args.get("target_type")
        target_id = args.get("target_id")
        label = args.get("label") or valid_targets.get((target_type, target_id)) or target_id
        if (target_type, target_id) not in valid_targets:
            continue  # not something actually retrieved this turn — drop it rather than trust an invented id
        actions.append({"type": "navigate_to", "target_type": target_type, "target_id": target_id, "label": label})
    return actions


def _llm_authored_navigate_description(action, llm_messages, first_response, model_name=None):
    """Some tool-calling models return empty content when they defer
    entirely to a navigate_to call, even though the system prompt REQUIRES
    a real accompanying description. Rather than substituting a raw chunk
    dump or a constructed sentence, this forces a genuine second LLM call —
    the model's own tool_calls message plus a synthetic ToolMessage
    acknowledgment (required by Groq's API: every tool_call in an assistant
    turn must be answered before the conversation can continue) and a plain
    HumanMessage asking it to now write the description — so the visible
    reply is always model-generated, never templated. Returns "" (never
    None/raises) on any failure, so the caller's last-resort fallback still
    has a real backstop."""
    nav_call = next(
        (tc for tc in (first_response.tool_calls or []) if tc.get("name") == "navigate_to"), None
    )
    if not nav_call:
        return ""
    try:
        ack = ToolMessage(
            content=json.dumps({"status": "navigated_to", "target": action["label"]}),
            tool_call_id=nav_call["id"],
        )
        follow_up_messages = [
            *llm_messages,
            first_response,
            ack,
            HumanMessage(
                f"Now write the 1-3 sentence description of \"{action['label']}\" that the "
                "FORMATTING and LAYERS/SUBCATEGORIES/CATEGORIES/CONTROLS rules above require "
                "alongside every navigate_to call — grounded only in the CONTEXT already given "
                "in the system prompt. Plain text only, no tool calls."
            ),
        ]
        follow_up = chat_engine.get_llm(model_name).invoke(follow_up_messages)  # no tools bound — force plain text
        return (follow_up.content or "").strip()
    except Exception:
        return ""


def _fallback_description(action, chunks):
    """Last-resort backstop if even _llm_authored_navigate_description fails
    (e.g. the Groq call itself errors) — the retrieved chunk's own text for
    this action's target, already "Layer: <label>. <description> (category:
    ...)" / "Control: <label>. <description>" (see ingest_chat_knowledge.py's
    _collect_layer_catalog/_collect_controls), so even this backstop is real
    retrieved content rather than an invented sentence. A "category" target
    has no single matching chunk (nothing is ingested AS a category) —
    instead, lists every retrieved layer that shares this category, since
    those chunks are exactly what made the category a valid target in the
    first place (see _valid_navigate_targets)."""
    if action["target_type"] in ("category", "subcategory"):
        # Chunk text is "Layer: <label> <description> (category: ...)" —
        # label and description are space-joined with no reliable
        # delimiter between them (see ingest_chat_knowledge.py's
        # _collect_layer_catalog), so it can't be cleanly split back out
        # here. item_key is always clean, just not pretty — title-cased
        # with underscores turned to spaces reads close enough to the
        # real label for a short fallback list.
        if action["target_type"] == "category":
            def _matches(meta):
                return meta.get("category_key") == action["target_id"]
        else:
            cat_id, _, sub_id = action["target_id"].partition("::")
            def _matches(meta):
                return meta.get("category_key") == cat_id and meta.get("subcategory_key") == sub_id

        labels = [
            c["metadata"]["item_key"].replace("_", " ").title() for c in chunks
            if c["metadata"].get("source_type") == "layer_catalog" and _matches(c["metadata"])
        ]
        if not labels:
            return None
        return f"**{action['label']}** includes layers such as: " + ", ".join(labels) + "."

    id_field = "item_key" if action["target_type"] == "layer" else "frontend_id"
    for chunk in chunks:
        if chunk["metadata"].get(id_field) == action["target_id"]:
            return chunk["text"]
    return None


def _format_source_label(chunk):
    meta = chunk["metadata"]
    source_type = meta.get("source_type")
    if source_type == "layer_catalog":
        return {"source_file": meta.get("source_file"), "item_key": meta.get("item_key")}
    if source_type == "control":
        return {"source_file": meta.get("source_file"), "frontend_id": meta.get("frontend_id")}
    label = {"source_file": meta.get("source_file")}
    if meta.get("section_heading"):
        label["section_heading"] = meta["section_heading"]
    return label


def _build_prompt_context(chunks):
    if not chunks:
        return "(No relevant context was found for this question.)"
    blocks = []
    for i, chunk in enumerate(chunks, start=1):
        meta = chunk["metadata"]
        source_type = meta.get("source_type")
        if source_type == "layer_catalog":
            origin = f"layer_catalog.json, item: {meta.get('item_key')}"
        elif source_type == "control":
            origin = f"controls_catalog.py, control: {meta.get('frontend_id')}"
        else:
            origin = meta.get("source_file", "unknown")
            if meta.get("section_heading"):
                origin += f", §{meta['section_heading']}"
        blocks.append(f"[{i}] (source: {origin})\n{chunk['text']}")
    return "\n\n".join(blocks)


@method_decorator(csrf_exempt, name="dispatch")
class NcopAssistantChatView(APIView):
    # csrf_exempt only stops Django's OWN CsrfViewMiddleware — it does NOT
    # stop DRF's SessionAuthentication from separately enforcing CSRF
    # itself (SessionAuthentication.enforce_csrf runs whenever
    # request.user is a real, active user — i.e. whenever the browser
    # posting to this endpoint happens to be logged into NCOP — completely
    # independent of any csrf_exempt marker on the view). That's what
    # produced the 403: this is open/unauthenticated by design, like
    # every other endpoint in this app, so DRF must never attempt session
    # auth (and its CSRF side effect) here at all.
    authentication_classes = []
    permission_classes = []
    throttle_classes = [NcopAssistantChatThrottle]

    def post(self, request):
        try:
            body = json.loads(request.body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Malformed JSON body."}, status=400)

        message = (body.get("message") or "").strip()
        if not message:
            return JsonResponse({"error": "\"message\" is required."}, status=400)
        if len(message) > MAX_QUESTION_CHARS:
            return JsonResponse(
                {"error": f"Message too long (max {MAX_QUESTION_CHARS} characters)."}, status=400
            )

        # Model picker (frontend header dropdown, backed by
        # NcopAssistantModelsView) — an unrecognized/omitted id silently
        # falls back to chat_engine.DEFAULT_MODEL rather than erroring, so
        # a stale localStorage pref from a since-removed model can never
        # break the endpoint.
        requested_model = body.get("model")
        if requested_model not in chat_engine.SUPPORTED_MODELS:
            requested_model = chat_engine.DEFAULT_MODEL

        history = request.session.get(SESSION_HISTORY_KEY, [])

        # A vague follow-up ("which category is it under?") embeds poorly
        # on its own — retrieval pulls back unrelated chunks, and the model
        # then (correctly) refuses to state anything not grounded in THIS
        # turn's context, even though the answer sits in the immediately
        # preceding assistant turn. Folding the last exchange into the
        # RETRIEVAL query (not into what's shown as the actual message)
        # is what actually fixes this — the model resolving "it" from
        # conversation history alone, without matching context, runs into
        # the same over-cautious grounding behavior that makes it refuse
        # to state a fact "the context doesn't support" in the first place.
        retrieval_query = message
        if history:
            retrieval_query = f"{history[-1]['content']} {message}"

        chunks = chat_engine.retrieve(retrieval_query, top_k=TOP_K)
        map_state = _sanitize_map_state(body.get("map_state"))
        map_state_block = _build_map_state_context(map_state)

        def _build_system_prompt():
            return (
                f"{SYSTEM_PROMPT_HEADER}\n\n"
                f"LIVE MAP STATE:\n{map_state_block}\n\n"
                f"CONTEXT:\n{_build_prompt_context(chunks)}"
            )

        history_messages = [
            (HumanMessage if turn["role"] == "user" else AIMessage)(turn["content"])
            for turn in history
        ]

        # Populated below if a data tool resolves a single, unambiguous
        # city (see assistant_tools.py's `map_location` field) — the
        # camera move is decided in CODE from the tool's own result, not
        # left to the model to separately remember to call navigate_to
        # for a place name (which isn't even a valid navigate_to target
        # type). First one found wins; a turn that touches two different
        # cities is rare enough that flying to the first is a reasonable
        # call rather than adding UI for picking between them.
        map_location_action = None

        try:
            llm_messages = [SystemMessage(_build_system_prompt()), *history_messages, HumanMessage(message)]
            # bind_tools() is a lightweight wrapper (no network call) — cheap
            # to build per-request rather than caching on the chat_engine
            # singleton, and keeps the tool schemas (a chatbot.py concern)
            # out of chat_engine.py (pure infra: client/embedding/LLM handles).
            llm_with_tools = chat_engine.get_llm(requested_model).bind_tools([NAVIGATE_TOOL, SEARCH_KB_TOOL, *ALL_TOOLS])
            first_response = llm_with_tools.invoke(llm_messages)
            response = first_response
            nav_response = first_response  # navigate_to is honored from whichever response actually carries it — see below

            # Agentic re-retrieval: the model decided the up-front CONTEXT
            # doesn't cover the question and asked for a second, differently
            # -worded search. Execute it, fold any new chunks into THIS
            # turn's chunk list (so CONTEXT/navigate_to's whitelist/sources
            # all reflect it), then rebuild the system prompt and give the
            # model one more round with tools still bound (minus
            # search_knowledge_base itself, bounding this to a single hop)
            # so it can now answer — or call navigate_to — grounded in the
            # expanded context.
            search_calls = [
                tc for tc in (first_response.tool_calls or []) if tc.get("name") == "search_knowledge_base"
            ]
            if search_calls:
                tool_messages = []
                for tc in search_calls[:1]:  # "only call this once per turn" — a second call is ignored, per the tool's own description
                    result, new_chunks = _run_search_knowledge_base(tc.get("args") or {}, chunks)
                    chunks.extend(new_chunks)
                    tool_messages.append(ToolMessage(content=json.dumps(result), tool_call_id=tc["id"]))
                for tc in search_calls[1:]:
                    tool_messages.append(ToolMessage(content=json.dumps({"error": "Already searched this turn."}), tool_call_id=tc["id"]))
                llm_messages = [SystemMessage(_build_system_prompt()), *history_messages, HumanMessage(message)]
                follow_up_messages = [*llm_messages, first_response, *tool_messages]
                llm_with_tools_round2 = chat_engine.get_llm(requested_model).bind_tools([NAVIGATE_TOOL, *ALL_TOOLS])
                response = llm_with_tools_round2.invoke(follow_up_messages)
                nav_response = response

            # Data tools (get_rainfall_report/get_heatwave_monitoring) ARE
            # executed server-side, unlike navigate_to — bounded to ONE
            # round (no further tool calls honored on the next response) so
            # a single request can never loop indefinitely; this covers the
            # vast majority of real questions, which need at most one live
            # lookup to answer.
            data_calls = [tc for tc in (response.tool_calls or []) if tc.get("name") in DATA_TOOL_NAMES]
            if data_calls:
                tool_messages = []
                for tc in data_calls:
                    executor = TOOL_EXECUTORS[tc["name"]]
                    result = executor(tc.get("args") or {})
                    loc = result.get("map_location") if isinstance(result, dict) else None
                    if loc and map_location_action is None and isinstance(loc.get("lat"), (int, float)) and isinstance(loc.get("lon"), (int, float)):
                        map_location_action = {
                            "type": "fly_to", "lat": loc["lat"], "lon": loc["lon"],
                            "label": loc.get("name") or "location",
                        }
                    tool_messages.append(ToolMessage(content=json.dumps(result), tool_call_id=tc["id"]))
                follow_up_messages = [*llm_messages, response, *tool_messages]
                response = chat_engine.get_llm(requested_model).invoke(follow_up_messages)  # no tools bound — force a plain text synthesis, not another round of calls

            reply = response.content or ""
        except Exception as e:
            return JsonResponse(
                {"error": f"assistant unavailable: {str(e)[:200]}"}, status=502
            )

        # navigate_to is read from nav_response — the first response,
        # unless a search_knowledge_base hop happened this turn, in which
        # case it's the round-2 response (the only one that could still
        # carry a fresh navigate_to call after context expanded). If a data
        # tool was ALSO called after that, the final (tools-unbound)
        # response can never carry a navigate_to of its own, but one the
        # model already decided on earlier should still reach the frontend.
        actions = _extract_navigate_actions(nav_response, _valid_navigate_targets(chunks))
        if actions and not reply.strip():
            # Force a genuine model-authored description rather than ever
            # showing a templated/raw-chunk sentence — see
            # _llm_authored_navigate_description's docstring. Only if that
            # itself fails (e.g. Groq errors on the follow-up call) do we
            # fall back to real retrieved chunk text, and only as an
            # absolute last resort to a bare label.
            reply = (
                _llm_authored_navigate_description(actions[0], llm_messages, nav_response, requested_model)
                or _fallback_description(actions[0], chunks)
                or f"{actions[0]['label']}."
            )

        # Appended AFTER the navigate_to-specific empty-reply fallback
        # above (fly_to actions don't carry target_type/target_id, so
        # they must never be mistaken for one there) — a data tool's
        # follow-up call always forces real synthesized text anyway, so
        # `reply` is essentially never empty for a fly_to-only turn.
        if map_location_action:
            actions = [*actions, map_location_action]

        # Store the plain text turn in history (not the tool-call payload —
        # actions are re-derived fresh from next turn's own retrieval, never
        # replayed from history, so a stale target_id can't leak forward).
        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": reply})
        # Trim to the last MAX_HISTORY_TURNS entries (oldest-first eviction).
        history = history[-MAX_HISTORY_TURNS:]
        request.session[SESSION_HISTORY_KEY] = history
        request.session.modified = True  # mutating a session value in place doesn't auto-mark dirty

        return JsonResponse({
            "reply": reply,
            "sources": [_format_source_label(c) for c in chunks],
            "actions": actions,
            "model": requested_model,
        })
