# project/ncop_internal/translate.py
# ---------------------------------------------------------------------------
# English -> Urdu translation for the two story-mode narrative cards
# (frontend/src/modules/story-provincial-forecast.js "7-Day Weather
# Outlook" and story-dynamic-weather.js "Dynamic Weather Report").
#
# Deliberately NOT Groq/chat_engine.py — the operator wants the NCOP
# Assistant chatbot to be the ONLY consumer of Groq in this project; story
# mode's Urdu narration is a fully separate, self-hosted mechanism. No
# external API calls, no per-request cost, no rate limits — the two
# features share nothing but the general "lazy singleton, load on first
# use" convention chat_engine.py's own Chroma/embedding singletons already
# established.
#
# Model: facebook/nllb-200-distilled-600M (Meta, CC-BY-NC-4.0 — NON-
# COMMERCIAL use only; fine for this NDMA disaster-monitoring dashboard,
# but flagged here since it's a real license term, unlike a permissive
# Apache/MIT dependency). Chosen over the smaller Helsinki-NLP/opus-mt-en-ur
# (Apache-2.0, ~300MB) after A/B testing both live on real PMD warning
# text: the smaller Marian model reliably corrupted numbers/times/units in
# translation (observed: "21:00-23:59" -> "21:37-23:1", "45.2 mm" -> "45
# meters (45 miles)", and it hallucinated "Lahore and Faisalabad" into
# "Karachi") — unacceptable for safety-critical weather warnings. NLLB-200
# (~2.4GB) preserved every number/unit/place-name exactly across the same
# test cases. Entity-masking (placeholder substitution before translation)
# was tried first as a cheaper fix for the smaller model but the
# placeholders themselves didn't survive Marian's generation intact either
# — the underlying model is simply too small/weak, not a formatting issue.
#
# ---- Production hardening (Waitress: one process, many threads) ---------
# Production runs this behind Waitress, a single-process/multi-threaded
# WSGI server — NOT Gunicorn's multi-process worker model — so there's only
# ever ONE copy of this ~1.2GB model in memory regardless of concurrent
# request volume (no per-worker multiplication to worry about). But
# multiple threads CAN call into this module concurrently, which raises
# three real concerns a single-threaded dev session never exercises:
#   1. Two threads racing into the lazy-load on the very first request
#      each other, each starting its own from_pretrained() call.
#   2. Multiple threads running CPU-bound generate() calls at once, fighting
#      each other AND every other concurrent Django/Nginx request on the
#      same box for CPU — this is a shared production VM, not a dedicated
#      inference server.
#   3. PyTorch's own internal intra-op parallelism defaulting to ALL
#      available cores per generate() call, which alone can starve the rest
#      of the application even with just one translate request in flight.
# Addressed below with a single global lock serializing translate work
# end-to-end (concurrent Urdu requests queue rather than contend for CPU —
# an intentional trade-off: this is occasional-use, not high-traffic, so
# predictable/bounded resource use matters more than raw throughput) and an
# explicit torch thread cap. A separate idle-unload watchdog frees the
# ~1.2GB back to the OS after a stretch of no Urdu usage, since most
# sessions on this dashboard are English-only.
#
#   POST /api/translate/  {"texts": ["...", "..."], "target_lang": "ur"}
#   -> {"translations": ["...", "..."]}  (same length/order as `texts`)
# ---------------------------------------------------------------------------

import json
import logging
import threading
import time

from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

logger = logging.getLogger(__name__)

MAX_ITEMS = 400  # a full Dynamic Weather Report's distinct captions (nationwide district/station tours across 3 chapters) can exceed 150 — bumped after that tripped a real 400 in production
MAX_CHARS_PER_ITEM = 2000
MODEL_NAME = "facebook/nllb-200-distilled-600M"
SRC_LANG = "eng_Latn"
TGT_LANG = "urd_Arab"

# Batched through the model in groups of this size — purely a memory/CPU-
# time knob (keeps one generate() call from holding a huge tensor for a
# very large story), NOT a rate-limit workaround; there's no external
# quota here since everything runs locally.
GENERATE_BATCH_SIZE = 16

# Caps PyTorch's own intra-op thread pool for every generate() call — left
# unset, PyTorch defaults to ALL visible cores, which on a shared
# production VM (also running Nginx/Waitress/Django/Postgres) starves
# everything else for the duration of a translation. Tune to roughly a
# quarter of the box's cores; 2 is a safe default for a modest VM. This is
# independent of GENERATE_BATCH_SIZE — it bounds parallelism WITHIN one
# generate() call, not how many items that call processes.
TORCH_NUM_THREADS = 2

# Unloads the model (frees ~1.2GB back to the OS) after this many seconds
# with no translate activity — most sessions on this dashboard never touch
# Urdu at all, so there's no reason to hold that memory for the life of the
# process. Reloading afterward costs a few seconds (local-cache-only, see
# HF_HUB_OFFLINE in settings/base.py), paid once on the next Urdu request.
IDLE_UNLOAD_SECONDS = 15 * 60

_tokenizer = None
_model = None
_urdu_bos_token_id = None
_last_used_at = 0.0
_watchdog_started = False
_torch_threads_set = False

# Single global lock — see module docstring's "Production hardening"
# section for why serializing (not parallelizing) translate work is the
# right trade-off here. Guards both the lazy model load AND every
# generate() call, so it also protects _last_used_at / the idle-unload
# watchdog from racing the load/unload state.
_lock = threading.Lock()


def _idle_watchdog():
    """Runs for the life of the process, checking once a minute whether the
    model has sat unused past IDLE_UNLOAD_SECONDS and freeing it if so.
    Started exactly once, lazily, the first time the model is loaded — a
    worker that's never translated anything never spins this thread up at
    all, consistent with this module's overall lazy-everything posture."""
    while True:
        time.sleep(60)
        with _lock:
            if _model is not None and (time.time() - _last_used_at) > IDLE_UNLOAD_SECONDS:
                _unload_model_locked()


def _unload_model_locked():
    """Caller must hold _lock. Drops the model/tokenizer references so
    Python's GC (and PyTorch's own allocator) can actually release the
    memory — the next translate call transparently reloads via
    _get_model()'s normal lazy-load path."""
    global _tokenizer, _model, _urdu_bos_token_id
    if _model is not None:
        logger.info("translate.py: unloading idle NLLB model (no Urdu activity for %ds)", IDLE_UNLOAD_SECONDS)
    _tokenizer = None
    _model = None
    _urdu_bos_token_id = None


def _get_model():
    """Lazy singleton — caller must hold _lock. The tokenizer/model are
    loaded from the local HuggingFace cache (HF_HOME, see settings/base.py
    — redirected off the system drive, HF_HUB_OFFLINE=1 so this never
    touches the network) or downloaded once on first-ever use, then kept in
    process memory until the idle watchdog reclaims them. Loaded in
    float16 — halves the in-memory footprint (~2.4GB -> ~1.2GB) for
    inference-only use with no meaningful quality loss; this is CPU
    inference, not training, so the extra precision float32 carries isn't
    needed. Never touched at Django import time."""
    global _tokenizer, _model, _urdu_bos_token_id, _watchdog_started, _torch_threads_set
    if _model is None:
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        if not _torch_threads_set:
            torch.set_num_threads(TORCH_NUM_THREADS)
            _torch_threads_set = True
        _tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME, src_lang=SRC_LANG)
        # low_cpu_mem_usage avoids materializing a full float32 copy in RAM
        # before casting down to float16 — loads weights straight into
        # target dtype instead, keeping the PEAK memory during the load
        # itself (not just the steady-state footprint after) down near the
        # ~1.2GB final size rather than briefly spiking toward ~2.4GB.
        _model = AutoModelForSeq2SeqLM.from_pretrained(
            MODEL_NAME, dtype=torch.float16, low_cpu_mem_usage=True
        )
        _model.eval()
        _urdu_bos_token_id = _tokenizer.convert_tokens_to_ids(TGT_LANG)
    if not _watchdog_started:
        _watchdog_started = True
        threading.Thread(target=_idle_watchdog, daemon=True).start()
    return _tokenizer, _model, _urdu_bos_token_id


def warm_up():
    """Pre-loads the model — called from apps.py's ready() on a
    background thread at process start, so the ~2.4GB cold-load cost
    happens once, off the request path, before any real /api/translate/
    request arrives. A real production 504 was traced to nginx's gateway
    timeout expiring while the FIRST request paid this exact cost itself
    on top of actually translating. Takes the SAME _lock _get_model()
    always requires — if a real request's own call races in while this is
    still loading, it simply waits for the same in-progress load rather
    than starting a second one, then returns instantly once this
    finishes. Never raises: a failure here is silently deferred to the
    next real request's own _get_model() call, which already logs/handles
    a load failure and degrades to English text — this is a head-start,
    never a new hard dependency."""
    try:
        with _lock:
            _get_model()
    except Exception:
        logger.exception("translate.py: background model warm-up failed (will retry lazily on first real request)")


# Content-addressed, process-level cache — same simplicity convention as
# everything else in this codebase (no Redis/Celery job queue for a
# dashboard this size; the only shared cache backend wired up anywhere is
# unshared per-process LocMemCache anyway, see chatbot.py's own comment on
# this). A recurring sentence (the same warning re-fetched, or two
# districts sharing near-identical phrasing) never gets re-translated.
# Survives an idle-unload (only the MODEL gets freed, not this cache).
_translation_cache = {}


def translate_to_urdu(texts):
    """Translates `texts` (a list of English strings) to Urdu using the
    local NLLB-200 model. Returns a list the same length/order as `texts`.
    Cache hits are returned instantly with zero model calls; only genuine
    misses go through generate(), batched in groups of GENERATE_BATCH_SIZE.
    Never raises — any model/tokenizer failure falls back to the ORIGINAL
    English string for whatever couldn't be translated, same "never break
    the story" contract the view expects. Holds the module lock for its
    entire duration — see the module docstring for why concurrent
    translate work is deliberately serialized rather than run in parallel
    on this shared production box."""
    if not texts:
        return []

    with _lock:
        global _last_used_at
        _last_used_at = time.time()

        results = [None] * len(texts)
        pending_idx, pending_text = [], []
        for i, t in enumerate(texts):
            cached = _translation_cache.get(t)
            if cached is not None:
                results[i] = cached
            else:
                pending_idx.append(i)
                pending_text.append(t)

        for start in range(0, len(pending_text), GENERATE_BATCH_SIZE):
            batch = pending_text[start:start + GENERATE_BATCH_SIZE]
            batch_idx = pending_idx[start:start + GENERATE_BATCH_SIZE]
            try:
                tokenizer, model, urdu_bos = _get_model()
                import torch
                inputs = tokenizer(batch, return_tensors="pt", truncation=True, padding=True, max_length=512)
                with torch.no_grad():
                    outputs = model.generate(**inputs, forced_bos_token_id=urdu_bos, max_length=512)
                decoded = tokenizer.batch_decode(outputs, skip_special_tokens=True)
            except Exception:
                logger.exception("translate.py: NLLB translation failed for a %d-item batch", len(batch))
                decoded = list(batch)  # fall back to English for this batch only

            for idx, original, translated in zip(batch_idx, batch, decoded):
                translated = translated.strip() or original
                _translation_cache[original] = translated
                results[idx] = translated
            _last_used_at = time.time()  # keep sliding while a large batch is still in progress

        return results


class NcopTranslateThrottle(AnonRateThrottle):
    scope = "ncop_translate"


@method_decorator(csrf_exempt, name="dispatch")
class NcopTranslateView(APIView):
    # Same open/unauthenticated posture as NcopAssistantChatView — see that
    # class's own comment on why authentication_classes must stay empty
    # (DRF's SessionAuthentication.enforce_csrf fires independently of
    # csrf_exempt whenever request.user is a real logged-in user).
    authentication_classes = []
    permission_classes = []
    throttle_classes = [NcopTranslateThrottle]

    def post(self, request):
        try:
            body = json.loads(request.body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Malformed JSON body."}, status=400)

        texts = body.get("texts")
        if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
            return JsonResponse({"error": "\"texts\" must be a non-empty array of strings."}, status=400)
        if len(texts) > MAX_ITEMS:
            return JsonResponse({"error": f"Too many items (max {MAX_ITEMS})."}, status=400)
        texts = [t[:MAX_CHARS_PER_ITEM] for t in texts]

        target_lang = body.get("target_lang") or "ur"
        if target_lang != "ur":
            return JsonResponse({"error": "Only target_lang \"ur\" is currently supported."}, status=400)

        # translate_to_urdu no longer raises in practice (each internal
        # batch degrades to English independently) — this try/except is a
        # last-resort safety net, not the primary error path.
        try:
            translations = translate_to_urdu(texts)
        except Exception as e:
            logger.exception("translate.py: unexpected failure translating %d items", len(texts))
            return JsonResponse({"error": f"translation unavailable: {str(e)[:200]}"}, status=502)

        return JsonResponse({"translations": translations})
