# project/ncop_internal/management/commands/ingest_chat_knowledge.py
# ---------------------------------------------------------------------------
# NCOP Assistant (Phase 1) — builds the RAG knowledge base: chunks the root
# docs + graphify's code-graph report + the sidebar layer catalog, embeds
# them (chat_engine.get_embedding_function(), Chroma's bundled ONNX
# MiniLM-L6-v2 — no torch), and upserts into the persistent Chroma
# collection (chat_engine.get_collection()).
#
# Run manually / occasionally (whenever the source docs or map-layers.js
# change) — never automatically on server start, since ingestion is a
# one-time cost (chunking + embedding a few hundred records), not a
# per-request one. Deterministic chunk ids mean reruns upsert cleanly
# rather than duplicating vectors, so this is always safe to re-run.
#
#   python manage.py ingest_chat_knowledge [--rebuild]
# ---------------------------------------------------------------------------

import re
from html.parser import HTMLParser

from django.conf import settings
from django.core.management.base import BaseCommand

from ncop_internal import chat_engine
from ncop_internal.controls_catalog import RAIL_CONTROLS
from ncop_internal.layer_catalog_parser import parse_layer_catalog

# Root-level docs actually worth embedding for the assistant's own Q&A —
# CONTEXT.md (dense whole-codebase map) and the temporal-layer behavior
# guide. The GCOP integration guides and the Tailscale API guide are
# real docs but scoped to internal integration/ops details an end user
# asking the assistant questions has no reason to see — deliberately
# excluded from the knowledge base (not deleted, just not ingested).
DOC_FILES = [
    "CONTEXT.md",
    "TEMPORAL_LAYERS_GUIDE.md",
]
GRAPH_REPORT_FILE = "graphify-out/GRAPH_REPORT.md"
MAP_LAYERS_FILE = "frontend/src/modules/map-layers.js"
DOCS_PAGE_URL = "/docs/"  # rendered in-process via Django's test Client — see _collect_docs_page


# ---- /docs/ HTML -> plain text (stdlib only, no bs4/lxml) -----------------
# The public documentation page (ncop_internal.views.documentation_view,
# templates/documentation.html) is a real, hand-written ~2,600-line page —
# genuinely worth ingesting — but it's full HTML with a large inline
# <style> block, not markdown. This walks it with Python's built-in
# html.parser (zero new dependency, matching this ingestion command's own
# established "hand-roll it with stdlib rather than add a library"
# convention — see split_into_char_budget_chunks above), skipping
# <script>/<style>/<svg> content and turning heading tags into "#"-prefixed
# lines so the OUTPUT can be fed straight through the same
# split_markdown_into_sections()/split_into_char_budget_chunks() pipeline
# every other doc already uses — no separate chunking path needed.
_SKIP_CONTENT_TAGS = {"script", "style", "head", "noscript", "svg"}
_BLOCK_TAGS = {"p", "div", "section", "article", "li", "tr", "table", "ul", "ol", "br", "hr"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


class _DocPageTextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_CONTENT_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag in _HEADING_TAGS:
            level = min(int(tag[1]), 4)  # split_markdown_into_sections only recognizes up to ####
            self._parts.append("\n" + "#" * level + " ")
        elif tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_CONTENT_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in _HEADING_TAGS or tag in _BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth:
            return
        text = data.strip()
        if text:
            self._parts.append(text + " ")

    def get_text(self):
        raw = "".join(self._parts)
        raw = re.sub(r"[ \t]+", " ", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def html_to_text(html):
    parser = _DocPageTextExtractor()
    parser.feed(html)
    return parser.get_text()

CHUNK_CHAR_BUDGET = 1000
CHUNK_OVERLAP = 100

_HEADER_RE = re.compile(r"^(#{1,4})\s+(.*)$", re.MULTILINE)


def split_markdown_into_sections(text):
    """Splits `text` on markdown headers (#, ##, ###, ####) so a chunk never
    straddles two unrelated sections. Returns [(heading, section_text), ...]
    — heading is "" for any content before the first header."""
    matches = list(_HEADER_RE.finditer(text))
    if not matches:
        return [("", text)]
    sections = []
    if matches[0].start() > 0:
        sections.append(("", text[: matches[0].start()]))
    for i, m in enumerate(matches):
        heading = m.group(2).strip()
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append((heading, text[start:end]))
    return sections


def split_into_char_budget_chunks(text, budget=CHUNK_CHAR_BUDGET, overlap=CHUNK_OVERLAP):
    """Sliding-window character splitter with overlap, breaking on paragraph
    boundaries where possible so a chunk doesn't cut a sentence in half more
    than necessary. Pure stdlib — langchain_text_splitters isn't actually
    installed (verified: unbundled from core langchain as of 1.0), and this
    codebase's own "optimized, low-memory" constraint doesn't justify adding
    a new dependency for ~30 lines of splitting logic."""
    text = text.strip()
    if len(text) <= budget:
        return [text] if text else []

    paragraphs = re.split(r"\n\s*\n", text)
    chunks = []
    current = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) <= budget:
            current = candidate
            continue
        if current:
            chunks.append(current)
            # Carry the tail of the previous chunk forward as overlap.
            current = current[-overlap:] + "\n\n" + para if overlap else para
        else:
            current = para
        # A single paragraph longer than the whole budget still needs a
        # hard cut, character-wise.
        while len(current) > budget:
            chunks.append(current[:budget])
            current = current[budget - overlap:]
    if current:
        chunks.append(current)
    return chunks


class Command(BaseCommand):
    help = "Builds/updates the NCOP Assistant's RAG knowledge base (Chroma persistent collection)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--rebuild", action="store_true",
            help="Drop and recreate the collection instead of upserting into the existing one.",
        )

    def handle(self, *args, **options):
        collection = chat_engine.get_collection()

        if options["rebuild"]:
            self.stdout.write("Rebuilding collection from scratch...")
            import chromadb
            client = chromadb.PersistentClient(path=str(chat_engine.CHROMA_DB_DIR))
            client.delete_collection(chat_engine.COLLECTION_NAME)
            chat_engine._collection = None  # force re-creation on next get_collection()
            collection = chat_engine.get_collection()

        ids, documents, metadatas = [], [], []

        doc_count = self._collect_docs(ids, documents, metadatas)
        docs_page_count = self._collect_docs_page(ids, documents, metadatas)
        graph_count = self._collect_graph_report(ids, documents, metadatas)
        layer_count = self._collect_layer_catalog(ids, documents, metadatas)
        control_count = self._collect_controls(ids, documents, metadatas)

        if not ids:
            self.stderr.write(self.style.ERROR("Nothing to ingest — no chunks produced."))
            return

        # Chroma's add() upserts cleanly on matching ids (Chroma>=0.5 treats
        # add() as upsert-if-exists for this client), but batch through
        # upsert() explicitly so a rerun after editing a doc always reflects
        # the latest text rather than silently keeping stale content.
        BATCH = 200
        for i in range(0, len(ids), BATCH):
            collection.upsert(
                ids=ids[i:i + BATCH],
                documents=documents[i:i + BATCH],
                metadatas=metadatas[i:i + BATCH],
            )

        self.stdout.write(self.style.SUCCESS(
            f"Ingested {len(ids)} chunks total "
            f"({doc_count} doc, {docs_page_count} docs-page, {graph_count} graph-report, "
            f"{layer_count} layer-catalog, {control_count} rail-control) "
            f"into '{chat_engine.COLLECTION_NAME}' at {chat_engine.CHROMA_DB_DIR}"
        ))

    def _collect_docs_page(self, ids, documents, metadatas):
        """Renders the app's own /docs/ documentation page in-process via
        Django's test Client (same pattern used throughout this project for
        live verification) and ingests it — environment-generic by
        construction: it always renders THIS app's own /docs/ route, so the
        exact same code path is correct whether that's served at
        127.0.0.1:8000/docs/ in dev or /docs/ behind a real host in
        staging/prod. Never a hardcoded absolute URL."""
        from django.test import Client
        try:
            client = Client(SERVER_NAME="127.0.0.1")
            response = client.get(DOCS_PAGE_URL)
            if response.status_code != 200:
                self.stderr.write(self.style.WARNING(
                    f"{DOCS_PAGE_URL} returned {response.status_code} — skipping docs page ingestion"
                ))
                return 0
            html = response.content.decode("utf-8", errors="replace")
        except Exception as e:
            self.stderr.write(self.style.WARNING(f"Could not render {DOCS_PAGE_URL}: {e}"))
            return 0

        text = html_to_text(html)
        if not text:
            self.stderr.write(self.style.WARNING(f"{DOCS_PAGE_URL} produced no extractable text — skipping"))
            return 0

        count = 0
        for section_idx, (heading, section_text) in enumerate(split_markdown_into_sections(text)):
            for chunk_idx, chunk in enumerate(split_into_char_budget_chunks(section_text)):
                ids.append(f"docs_page:{section_idx}:{chunk_idx}")
                documents.append(chunk)
                meta = {"source_type": "doc", "source_file": "documentation.html", "chunk_index": chunk_idx}
                if heading:
                    meta["section_heading"] = heading
                metadatas.append(meta)
                count += 1
        return count

    def _collect_docs(self, ids, documents, metadatas):
        count = 0
        for filename in DOC_FILES:
            path = settings.REPO_ROOT / filename
            if not path.exists():
                self.stderr.write(self.style.WARNING(f"Skipping missing doc: {filename}"))
                continue
            text = path.read_text(encoding="utf-8")
            for section_idx, (heading, section_text) in enumerate(split_markdown_into_sections(text)):
                for chunk_idx, chunk in enumerate(split_into_char_budget_chunks(section_text)):
                    ids.append(f"doc:{filename}:{section_idx}:{chunk_idx}")
                    documents.append(chunk)
                    meta = {"source_type": "doc", "source_file": filename, "chunk_index": chunk_idx}
                    if heading:
                        meta["section_heading"] = heading
                    metadatas.append(meta)
                    count += 1
        return count

    def _collect_graph_report(self, ids, documents, metadatas):
        path = settings.REPO_ROOT / GRAPH_REPORT_FILE
        if not path.exists():
            self.stderr.write(self.style.WARNING(f"Skipping missing graph report: {GRAPH_REPORT_FILE}"))
            return 0
        text = path.read_text(encoding="utf-8")
        count = 0
        for section_idx, (heading, section_text) in enumerate(split_markdown_into_sections(text)):
            for chunk_idx, chunk in enumerate(split_into_char_budget_chunks(section_text)):
                ids.append(f"graph_report:{section_idx}:{chunk_idx}")
                documents.append(chunk)
                meta = {"source_type": "graph_report", "source_file": "GRAPH_REPORT.md", "chunk_index": chunk_idx}
                if heading:
                    meta["section_heading"] = heading
                metadatas.append(meta)
                count += 1
        return count

    def _collect_layer_catalog(self, ids, documents, metadatas):
        path = settings.REPO_ROOT / MAP_LAYERS_FILE
        if not path.exists():
            self.stderr.write(self.style.WARNING(f"Skipping missing layer catalog source: {MAP_LAYERS_FILE}"))
            return 0
        source = path.read_text(encoding="utf-8")
        records = parse_layer_catalog(source)
        count = 0
        for record in records:
            item_key = record["itemKey"]
            # Trailing period is deliberate — chatbot.py's _fallback_description
            # (used when the model itself returns no content alongside a
            # navigate_to call) shows this raw chunk text directly, and a
            # clean sentence break after the label reads far better than
            # "Layer: Dust The Dust layer displays..." running together.
            text_parts = [f"Layer: {record['label']}."]
            if record["information"]:
                text_parts.append(record["information"])
            text_parts.append(
                f"(category: {record['categoryKey']}, subcategory: {record['subcategoryKey']}, "
                f"type: {record['itemType']})"
            )
            documents.append(" ".join(text_parts))
            # itemKey alone isn't guaranteed globally unique (e.g.
            # "major_rivers" is legitimately defined twice, under both
            # gis_layers and flood, with different descriptions) —
            # category_key makes the Chroma id unique while item_key stays
            # in the metadata as-is for Phase 2's navigation lookups.
            ids.append(f"layer:{record['categoryKey']}:{item_key}")
            metadatas.append({
                "source_type": "layer_catalog",
                "source_file": "map-layers.js",
                "item_key": item_key,
                "category_key": record["categoryKey"],
                "subcategory_key": record["subcategoryKey"],
                "item_type": record["itemType"],
            })
            count += 1
        if count == 0:
            self.stderr.write(self.style.WARNING(
                "Layer catalog parser returned 0 entries — check layer_catalog_parser.py "
                "against the current shape of ncop_menu_items."
            ))
        return count

    def _collect_controls(self, ids, documents, metadatas):
        count = 0
        for control in RAIL_CONTROLS:
            documents.append(f"Control: {control['label']}. {control['description']}")
            ids.append(f"control:{control['frontend_id']}")
            metadatas.append({
                "source_type": "control",
                "source_file": "controls_catalog.py",
                "frontend_id": control["frontend_id"],
                "control_category": control["category"],
            })
            count += 1
        return count
