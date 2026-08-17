# project/ncop_internal/chat_engine.py
# ---------------------------------------------------------------------------
# Shared, process-level singletons for the NCOP Assistant (Phase 1 RAG Q&A):
# the Chroma persistent client/collection, its embedding function, and the
# Groq LLM handle. Imported by BOTH the ingestion management command
# (management/commands/ingest_chat_knowledge.py, run rarely/manually) and
# the request-time view (chatbot.py, run on every chat message) so the
# ~90MB ONNX embedding model and the on-disk Chroma index are each opened
# exactly ONCE per worker process, never once per request.
#
# Deliberately LAZY, not eager-at-import: unlike views.py's
# `GEE_INITIALIZED = initialize_earth_engine()` (a real network/auth call
# that runs the instant that module is first imported, regardless of
# whether any Earth Engine feature is ever used in a given process's
# lifetime), nothing here touches disk/network/CPU until the first actual
# call — a worker that never receives a chat request never pays the ONNX
# model's load cost at all.
# ---------------------------------------------------------------------------

from django.conf import settings

CHROMA_DB_DIR = settings.BASE_DIR / "cache" / "chroma_db"
COLLECTION_NAME = "ncop_assistant_kb"
LLM_TIMEOUT_SECONDS = 20

# Model picker (chatbot.py's NcopAssistantModelsView / the frontend's header
# dropdown) — every entry here is a real, live-verified Groq model id that
# accepts tool binding (confirmed via a direct bind_tools().invoke() call
# against each, not just assumed from Groq's docs). `kwargs` are the exact
# constructor kwargs get_llm() passes to ChatGroq for that model — only the
# openai/gpt-oss family exposes `reasoning_effort` (Groq/OpenAI's own
# extended param, matching the reference config confirmed with the user:
# temperature=1, top_p=1, reasoning_effort="medium", max_completion_tokens
# =2048); the Llama models don't support it, so it's simply omitted for
# them rather than sent as a meaningless null.
DEFAULT_MODEL = "openai/gpt-oss-120b"
SUPPORTED_MODELS = {
    "openai/gpt-oss-120b": {
        "label": "GPT-OSS 120B",
        "provider": "OpenAI (open-weight)",
        "description": "Default — strongest reasoning, best for complex or ambiguous questions.",
        "kwargs": {
            "temperature": 1,
            "reasoning_effort": "medium",
            "model_kwargs": {"top_p": 1, "max_completion_tokens": 2048},
        },
    },
    "openai/gpt-oss-20b": {
        "label": "GPT-OSS 20B",
        "provider": "OpenAI (open-weight)",
        "description": "Smaller/faster GPT-OSS variant — quicker replies, still reasoning-capable.",
        "kwargs": {
            "temperature": 1,
            "reasoning_effort": "medium",
            "model_kwargs": {"top_p": 1, "max_completion_tokens": 2048},
        },
    },
    "llama-3.3-70b-versatile": {
        "label": "Llama 3.3 70B",
        "provider": "Meta",
        "description": "Meta's versatile 70B — fast, well-rounded general-purpose answers.",
        "kwargs": {"temperature": 0.7, "max_tokens": 2048, "model_kwargs": {"top_p": 1}},
    },
    "llama-3.1-8b-instant": {
        "label": "Llama 3.1 8B Instant",
        "provider": "Meta",
        "description": "Smallest/fastest option — good for quick lookups, less nuanced on complex questions.",
        "kwargs": {"temperature": 0.7, "max_tokens": 1024, "model_kwargs": {"top_p": 1}},
    },
}

_embedding_fn = None
_client = None
_collection = None
_llm_cache = {}


def get_embedding_function():
    """Lazy singleton — Chroma's bundled ONNX MiniLM-L6-v2 default embedder.
    No torch/sentence-transformers: onnxruntime (already an installed
    dependency) is all this needs, keeping the process footprint small."""
    global _embedding_fn
    if _embedding_fn is None:
        from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
        _embedding_fn = DefaultEmbeddingFunction()
    return _embedding_fn


def get_collection():
    """Lazy singleton — the persistent on-disk Chroma collection. Both
    ingestion and query-time retrieval use this SAME collection/embedding
    function pairing, so a query embedding is always compatible with what
    was indexed."""
    global _client, _collection
    if _collection is None:
        import chromadb
        CHROMA_DB_DIR.mkdir(parents=True, exist_ok=True)
        _client = chromadb.PersistentClient(path=str(CHROMA_DB_DIR))
        _collection = _client.get_or_create_collection(
            COLLECTION_NAME, embedding_function=get_embedding_function()
        )
    return _collection


def get_llm(model_name=None):
    """Lazy, per-model singleton — Groq via langchain-groq's ChatGroq, which
    wraps the same Groq Cloud chat-completions endpoint the raw `groq` SDK
    hits (confirmed live: identical `api.groq.com/openai/v1/chat/
    completions` calls either way). `model_name` selects from
    SUPPORTED_MODELS (the chat panel's model picker); an unrecognized or
    omitted value falls back to DEFAULT_MODEL, never errors — each distinct
    model gets its OWN cached ChatGroq instance (a worker process ends up
    holding at most len(SUPPORTED_MODELS) of these, all lightweight client
    handles, not model weights). `top_p`/`max_completion_tokens` aren't
    declared ChatGroq fields, but its own `build_extra` validator routes any
    unrecognized constructor kwarg into `model_kwargs`, which
    `_default_params()` then merges straight into the request body sent to
    Groq — passing them explicitly (rather than letting build_extra
    silently absorb them with a warning) sends the exact params each
    model's SUPPORTED_MODELS entry declares. Bounded timeout + a single
    retry, matching the `TIMEOUT` convention already used on every
    external-API view in views.py (e.g. NwfcRainfallReportAPIView), so a
    hung upstream call can't pin a request/worker indefinitely."""
    if model_name not in SUPPORTED_MODELS:
        model_name = DEFAULT_MODEL
    if model_name not in _llm_cache:
        from langchain_groq import ChatGroq
        _llm_cache[model_name] = ChatGroq(
            model=model_name,
            api_key=settings.GROQ_API_KEY,
            timeout=LLM_TIMEOUT_SECONDS,
            max_retries=1,
            **SUPPORTED_MODELS[model_name]["kwargs"],
        )
    return _llm_cache[model_name]


def retrieve(query, top_k=5):
    """Embeds `query` (same ONNX model used at ingestion) and returns up to
    `top_k` chunks as a list of {text, metadata, distance} dicts, nearest
    first. Returns [] on any failure — retrieval is best-effort, never a
    hard dependency for the chat view (see chatbot.py's fallback)."""
    try:
        result = get_collection().query(query_texts=[query], n_results=top_k)
    except Exception:
        return []
    docs = (result.get("documents") or [[]])[0]
    metadatas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    return [
        {"text": doc, "metadata": meta or {}, "distance": dist}
        for doc, meta, dist in zip(docs, metadatas, distances)
    ]
