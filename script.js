// ============================================================
// === KAERI EDTECH QUIZ ENGINE - HYBRID MASTER (v11.9 MERGED) ===
// === Server-Side Access + Local Content + Doc Delivery + KaTeX + Smart TTS + Markdown ===
// === Enhanced with Silent Revalidation, Expiry Display, and Analytics ===
// === NEW: Professional Revision Kit Generator (Branded Covers + Session Metadata) ===
// === ADDITIVE SAFE UPDATES: Subscription guide idempotency + extra plan info helper ===
// === v1.1 PATCH: KAERI_CONFIG + PRICE_MAP consolidation (behavior unchanged) ===
// === v1.2 PATCH: MCQ manifest loader (per-term lazy loading; demo contract unchanged) ===
// === v1.3 PATCH: SYSTEM_CONFIG from getSystemConfig + MCQ wrong-answer pool (no PRICE_MAP live) ===
// === v1.4 PATCH: no hardcoded prices/durations anywhere; race-free plan cards; streak-based MCQ pool + banner ===
// === v1.5 PATCH: reader (voice/speed/pause/replay), pool right/wrong tally + building, ghost functions wired or removed ===
// === v1.6 PATCH: naturalSort applied to unit and sub-topic ordering ===
// === v1.7 PATCH: STRICTLY TWO BACKENDS ONLY (Gatekeeper & AMB-PAY) ===
// ============================================================


// ============================================================================
// === VIDEO SERVICE WORKER (merged) ==========================================
// This same file is also registered as the service worker (see _vidEnsureSW).
// In the worker, the page code below cannot run (no DOM), so we only install
// harmless shims and the video range proxy, then every UI statement is inert.
// ============================================================================
const _IS_SW = (typeof ServiceWorkerGlobalScope !== 'undefined') && (self instanceof ServiceWorkerGlobalScope);
if (_IS_SW) {
    (function () {
        const noop = function () {};
        const fakeEl = function () { return { style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } }, setAttribute: noop, appendChild: noop, addEventListener: noop, querySelector: function () { return null; }, querySelectorAll: function () { return []; } }; };
        const store = function () { return { getItem: function () { return null; }, setItem: noop, removeItem: noop, clear: noop, key: function () { return null; }, length: 0 }; };
        self.window = self;
        self.document = { hidden: false, readyState: 'complete', addEventListener: noop, removeEventListener: noop, getElementById: function () { return null; }, querySelector: function () { return null; }, querySelectorAll: function () { return []; }, createElement: fakeEl, head: fakeEl(), body: fakeEl(), documentElement: fakeEl() };
        try { self.localStorage = store(); } catch (e) {}
        try { self.sessionStorage = store(); } catch (e) {}
        if (typeof self.MutationObserver === 'undefined') self.MutationObserver = function () { return { observe: noop, disconnect: noop }; };
    })();
    (function () {
        const CHUNK = 3 * 1024 * 1024;
        const CACHE = 'kaeri-video-chunks-v1';
        const SCOPE = self.registration.scope;

        const metaMem = {};     // fileId → { total, mime }
        const ctxMem = {};      // fileId → { u, c, e, d }
        const inflight = {};    // "fileId:idx" → Promise<Uint8Array>
        const stopFlags = {};   // fileId → true while a background fill must stop

        self.addEventListener('install', function () { self.skipWaiting(); });
        self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

        function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
        function keyFor(kind, id, idx) {
          var p = '__' + kind + '__/' + encodeURIComponent(id) + (idx === undefined ? '' : '/' + idx);
          return new Request(new URL(p, SCOPE).href);
        }
        function b64ToBytes(b64) {
          var bin = atob(b64), out = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        function replyCode(j) { return j && (j.code || (j.data && j.data.code)); }
        function isDenial(j) {
          var c = replyCode(j);
          return !!j && (c === 'SESSION_INVALID' || c === 'SCOPE_DENIED' || c === 'DRIVE_UNAVAILABLE' ||
            /revoked|expired|mismatch|not found|denied|unavailable|different account/i.test(String(j.message || '')));
        }
        function post(msg) {
          return self.clients.matchAll({ includeUncontrolled: true }).then(function (cs) {
            cs.forEach(function (c) { c.postMessage(msg); });
          });
        }
        function failWith(id, e) {
          var reply = (e && e.reply) || { success: false, message: (e && e.message) || 'Download failed' };
          return post({ type: 'VID_FAIL', id: id, reply: reply });
        }

        async function getCtx(id) {
          if (ctxMem[id]) return ctxMem[id];
          var hit = await (await caches.open(CACHE)).match(keyFor('kctx', id));
          if (hit) { ctxMem[id] = await hit.json(); return ctxMem[id]; }
          var err = new Error('Session required'); err.reply = { success: false, message: 'Session required', code: 'SESSION_INVALID' };
          throw err;
        }

        // One Gatekeeper call = one chunk (3 attempts, stops early when the answer is a real denial).
        async function callGatekeeper(ctx, id, idx) {
          var last = null;
          for (var a = 0; a < 3; a++) {
            try {
              var res = await fetch(ctx.u, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                body: JSON.stringify({ action: 'get_video_chunk', file_id: id, start: idx * CHUNK, length: CHUNK,
                  session: { code: ctx.c, email: ctx.e, device_fp: ctx.d } })
              });
              var j = await res.json();
              if (j && j.success && j.data && typeof j.data.base64 === 'string') return j;
              last = j;
              if (isDenial(j)) break;
            } catch (e) { last = { success: false, message: 'Network error' }; }
            await sleep(800 * (a + 1));
          }
          var err = new Error((last && last.message) || 'Download failed');
          err.reply = last;
          throw err;
        }

        async function storeChunk(id, idx, j, bytes) {
          metaMem[id] = { total: j.data.total, mime: j.data.mimeType || 'video/mp4' };
          try {
            var cache = await caches.open(CACHE);
            await cache.put(keyFor('kmeta', id), new Response(JSON.stringify(metaMem[id]), { headers: { 'Content-Type': 'application/json' } }));
            await cache.put(keyFor('kchunk', id, idx), new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
          } catch (e) { /* storage full: playback still works, it just is not saved */ }
        }

        async function getChunk(id, idx, ctx) {
          var cache = await caches.open(CACHE);
          var hit = await cache.match(keyFor('kchunk', id, idx));
          if (hit) return new Uint8Array(await hit.arrayBuffer());
          var fk = id + ':' + idx;
          if (inflight[fk]) return inflight[fk];
          var p = (async function () {
            var j = await callGatekeeper(ctx, id, idx);
            var bytes = b64ToBytes(j.data.base64);
            await storeChunk(id, idx, j, bytes);
            return bytes;
          })();
          inflight[fk] = p;
          try { return await p; } finally { delete inflight[fk]; }
        }

        async function getMeta(id, ctx) {
          if (metaMem[id]) return metaMem[id];
          var hit = await (await caches.open(CACHE)).match(keyFor('kmeta', id));
          if (hit) { metaMem[id] = await hit.json(); return metaMem[id]; }
          await getChunk(id, 0, ctx);
          if (!metaMem[id]) {   // chunk 0 was cached but meta was lost: ask the Gatekeeper once
            var j = await callGatekeeper(ctx, id, 0);
            await storeChunk(id, 0, j, b64ToBytes(j.data.base64));
          }
          return metaMem[id];
        }

        async function handle(req, id) {
          var ctx, meta;
          try { ctx = await getCtx(id); meta = await getMeta(id, ctx); }
          catch (e) { failWith(id, e); return new Response('Forbidden', { status: 403 }); }

          var total = meta.total, start = 0, end = total - 1;
          var rh = req.headers.get('range');
          var m = rh && /^bytes=(\d*)-(\d*)$/.exec(rh.trim());
          if (m) {
            if (m[1] === '' && m[2] !== '') start = Math.max(0, total - parseInt(m[2], 10));
            else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(parseInt(m[2], 10), total - 1); }
          }
          if (!(start >= 0) || start >= total || end < start) {
            return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
          }

          var firstIdx = Math.floor(start / CHUNK), lastIdx = Math.floor(end / CHUNK);
          var idx = firstIdx, cancelled = false;

          var body = new ReadableStream({
            async pull(controller) {
              if (cancelled) return;
              try {
                for (var k = 1; k <= 2; k++) if (idx + k <= lastIdx) getChunk(id, idx + k, ctx).catch(function () {});   // download ahead
                var bytes = await getChunk(id, idx, ctx);
                var base = idx * CHUNK;
                var from = Math.max(start, base) - base;
                var to = Math.min(end + 1, base + bytes.length) - base;
                controller.enqueue(bytes.subarray(from, to));
                idx++;
                if (idx > lastIdx) controller.close();
              } catch (e) { failWith(id, e); controller.error(e); }
            },
            cancel: function () { cancelled = true; }
          });

          var headers = { 'Content-Type': meta.mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store' };
          if (m) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total;
          return new Response(body, { status: m ? 206 : 200, headers: headers });
        }

        async function fillAll(id) {
          stopFlags[id] = false;
          var ctx, meta;
          try { ctx = await getCtx(id); meta = await getMeta(id, ctx); } catch (e) { failWith(id, e); return; }
          var count = Math.ceil(meta.total / CHUNK);
          var cache = await caches.open(CACHE);
          var missing = [];
          for (var i = 0; i < count; i++) if (!(await cache.match(keyFor('kchunk', id, i)))) missing.push(i);
          var done = count - missing.length;
          await post({ type: 'VID_FILL', id: id, done: done, count: count });
          var next = 0;
          async function worker() {
            while (!stopFlags[id]) {
              var n = next++;
              if (n >= missing.length) return;
              try { await getChunk(id, missing[n], ctx); }
              catch (e) { failWith(id, e); stopFlags[id] = true; return; }
              done = Math.min(count, done + 1);
              await post({ type: 'VID_FILL', id: id, done: done, count: count });
            }
          }
          await Promise.all([worker(), worker()]);
        }

        self.addEventListener('fetch', function (event) {
          var url = new URL(event.request.url);
          if (url.origin !== self.location.origin) return;
          var m = /\/__kvid__\/([^\/]+)\.mp4$/.exec(url.pathname);
          if (!m) return;
          event.respondWith(handle(event.request, decodeURIComponent(m[1])));
        });

        self.addEventListener('message', function (event) {
          var d = event.data || {};
          if (d.type === 'VID_CLAIM') { event.waitUntil(self.clients.claim()); return; }
          if (d.type === 'VID_CTX') {
            ctxMem[d.id] = d.ctx;
            event.waitUntil((async function () {
              try { await (await caches.open(CACHE)).put(keyFor('kctx', d.id), new Response(JSON.stringify(d.ctx))); } catch (e) {}
              if (event.ports && event.ports[0]) event.ports[0].postMessage('ok');
            })());
          } else if (d.type === 'VID_FILL') {
            event.waitUntil(fillAll(d.id));
          } else if (d.type === 'VID_STOP') {
            stopFlags[d.id] = true;
          }
        });
    })();
}

// --- CONFIGURATION ---

const KAERI_CONFIG = {
    // Brand
    brandName:          'Kaeri EdTech',
    brandTagline:       'Empowering Learners Through Smart Educational Technology',
    brandShort:         'KAERI EDTECH',
    siteUrl:            'https://kaerikalmar.github.io/KaeriEdTech',

    // ─── THE ONLY TWO ACTIVE BACKENDS ───
    
    // 1. Gatekeeper Backend (Auth, Docs, Analytics)
    gatekeeperUrl:      "https://script.google.com/macros/s/AKfycbz-MRtXXBc57A4TQAlja7vfJN3I7umOWALMZiN_-TPYkzRHn8uX7LURrnG0TNRokPFfiQ/exec",
    
    // 2. AMB-PAY Backend (Payments, Config, Bridge)
    ambPayUrl:          "https://script.google.com/macros/s/AKfycbzeN2ZWwnBReNQnvu_1GUr6qZMGmTNUi2e7-byJnFtkJRs6st2LyGyAgBKDwaP9jv5S/exec",

    // Ambassador cross-app.
    ambassadorPortalUrl: "AMB-PORTAL.html", 
    ambassadorApiUrl:    "",                

    // Limits and timers
    demoAttemptLimit:           20,
    revalidationMs:             300000,
    configSyncMs:               300000,   // silent live-config sync (App Config tab changes reach students within ~5 min)
    revalidationWarmupMs:       5000,
    courseLoadDelayMs:          100,
    paymentRetries:             3,
    paymentRetryGapMs:          1000,
    paymentTimeoutMs:           30000,
    maxPaymentScreenshotBytes:  5 * 1024 * 1024,
    printPopupBlockDelayMs:     60000
};

// --- LEGACY ALIASES (Mapped to the 2 active URLs) ---
// The rest of this file relies on these specific names. 
// Do NOT add new URLs. Everything below maps strictly to your two backends.
const APPS_SCRIPT_URL       = KAERI_CONFIG.gatekeeperUrl;    // Gatekeeper
const DOCS_SCRIPT_URL       = KAERI_CONFIG.gatekeeperUrl;    // Gatekeeper
const PAYMENT_SCRIPT_URL    = KAERI_CONFIG.ambPayUrl;        // AMB-PAY
const AMBASSADOR_PORTAL_URL = KAERI_CONFIG.ambassadorPortalUrl;
const AMBASSADOR_API_URL    = KAERI_CONFIG.ambassadorApiUrl;

// ============================================================
// === LIVE SYSTEM CONFIG: prices + durations ===
// Single source of truth = AppConfig sheet (via getSystemConfig).
// NOTHING in this file hardcodes a price or a duration. If the live
// config is not available the UI shows "—" instead of guessing.
// ============================================================
let SYSTEM_CONFIG = { inventory: {}, durations: {}, maxDevices: {}, demoAttemptLimit: null, loaded: false, loadedAt: 0, error: '' };
let _configInflight = null;
const CONFIG_FRESH_MS = 60 * 1000;   // reuse a fetched config for 60s, then refresh in the background
let purchaseIntent = null;           // { course, term } requested by a plan card, consumed once by renderPaymentForm()

function _up(v) { return String(v || '').trim().toUpperCase(); }

function _cfgNumber(map, course, term) {
    try {
        const row = map && map[_up(course)];
        if (row && row[_up(term)] != null) {
            const n = Number(row[_up(term)]);
            if (isFinite(n)) return n;
        }
    } catch (e) {}
    return null;
}

/** Live price or null (never a guess). */
function getPriceFor(course, term) {
    const n = _cfgNumber(SYSTEM_CONFIG.inventory, course, term);
    return (n !== null && n >= 0) ? n : null;
}

/** Live duration in days or null (never a guess). */
function getDurationFor(course, term) {
    const n = _cfgNumber(SYSTEM_CONFIG.durations, course, term);
    return (n !== null && n > 0) ? n : null;
}

function getMaxDevicesFor(course, term) {
    const n = _cfgNumber(SYSTEM_CONFIG.maxDevices, course, term);
    return (n !== null && n > 0) ? n : null;
}

function formatPrice(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return 'K' + (Math.round(n) === n ? n : n.toFixed(2));
}

function formatDays(n) {
    if (n === null || n === undefined || !isFinite(n)) return '';
    return n + (n === 1 ? ' day' : ' days');
}

/** Course/term currently open in the study view (set synchronously by loadCourse). */
function getViewedScope() {
    return {
        course: _up(document.body.getAttribute('data-course')),
        term: _up(document.body.getAttribute('data-term'))
    };
}

function payScopeLabel(course, term) {
    const c = _up(course), t = _up(term);
    if (c === 'ALL' && t === 'ALL') return '🌍 Global Access · all courses';
    if (t === 'ALL') return c + ' · Full Course (all terms)';
    return c + ' ' + t;
}

/** Live demo limit from AppConfig (DemoAttemptLimit). Falls back to the hardcoded default when offline/unset. */
function getDemoLimit() {
    const live = SYSTEM_CONFIG && SYSTEM_CONFIG.demoAttemptLimit;
    return (typeof live === 'number' && isFinite(live) && live >= 0) ? live : KAERI_CONFIG.demoAttemptLimit;
}

/** Fetch live inventory/durations/maxDevices. Safe to call often (cached + single-flight). */
function loadSystemConfig(force, isSilent) {
    if (!force && !isSilent && SYSTEM_CONFIG.loaded && (Date.now() - SYSTEM_CONFIG.loadedAt) < CONFIG_FRESH_MS) {
        return Promise.resolve(SYSTEM_CONFIG);
    }
    if (_configInflight) return _configInflight;
    _configInflight = callPaymentApi('getSystemConfig', {})
        .then(function (res) {
            if (!res || !res.success) throw new Error((res && res.message) || 'Could not load prices.');
            SYSTEM_CONFIG.inventory  = res.inventory  || {};
            SYSTEM_CONFIG.durations  = res.durations  || {};
            SYSTEM_CONFIG.maxDevices = res.maxDevices || {};
            SYSTEM_CONFIG.demoAttemptLimit = (typeof res.demoAttemptLimit === 'number') ? res.demoAttemptLimit : null;
            SYSTEM_CONFIG.loaded = true;
            SYSTEM_CONFIG.loadedAt = Date.now();
            SYSTEM_CONFIG.error = '';
            inventory = SYSTEM_CONFIG.inventory;     // the payment form's dropdowns read this
            refreshPriceUI();
            return SYSTEM_CONFIG;
        })
        .catch(function (err) {
            if (isSilent) return SYSTEM_CONFIG;   // silent sync: keep the last known config, never surface an error
            SYSTEM_CONFIG.error = (err && err.message) || 'offline';
            throw err;
        })
        .then(function (v) { _configInflight = null; return v; },
              function (e) { _configInflight = null; throw e; });
    return _configInflight;
}

// Silent background sync: no spinner, no errors shown. Pauses while the tab is hidden.
let _configSyncTimer = null;
function startConfigSync() {
    if (_configSyncTimer) clearInterval(_configSyncTimer);
    _configSyncTimer = setInterval(function () {
        if (document.hidden) return;
        loadSystemConfig(true, true).catch(function () {});
    }, KAERI_CONFIG.configSyncMs);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && SYSTEM_CONFIG.loaded &&
            (Date.now() - SYSTEM_CONFIG.loadedAt) > KAERI_CONFIG.configSyncMs) {
            loadSystemConfig(true, true).catch(function () {});
        }
    });
}

/** Banner + pricing text inside the course view. Never unhides the banner (full-access users keep it hidden). */
function renderCourseBanner(course, term) {
    const price = getPriceFor(course, term);
    const days = getDurationFor(course, term);
    currentPrice = price;

    let bannerText, valText;
    if (price === null) {
        bannerText = SYSTEM_CONFIG.error && !SYSTEM_CONFIG.loaded ? 'Price unavailable (offline)'
                   : SYSTEM_CONFIG.loaded ? 'Price unavailable' : 'Loading price…';
        valText = '—';
    } else {
        bannerText = formatPrice(price) + (days ? ' · ' + formatDays(days) : '');
        valText = formatPrice(price) + (days ? ' for ' + formatDays(days) : '');
    }
    const banner = document.getElementById('price-banner');
    if (banner) banner.textContent = bannerText;
    const priceVal = document.getElementById('price-val');
    if (priceVal) priceVal.textContent = valText;
    const priceDesc = document.getElementById('price-desc');
    if (priceDesc) priceDesc.textContent = course + ' Term ' + String(term).replace(/^T/i, '');
}

/** Re-render every price/duration surface from the live config. */
function refreshPriceUI() {
    try {
        const v = getViewedScope();
        if (v.course && v.term) renderCourseBanner(v.course, v.term);
        updatePlanCards();
        const modal = document.getElementById('payment-modal');
        if (modal && modal.classList.contains('show')) updatePrice();
    } catch (e) { console.warn('[refreshPriceUI]', e); }
}

function _setPlanCard(kind, price, days, baseText, hasContext) {
    const key = kind === 'full' ? 'full-course' : 'global';
    const card = document.querySelector('[data-plan-card="' + kind + '"]');
    // Hide a card only when we KNOW the plan is not sold (config loaded, context known, no price).
    const unavailable = SYSTEM_CONFIG.loaded && hasContext && price === null;
    if (card) card.style.display = unavailable ? 'none' : '';
    document.querySelectorAll('[data-plan="' + key + '"]').forEach(function (el) {
        el.textContent = formatPrice(price);
    });
    document.querySelectorAll('[data-plan-duration="' + key + '"]').forEach(function (el) {
        el.textContent = baseText + (days ? ' · ' + formatDays(days) : '');
    });
}

/** Full Course + Global cards: live price AND live duration. The Full Course card follows the course in view / selected. */
function updatePlanCards(course) {
    const cs = document.getElementById('courseSelect');
    const selected = cs ? _up(cs.value) : '';
    const c = _up(course) || (selected && selected !== 'ALL' ? selected : '') || getViewedScope().course || _up(currentCourse);
    _setPlanCard('full',
        c ? getPriceFor(c, 'ALL') : null,
        c ? getDurationFor(c, 'ALL') : null,
        c ? 'All terms' : 'Pick a course first',
        !!c);
    _setPlanCard('global', getPriceFor('ALL', 'ALL'), getDurationFor('ALL', 'ALL'), 'Every course', true);
}

/** Which course should the Full Course card buy? Dropdown choice → course in view → last opened. */
function _resolveFullCourse() {
    const cs = document.getElementById('courseSelect');
    const picked = cs ? _up(cs.value) : '';
    if (picked && picked !== 'ALL') return picked;
    return getViewedScope().course || _up(currentCourse) || '';
}

function onFullCourseClick() {
    const course = _resolveFullCourse();
    if (!course) {
        showAppNotification('Choose a course in the form above first, then tap Full Course.', 'info', 3500);
        const cs = document.getElementById('courseSelect');
        if (cs) { try { cs.focus(); } catch (e) {} }
        return;
    }
    if (SYSTEM_CONFIG.loaded && getPriceFor(course, 'ALL') === null) {
        showAppNotification('⚠️ Full Course is not available for ' + course + ' right now.', 'warning', 3500);
        return;
    }
    openPaymentModal({ course: course, term: 'ALL' });
}

function onGlobalClick() {
    if (SYSTEM_CONFIG.loaded && getPriceFor('ALL', 'ALL') === null) {
        showAppNotification('⚠️ Global Access is not available right now.', 'warning', 3500);
        return;
    }
    openPaymentModal({ course: 'ALL', term: 'ALL' });
}


// --- STATE ---

let ttsEnabled = false;
let printContentData = null;
let hasFullAccess = false;
let currentPrice = null; // set by loadCourse from SYSTEM_CONFIG / fallback
let isSubmissionLocked = false; 

// --- User session data (for silent revalidation & analytics) ---
let userEmail = '';
let userCode = '';
let deviceFP = '';

// --- DATA CONTAINERS ---
// NOTE: allMcqData removed — MCQ now loads per-term via the manifest (see Section 1).
let allShortData = [], allEssayData = [], allFlashcards = {};
let currentMcqData = [], currentShortData = [], currentEssayData = [], currentFlashcardTopics = {};

// --- SESSION CONTEXT ---
let currentCourse = null, currentTerm = null, currentTermKey = null;
let currentQuizType = null, currentQuestionIndex = 0, currentScore = 0, currentQuizData = [];
let currentEssay = null, currentStepIndex = 0, essayScore = 0;
let currentEssayIndex = -1; // index into currentEssayData of the running essay (currentEssay is a shuffled copy)

// Flashcard Specific Contexts
let currentFlashcardTopic = null, currentFlashcards = [], currentCardIndex = 0, isCardFront = true;
let currentFlashcardMode = 'linear'; // 'linear' or 'srs'
let srsQueue = []; 

// Silent revalidation timer
let revalidationInterval = null;

// ============================================================
// === 0. UNIVERSAL PARSER (Markdown -> HTML) ===
// ============================================================

// ── Pipe tables ────────────────────────────────────────────────
// GitHub-style tables:   | A | B |   then   |---|:-:|   then the rows.
// Alignment comes from the separator row (:--- left, :-: centre, --: right).
// A literal pipe inside a cell is written \|  (needed for things like |x| in maths).
// NOTE: deliberately free of regex backslashes — this function is embedded (via toString)
// into the revision-kit print document, so the table logic lives in exactly one place.
// speech = true returns a plain-text reading of the table instead of HTML (used by read-aloud).
function kaeriConvertTables(text, inline, speech) {
    var NL = String.fromCharCode(10), BS = String.fromCharCode(92);
    var lines = String(text).split(NL);
    var out = [];

    function splitRow(line) {
        var s = line.trim(), cells = [], cur = '', i, ch;
        if (s.charAt(0) === '|') s = s.slice(1);
        for (i = 0; i < s.length; i++) {
            ch = s.charAt(i);
            if (ch === BS && s.charAt(i + 1) === '|') { cur += '|'; i++; }
            else if (ch === '|') { cells.push(cur.trim()); cur = ''; }
            else cur += ch;
        }
        if (cur.trim() !== '' || cells.length === 0) cells.push(cur.trim());
        return cells;
    }
    function isRow(line) { return line.indexOf('|') !== -1 && line.trim() !== ''; }
    function isSep(line) {
        if (line.indexOf('|') === -1) return false;
        var c = splitRow(line), k;
        for (k = 0; k < c.length; k++) { if (!/^:?-+:?$/.test(c[k])) return false; }
        return c.length > 0;
    }
    function cellHtml(tag, content, align) {
        return '<' + tag + ' style="text-align:' + align + '">' + (inline ? inline(content) : content) + '</' + tag + '>';
    }
    function tableHtml(head, aligns, rows) {
        var h = '<div class="kaeri-table-wrap"><table class="kaeri-table"><thead><tr>', k;
        for (k = 0; k < head.length; k++) h += cellHtml('th', head[k], aligns[k]);
        h += '</tr></thead><tbody>';
        rows.forEach(function (r) {
            h += '<tr>';
            for (k = 0; k < head.length; k++) h += cellHtml('td', r[k] === undefined ? '' : r[k], aligns[k]);
            h += '</tr>';
        });
        return h + '</tbody></table></div>';
    }
    function tableSpeech(head, rows) {
        var s = 'Table with ' + head.length + (head.length === 1 ? ' column: ' : ' columns: ') + head.join(', ') + '.';
        rows.forEach(function (r, n) {
            var parts = [];
            head.forEach(function (hd, k) { parts.push((hd ? hd + ': ' : '') + (r[k] === undefined ? '' : r[k])); });
            s += NL + 'Row ' + (n + 1) + ': ' + parts.join(', ') + '.';
        });
        return s;
    }

    var i = 0;
    while (i < lines.length) {
        if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
            var head = splitRow(lines[i]), seps = splitRow(lines[i + 1]);
            if (head.length === seps.length) {
                var aligns = seps.map(function (c) {
                    var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
                    return (l && r) ? 'center' : (r ? 'right' : 'left');
                });
                var rows = [], j = i + 2;
                while (j < lines.length && isRow(lines[j])) { rows.push(splitRow(lines[j])); j++; }
                if (out.length && out[out.length - 1].trim() === '') out.pop();   // the table brings its own spacing
                out.push(speech ? tableSpeech(head, rows) : tableHtml(head, aligns, rows));
                i = j;
                if (i < lines.length && lines[i].trim() === '') i++;
                continue;
            }
        }
        out.push(lines[i]);
        i++;
    }
    return out.join(NL);
}

// Bold / underline / italic — shared by the body text and table cells.
function _kaeriInline(t) {
    // Bold (**text**)
    t = t.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    // Underline (__text__)
    t = t.replace(/__(.*?)__/g, "<u>$1</u>");
    // Italic (*text*) - careful regex to avoid breaking Math symbols
    t = t.replace(/(?<!\\)\*([^\s].*?)(?<!\\)\*/g, "<em>$1</em>");
    return t;
}

function parseKaeriMarkdown(text) {
    if (!text) return "";
    let t = text;

    // 0. Tables (| a | b |) — converted first so their rows are not mangled by the rules below
    t = kaeriConvertTables(t, _kaeriInline);

    // 1. Headers (# H1, ## H2)
    t = t.replace(/^## (.*$)/gim, "<h3 style='margin:10px 0; color:#72efdd;'>$1</h3>");
    t = t.replace(/^# (.*$)/gim, "<h2 style='margin:15px 0; color:#fff;'>$1</h2>");

    // 2. Blockquotes (> text)
    t = t.replace(/^> (.*$)/gim, "<blockquote style='border-left:4px solid #72efdd; margin:10px 0; padding-left:15px; color:#a0a8b4; font-style:italic;'>$1</blockquote>");

    // 3. Bullet Lists (- item)
    t = t.replace(/^- (.*$)/gim, "<li style='margin-left:20px;'>$1</li>");

    // 4-6. Bold, underline, italic
    t = _kaeriInline(t);

    // 7. Line Breaks (Convert newlines to HTML breaks)
    t = t.replace(/\n/g, "<br>");

    return t;
}

// ============================================================
// === 1. INITIALIZATION & DATA LOADING ===
// ============================================================

// ── PAYMENT CONFIGURATION & STATE (ADDED) ──
const PAYMENT_API_URL = KAERI_CONFIG.ambPayUrl;  // UPDATED: Points to AMB-PAY backend
let inventory = {};
let isSubmitting = false;
let isChecking = false;

// ────────────────────────────────────────────────────────────
// ── MCQ MANIFEST + PER-TERM LOADER ─────────────────────────
// ────────────────────────────────────────────────────────────
// Term datasets self-register on `window.__MCQ__[termKey]`. The loader injects
// the mapped file once per term, reads back the registered array, filters by
// moderation status, and caches the result.

const MCQ_MANIFEST = {
    "BI110_T1": "assets/mcq/BI110_T1.js",
    "BI110_T2": "assets/mcq/BI110_T2.js",
    "BI110_T3": "assets/mcq/BI110_T3.js",
    "BI111_T1": "assets/mcq/BI111_T1.js",
    "BI111_T2": "assets/mcq/BI111_T2.js",
    "BI111_T3": "assets/mcq/BI111_T3.js",
    "CS110_T1": "assets/mcq/CS110_T1.js",
    "CS110_T2": "assets/mcq/CS110_T2.js",
    "CS110_T3": "assets/mcq/CS110_T3.js",
    "CH110_T1": "assets/mcq/CH110_T1.js",
    "CH110_T2": "assets/mcq/CH110_T2.js",
    "CH110_T3": "assets/mcq/CH110_T3.js",
    "PH110_T1": "assets/mcq/PH110_T1.js",
    "PH110_T2": "assets/mcq/PH110_T2.js",
    "PH110_T3": "assets/mcq/PH110_T3.js",
    "MA110_T1": "assets/mcq/MA110_T1.js",
    "MA110_T2": "assets/mcq/MA110_T2.js",
    "MA110_T3": "assets/mcq/MA110_T3.js",
    "LA111_T1": "assets/mcq/LA111_T1.js",
    "LA111_T2": "assets/mcq/LA111_T2.js",
    "LA111_T3": "assets/mcq/LA111_T3.js",
    // --- GEOLOGY YEARS 2-5 ---
    "CH210_T1": "assets/mcq/CH210_T1.js",
    "CH210_T2": "assets/mcq/CH210_T2.js",
    "CH210_T3": "assets/mcq/CH210_T3.js",
    "GM220_T1": "assets/mcq/GM220_T1.js",
    "GM220_T2": "assets/mcq/GM220_T2.js",
    "GM220_T3": "assets/mcq/GM220_T3.js",
    "MA210_T1": "assets/mcq/MA210_T1.js",
    "MA210_T2": "assets/mcq/MA210_T2.js",
    "MA210_T3": "assets/mcq/MA210_T3.js",
    "MI213_T1": "assets/mcq/MI213_T1.js",
    "MI213_T2": "assets/mcq/MI213_T2.js",
    "MI213_T3": "assets/mcq/MI213_T3.js",
    "MT221_T1": "assets/mcq/MT221_T1.js",
    "MT221_T2": "assets/mcq/MT221_T2.js",
    "MT221_T3": "assets/mcq/MT221_T3.js",
    "PH210_T1": "assets/mcq/PH210_T1.js",
    "PH210_T2": "assets/mcq/PH210_T2.js",
    "PH210_T3": "assets/mcq/PH210_T3.js",
    "GM310_T1": "assets/mcq/GM310_T1.js",
    "GM310_T2": "assets/mcq/GM310_T2.js",
    "GM310_T3": "assets/mcq/GM310_T3.js",
    "GM311_T1": "assets/mcq/GM311_T1.js",
    "GM311_T2": "assets/mcq/GM311_T2.js",
    "GM311_T3": "assets/mcq/GM311_T3.js",
    "GM312_T1": "assets/mcq/GM312_T1.js",
    "GM312_T2": "assets/mcq/GM312_T2.js",
    "GM312_T3": "assets/mcq/GM312_T3.js",
    "GM313_T1": "assets/mcq/GM313_T1.js",
    "GM313_T2": "assets/mcq/GM313_T2.js",
    "GM313_T3": "assets/mcq/GM313_T3.js",
    "GM314_T1": "assets/mcq/GM314_T1.js",
    "GM314_T2": "assets/mcq/GM314_T2.js",
    "GM314_T3": "assets/mcq/GM314_T3.js",
    "GM315_T1": "assets/mcq/GM315_T1.js",
    "GM315_T2": "assets/mcq/GM315_T2.js",
    "GM315_T3": "assets/mcq/GM315_T3.js",
    "GM320_T1": "assets/mcq/GM320_T1.js",
    "GM320_T2": "assets/mcq/GM320_T2.js",
    "GM320_T3": "assets/mcq/GM320_T3.js",
    "GM321_T1": "assets/mcq/GM321_T1.js",
    "GM321_T2": "assets/mcq/GM321_T2.js",
    "GM321_T3": "assets/mcq/GM321_T3.js",
    "GM410_T1": "assets/mcq/GM410_T1.js",
    "GM410_T2": "assets/mcq/GM410_T2.js",
    "GM410_T3": "assets/mcq/GM410_T3.js",
    "GM411_T1": "assets/mcq/GM411_T1.js",
    "GM411_T2": "assets/mcq/GM411_T2.js",
    "GM411_T3": "assets/mcq/GM411_T3.js",
    "GM412_T1": "assets/mcq/GM412_T1.js",
    "GM412_T2": "assets/mcq/GM412_T2.js",
    "GM412_T3": "assets/mcq/GM412_T3.js",
    "GM420_T1": "assets/mcq/GM420_T1.js",
    "GM420_T2": "assets/mcq/GM420_T2.js",
    "GM420_T3": "assets/mcq/GM420_T3.js",
    "GM430_T1": "assets/mcq/GM430_T1.js",
    "GM430_T2": "assets/mcq/GM430_T2.js",
    "GM430_T3": "assets/mcq/GM430_T3.js",
    "GM440_T1": "assets/mcq/GM440_T1.js",
    "GM440_T2": "assets/mcq/GM440_T2.js",
    "GM440_T3": "assets/mcq/GM440_T3.js",
    "GM500_T1": "assets/mcq/GM500_T1.js",
    "GM500_T2": "assets/mcq/GM500_T2.js",
    "GM500_T3": "assets/mcq/GM500_T3.js",
    "GM512_T1": "assets/mcq/GM512_T1.js",
    "GM512_T2": "assets/mcq/GM512_T2.js",
    "GM512_T3": "assets/mcq/GM512_T3.js",
    "GM520_T1": "assets/mcq/GM520_T1.js",
    "GM520_T2": "assets/mcq/GM520_T2.js",
    "GM520_T3": "assets/mcq/GM520_T3.js",
    "GM521_T1": "assets/mcq/GM521_T1.js",
    "GM521_T2": "assets/mcq/GM521_T2.js",
    "GM521_T3": "assets/mcq/GM521_T3.js",
    "GM522_T1": "assets/mcq/GM522_T1.js",
    "GM522_T2": "assets/mcq/GM522_T2.js",
    "GM522_T3": "assets/mcq/GM522_T3.js",
    "GM523_T1": "assets/mcq/GM523_T1.js",
    "GM523_T2": "assets/mcq/GM523_T2.js",
    "GM523_T3": "assets/mcq/GM523_T3.js",
    "GM524_T1": "assets/mcq/GM524_T1.js",
    "GM524_T2": "assets/mcq/GM524_T2.js",
    "GM524_T3": "assets/mcq/GM524_T3.js",
    "GM531_T1": "assets/mcq/GM531_T1.js",
    "GM531_T2": "assets/mcq/GM531_T2.js",
    "GM531_T3": "assets/mcq/GM531_T3.js"
};

const _mcqCache = {};

function loadMcqForTermKey(termKey) {
    return new Promise(function (resolve) {
        if (_mcqCache[termKey]) { resolve(_mcqCache[termKey]); return; }

        const path = MCQ_MANIFEST[termKey];
        if (!path) { _mcqCache[termKey] = []; resolve([]); return; }

        const existing = document.querySelector('script[data-mcq-term="' + termKey + '"]');
        if (existing) {
            existing.addEventListener('load', function () { resolve(_mcqCache[termKey] || []); });
            existing.addEventListener('error', function () { resolve([]); });
            return;
        }

        const script = document.createElement('script');
        script.src = path;
        script.setAttribute('data-mcq-term', termKey);
        script.onload = function () {
            window.__MCQ__ = window.__MCQ__ || {};
            const raw = window.__MCQ__[termKey] || [];
            const usable = raw.filter(function (q) {
                return !q.flagged && (q.status === undefined || q.status === 'approved');
            });
            _mcqCache[termKey] = usable;
            _setModeFailed(termKey, 'mcq', false);
            resolve(usable);
        };
        script.onerror = function () {
            script.remove();
            // A file that fails to load is treated as "no data" (hidden, no retry) unless the device is
            // genuinely offline - the only case where retrying can help.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                _setModeFailed(termKey, 'mcq', true);
            } else {
                _mcqCache[termKey] = [];
                _setModeFailed(termKey, 'mcq', false);
            }
            resolve([]);
        };
        document.head.appendChild(script);
    });
}

// ── ESSAY PER-TERM LOADER ───────────────────────────────────
// Essay simulations load from assets/terms/<COURSE>_<TERM>.js, which self-registers on
// window.__TERM__[termKey].essay (course / term / year are implicit, not on the items).
// If a term has no file (or no essay in it), fall back to the legacy global essayData.
const _essayTermCache = {};

function loadEssayForTermKey(termKey, course, term) {
    return new Promise(function (resolve) {
        if (_essayTermCache[termKey]) { resolve(_essayTermCache[termKey]); return; }

        function finish(offlineFail) {
            window.__TERM__ = window.__TERM__ || {};
            const raw = (window.__TERM__[termKey] || {}).essay;
            let essays = Array.isArray(raw) ? raw : [];
            if (essays.length === 0) {
                essays = filterDataByCourseAndTerm(typeof essayData !== 'undefined' ? essayData : [], course, term);
            }
            if (offlineFail === true) { _setModeFailed(termKey, 'essay', true); }   // offline ≠ empty: don't cache
            else { _essayTermCache[termKey] = essays; _setModeFailed(termKey, 'essay', false); }
            resolve(essays);
        }

        const existing = document.querySelector('script[data-term="' + termKey + '"]');
        if (existing) {
            if (existing.getAttribute('data-done')) { finish(); return; }
            existing.addEventListener('load', finish);
            existing.addEventListener('error', finish);
            return;
        }

        const script = document.createElement('script');
        script.src = 'assets/terms/' + termKey + '.js';
        script.setAttribute('data-term', termKey);
        script.onload  = function () { script.setAttribute('data-done', '1'); finish(); };
        script.onerror = function () {
            // A missing file is normal (term has no essays yet); being offline is a failed load.
            if (!navigator.onLine) { script.remove(); finish(true); return; }
            script.setAttribute('data-done', '1'); finish();
        };
        document.head.appendChild(script);
    });
}

// ── FLASHCARD PER-TERM LOADER ───────────────────────────────
// Flashcards load from assets/flashcards/<COURSE>_<TERM>.js (one independent file per term), which
// self-registers on window.__FLASHCARDS__[termKey] as { "Parent: Child": [ {front, back}, … ] }.
// Course / term are implicit in the file name. Topic names are the SRS keys — never rename them.
// If a term has no file (or it is empty), fall back to the legacy global `flashcards` object.
const _flashcardTermCache = {};

function loadFlashcardsForTermKey(termKey, course, term) {
    return new Promise(function (resolve) {
        if (_flashcardTermCache[termKey]) { resolve(_flashcardTermCache[termKey]); return; }

        function finish(offlineFail) {
            window.__FLASHCARDS__ = window.__FLASHCARDS__ || {};
            const raw = window.__FLASHCARDS__[termKey];
            let topics = (raw && typeof raw === 'object') ? raw : {};
            if (Object.keys(topics).length === 0) {
                topics = filterFlashcardsByCourseAndTerm(
                    (typeof allFlashcards !== 'undefined') ? allFlashcards : {}, course, term);
            }
            if (offlineFail === true) { _setModeFailed(termKey, 'flashcard', true); }   // offline ≠ empty: don't cache
            else { _flashcardTermCache[termKey] = topics; _setModeFailed(termKey, 'flashcard', false); }
            resolve(topics);
        }

        const existing = document.querySelector('script[data-fc-term="' + termKey + '"]');
        if (existing) {
            if (existing.getAttribute('data-done')) { finish(); return; }
            existing.addEventListener('load', finish);
            existing.addEventListener('error', finish);
            return;
        }

        const script = document.createElement('script');
        script.src = 'assets/flashcards/' + termKey + '.js';
        script.setAttribute('data-fc-term', termKey);
        script.onload  = function () { script.setAttribute('data-done', '1'); finish(); };
        script.onerror = function () {
            // A missing file is normal (term has no flashcards yet); being offline is a failed load.
            if (!navigator.onLine) { script.remove(); finish(true); return; }
            script.setAttribute('data-done', '1'); finish();
        };
        document.head.appendChild(script);
    });
}

// ── MODE AVAILABILITY (data-driven kill switch) ────────────
// A study-mode button exists only while the current course/term has data for that mode.
// Add the data file → the mode appears on the next load. No code change, no "soon" labels.
// _modeLoadFailed marks a FAILED load (offline / manifest file unreachable) so a network
// problem is never mistaken for "no data": a failed mode stays visible and is retried.
const _modeLoadFailed = {};   // termKey → { mcq, essay, flashcard, documents }
const _docsCache = {};        // termKey → documents list from the Gatekeeper ([] = this term has none)
const _videosCache = {};      // termKey → videos list from the Gatekeeper ([] = this term has none)

// Terms that have content but no MCQ file (e.g. documents only). Add "COURSE_TERM": true here;
// everything else is judged by MCQ_MANIFEST. Leave empty until you need it.
const EXTRA_TERMS = {};
const _MODE_FNS = ['renderQuiz', 'renderShortAnswers', 'renderEssaySimulation', 'renderFlashcardTopics'];

// While a term's modes are still loading, the mode grid shows the app's own shimmering skeleton
// (the .skeleton class used by the Documents library) instead of sitting empty.
let _modesLoading = false;       // true from the moment a term is tapped until its data is confirmed
let _docsPendingFor = null;      // termKey whose Documents list is still being fetched

// IMPORTANT: must stay idempotent — it removes any existing tiles first and rebuilds from state, because
// it is called from hideModeButtons, applyModeAvailability, _loadDocsAvailability and the retry paths.
function _renderModeSkeleton() {
    const grid = document.querySelector('.mode-buttons');
    if (!grid) return;
    grid.querySelectorAll('.mode-skel').forEach(function (el) { el.remove(); });
    const docsPending = !_modesLoading && !!_docsPendingFor && _docsPendingFor === currentTermKey;
    if (_modesLoading || docsPending) grid.setAttribute('aria-busy', 'true'); else grid.removeAttribute('aria-busy');

    function tile(first) {
        const t = document.createElement('div');
        t.className = 'skeleton mode-skel';
        t.setAttribute('aria-hidden', 'true');
        // Appended (never prepended) so the positional insert of the Documents button in
        // initializeCourseLogic (children[1]) still lands on the right slot; order:-1 draws them first.
        t.style.cssText = 'height:52px; min-height:52px; width:100%; border-radius:8px;' + (first ? ' order:-1;' : '');
        return t;
    }
    if (_modesLoading) {
        for (let i = 0; i < 4; i++) grid.appendChild(tile(true));
    } else if (docsPending) {
        // One tile in the Documents button's own slot until its list is known.
        const docsBtn = document.getElementById('docs-btn');
        if (docsBtn && docsBtn.parentNode === grid) grid.insertBefore(tile(false), docsBtn);
        else grid.appendChild(tile(false));
    }
}

function _setModeFailed(termKey, kind, val) {
    (_modeLoadFailed[termKey] = _modeLoadFailed[termKey] || {})[kind] = !!val;
}

function _modeAvailability() {
    const f = _modeLoadFailed[currentTermKey] || {};
    return {
        renderQuiz:            (currentMcqData || []).length > 0 || !!f.mcq,
        renderShortAnswers:    (currentShortData || []).length > 0,
        renderEssaySimulation: (currentEssayData || []).length > 0 || !!f.essay,
        renderFlashcardTopics: Object.keys(currentFlashcardTopics || {}).length > 0 || !!f.flashcard,
        renderDocuments:       (_docsCache[currentTermKey] || []).length > 0 || !!f.documents,
        renderVideos:          (_videosCache[currentTermKey] || []).length > 0
    };
}

function _modeFnOf(btn) {
    const m = (btn.getAttribute('onclick') || '').match(/^\s*(\w+)\s*\(/);
    return (m && _MODE_FNS.indexOf(m[1]) !== -1) ? m[1] : null;
}

// Dark the instant a term is tapped, until its data confirms what exists.
function hideModeButtons() {
    document.querySelectorAll('.mode-buttons button[onclick]').forEach(function (btn) {
        if (_modeFnOf(btn)) btn.style.display = 'none';
    });
    const docsBtn = document.getElementById('docs-btn');
    if (docsBtn) docsBtn.style.display = 'none';
    const videosBtn = document.getElementById('videos-btn');
    if (videosBtn) videosBtn.style.display = 'none';
    _modesLoading = true;
    _docsPendingFor = null;
    _setTermEmpty(false);
    _renderModeSkeleton();
}

// "Content coming soon": shown only once EVERY data source for the term is settled and none has content.
function _setTermEmpty(on) {
    document.body.classList.toggle('term-empty', !!on);
    const box = document.getElementById('coming-soon');
    if (!box) return;
    box.style.display = on ? 'block' : 'none';
    if (!on) return;
    const t = String(currentTerm || '').replace(/^T/i, '');
    const label = document.getElementById('coming-soon-label');
    if (label) label.textContent = (currentCourse || '') + ' · Term ' + t;
    const ch = document.getElementById('coming-soon-channel');
    if (ch && typeof COMMUNITY_CONFIG !== 'undefined') ch.href = COMMUNITY_CONFIG.channel;
    try { window.scrollTo(0, 0); } catch (e) {}
}

function applyModeAvailability() {
    const has = _modeAvailability();
    document.querySelectorAll('.mode-buttons button[onclick]').forEach(function (btn) {
        const fn = _modeFnOf(btn);
        if (fn) btn.style.display = has[fn] ? '' : 'none';
    });
    const docsBtn = document.getElementById('docs-btn');
    if (docsBtn) docsBtn.style.display = has.renderDocuments ? '' : 'none';
    const videosBtn = document.getElementById('videos-btn');
    if (videosBtn) videosBtn.style.display = has.renderVideos ? '' : 'none';
    _modesLoading = false;
    // Settled = the documents list is known (even if empty) or its load failed (failed never counts as empty).
    const f = _modeLoadFailed[currentTermKey] || {};
    const docsSettled = Array.isArray(_docsCache[currentTermKey]) || !!f.documents;
    const videosSettled = Array.isArray(_videosCache[currentTermKey]) || !!f.videos;   // a video-only term must not flash "coming soon"
    const anyContent = Object.keys(has).some(function (k) { return has[k]; });
    _setTermEmpty(docsSettled && videosSettled && !anyContent);
    _renderModeSkeleton();
}

// "Switch Learning Mode" panels on finish screens: drop modes with no data.
// Returns true when at least one button is left (caller appends the panel only then).
function _pruneSwitchPanel(panel) {
    const has = _modeAvailability();
    let left = 0;
    panel.querySelectorAll('button[onclick]').forEach(function (btn) {
        const fn = _modeFnOf(btn);
        if (fn && !has[fn]) btn.remove(); else left++;
    });
    return left > 0;
}

// Progress dashboard: keep a row when the mode has data now OR the student has history in it.
function _dashModeVisible(fn, historical) {
    return !!_modeAvailability()[fn] || Number(historical) > 0;
}

// Documents live on the Gatekeeper, so availability needs one network call per term.
// Resolves to the list, or null when the request itself failed (network / bad response).
async function _fetchDocsForTerm(termKey, course, term) {
    if (_docsCache[termKey]) return _docsCache[termKey];
    try {
        const response = await fetch(DOCS_SCRIPT_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'GET_STUDENT_DOCS', course: course, term: term })
        });
        if (!response.ok) throw new Error('docs http ' + response.status);
        const data = await response.json();
        const list = (data && data.success)
            ? (data.documents || (data.data && data.data.documents) || [])
            : [];
        _docsCache[termKey] = list;
        _setModeFailed(termKey, 'documents', false);
        return list;
    } catch (e) {
        _setModeFailed(termKey, 'documents', true);   // failed ≠ empty: button stays, retry below
        return null;
    }
}

async function _loadDocsAvailability(termKey, course, term, attempt) {
    attempt = attempt || 1;
    if (!_docsCache[termKey]) { _docsPendingFor = termKey; _renderModeSkeleton(); }   // one shimmer tile until Documents is known
    const list = await _fetchDocsForTerm(termKey, course, term);
    if (_docsPendingFor === termKey) _docsPendingFor = null;
    if (currentTermKey !== termKey) return;
    applyModeAvailability();
    if (list === null && attempt < 3) {
        setTimeout(function () {
            if (currentTermKey === termKey) _loadDocsAvailability(termKey, course, term, attempt + 1);
        }, 6000);
    }
}

// Videos live on the Gatekeeper too (separate "Videos" sheet). Same contract as documents:
// resolves to the list, or null when the request itself failed. The last good list is kept on the
// device so the Videos button and the saved (offline) videos still work without a connection.
async function _fetchVideosForTerm(termKey, course, term) {
    const failed = !!(_modeLoadFailed[termKey] && _modeLoadFailed[termKey].videos);
    if (_videosCache[termKey] && !failed) return _videosCache[termKey];
    try {
        const response = await fetch(DOCS_SCRIPT_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'GET_STUDENT_VIDEOS', course: course, term: term })
        });
        if (!response.ok) throw new Error('videos http ' + response.status);
        const data = await response.json();
        if (!data || !data.success) throw new Error('videos not ok');
        const list = (data.data && data.data.videos) || data.videos || [];
        _videosCache[termKey] = list;
        _setModeFailed(termKey, 'videos', false);
        try { localStorage.setItem('kaeri_videos_' + termKey, JSON.stringify(list)); } catch (e) {}
        return list;
    } catch (e) {
        _setModeFailed(termKey, 'videos', true);
        try {
            const saved = JSON.parse(localStorage.getItem('kaeri_videos_' + termKey) || 'null');
            if (Array.isArray(saved)) _videosCache[termKey] = saved;
        } catch (err) {}
        return null;
    }
}

async function _loadVideosAvailability(termKey, course, term, attempt) {
    attempt = attempt || 1;
    const list = await _fetchVideosForTerm(termKey, course, term);
    if (currentTermKey !== termKey) return;
    applyModeAvailability();
    if (list === null && attempt < 3) {
        setTimeout(function () {
            if (currentTermKey === termKey) _loadVideosAvailability(termKey, course, term, attempt + 1);
        }, 6000);
    }
}

// A failed load must not read as "empty": show a retrying note instead of the empty-state text.
function _emptyOrRetrying(kind, emptyHtml) {
    const f = _modeLoadFailed[currentTermKey] || {};
    return f[kind]
        ? '<h3>📡 Still loading</h3><p style="color:#a0a8b4;">Connection issue — retrying automatically…</p>'
        : emptyHtml;
}

// A failed load (not an empty one) retries quietly a few times, then the mode reveals itself.
function _healFailedLoads(termKey, attempt) {
    attempt = attempt || 1;
    const f = _modeLoadFailed[termKey];
    if (!f || !(f.mcq || f.essay || f.flashcard) || attempt > 3) return;
    setTimeout(async function () {
        if (currentTermKey !== termKey) return;
        const course = currentCourse, term = currentTerm;
        const mcq = f.mcq       ? await loadMcqForTermKey(termKey) : null;
        const es  = f.essay     ? await loadEssayForTermKey(termKey, course, term) : null;
        const fc  = f.flashcard ? await loadFlashcardsForTermKey(termKey, course, term) : null;
        if (currentTermKey !== termKey) return;   // moved to another term mid-retry: drop the results
        if (mcq) currentMcqData         = mcq;
        if (es)  currentEssayData       = es;
        if (fc)  currentFlashcardTopics = fc;
        applyModeAvailability();
        _healFailedLoads(termKey, attempt + 1);
    }, 6000);
}

// Disable any term button whose dataset file is not yet in the manifest.
function hideUnavailableTerms() {
    document.querySelectorAll('.term-buttons button').forEach(function (btn) {
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/loadCourse\('(\w+)',\s*'(\w+)'/);
        if (!m) return;
        const key = m[1] + '_' + m[2];
        if (!MCQ_MANIFEST[key] && !EXTRA_TERMS[key]) {
            btn.disabled = true;
            btn.style.display = 'none';   // no dataset → no button (no "soon" label)
        }
    });
    // Course level: no visible term → no course button (same rule, one level up).
    document.querySelectorAll('.course-section').forEach(function (sec) {
        const terms = sec.querySelectorAll('.term-buttons button');
        const anyVisible = Array.prototype.some.call(terms, function (b) { return b.style.display !== 'none'; });
        if (terms.length > 0 && !anyVisible) sec.style.display = 'none';
    });
}

function loadGlobalData() {
    // MCQ is loaded per-term via the manifest (see loadMcqForTermKey).
    // Short Answer, Essay, and Flashcards keep their legacy global arrays.
    allShortData  = typeof shortData  !== 'undefined' ? shortData  : [];
    allEssayData  = typeof essayData  !== 'undefined' ? essayData  : [];
    allFlashcards = typeof flashcards !== 'undefined' ? flashcards : {};
}

async function initializeCourseLogic() {
    loadGlobalData();
    
    // Initialize TTS
    ttsEnabled = ttsSupported && localStorage.getItem("ttsEnabled") === "true";
    const modeButtonsDiv = document.querySelector('.mode-buttons');
    
    if (modeButtonsDiv) {
        // Add TTS Button if missing
        if (!document.getElementById('tts-toggle-button')) {
            const ttsButton = document.createElement('button');
            ttsButton.id = 'tts-toggle-button';
            ttsButton.onclick = toggleTTS;
            modeButtonsDiv.appendChild(ttsButton);
            updateTtsButtonText();
        }
        // Reader settings (voice + speed) next to the toggle
        if (ttsSupported && !document.getElementById('tts-settings-button')) {
            const ttsSettingsBtn = document.createElement('button');
            ttsSettingsBtn.id = 'tts-settings-button';
            ttsSettingsBtn.textContent = '🎛️ Reader Settings';
            ttsSettingsBtn.onclick = openTtsSettings;
            modeButtonsDiv.appendChild(ttsSettingsBtn);
        }
        
        // Add Progress Dashboard Button if missing
        if (!document.getElementById('progress-btn')) {
            const progressBtn = document.createElement('button');
            progressBtn.id = 'progress-btn';
            progressBtn.innerHTML = "\uD83D\uDCCA My Progress";
            progressBtn.style.backgroundColor = "#6f42c1";
            progressBtn.style.color = "white";
            progressBtn.style.border = "none";
            progressBtn.style.padding = "15px 20px";
            progressBtn.style.fontSize = "1.1em";
            progressBtn.style.borderRadius = "8px";
            progressBtn.style.boxShadow = "0 4px 8px rgba(0,0,0,0.2)";
            progressBtn.style.cursor = "pointer";
            progressBtn.onclick = renderProgressDashboard;
            modeButtonsDiv.appendChild(progressBtn);
        }

        // Add Document Button if missing
        if (!document.getElementById('docs-btn')) {
            const docBtn = document.createElement('button');
            docBtn.id = 'docs-btn';
            docBtn.style.display = 'none';   // revealed by applyModeAvailability() once the term has documents
            docBtn.innerHTML = "📂 Course Documents";
            docBtn.style.backgroundColor = "#28a745"; 
            docBtn.style.color = "white";
            docBtn.style.border = "none";
            docBtn.style.padding = "15px 20px";
            docBtn.style.fontSize = "1.1em";
            docBtn.style.borderRadius = "8px";
            docBtn.style.boxShadow = "0 4px 8px rgba(0,0,0,0.2)";
            docBtn.style.cursor = "pointer";
            docBtn.onclick = renderDocuments;

            // Insert as second button
            if (modeButtonsDiv.children.length > 1) {
                modeButtonsDiv.insertBefore(docBtn, modeButtonsDiv.children[1]);
            } else {
                modeButtonsDiv.appendChild(docBtn);
            }
        }

        // Add Video Button if missing (sits right after Documents)
        if (!document.getElementById('videos-btn')) {
            const vidBtn = document.createElement('button');
            vidBtn.id = 'videos-btn';
            vidBtn.style.display = 'none';   // revealed by applyModeAvailability() once the term has videos
            vidBtn.innerHTML = "📺 Course Videos";
            vidBtn.style.backgroundColor = "#dc3545";
            vidBtn.style.color = "white";
            vidBtn.style.border = "none";
            vidBtn.style.padding = "15px 20px";
            vidBtn.style.fontSize = "1.1em";
            vidBtn.style.borderRadius = "8px";
            vidBtn.style.boxShadow = "0 4px 8px rgba(0,0,0,0.2)";
            vidBtn.style.cursor = "pointer";
            vidBtn.onclick = renderVideos;

            const afterDocs = document.getElementById('docs-btn');
            if (afterDocs && afterDocs.parentNode === modeButtonsDiv) {
                modeButtonsDiv.insertBefore(vidBtn, afterDocs.nextSibling);
            } else {
                modeButtonsDiv.appendChild(vidBtn);
            }
        }
    }

    // Context Setup
    const body = document.body;
    currentCourse = body.getAttribute('data-course');
    currentTerm = body.getAttribute('data-term');
    currentTermKey = `${currentCourse}_${currentTerm}`;

    // Filter Data — MCQ loads per-term from the manifest; the others use legacy globals.
    currentMcqData         = await loadMcqForTermKey(currentTermKey);
    currentShortData       = filterDataByCourseAndTerm(allShortData, currentCourse, currentTerm);
    currentEssayData       = await loadEssayForTermKey(currentTermKey, currentCourse, currentTerm);
    currentFlashcardTopics = await loadFlashcardsForTermKey(currentTermKey, currentCourse, currentTerm);

    // Mode kill switch: a study mode shows only when this course/term has data for it.
    applyModeAvailability();
    _healFailedLoads(currentTermKey);
    _loadDocsAvailability(currentTermKey, currentCourse, currentTerm);   // background; Documents appears when the list is non-empty
    _loadVideosAvailability(currentTermKey, currentCourse, currentTerm); // background; Videos appears when the list is non-empty

    // Inject Viewer HTML if missing
    if (!document.getElementById('smart-doc-viewer')) {
        injectDocViewerHTML();
    }

    // Security Check
    await checkAccessStatus();
}
// ============================================================
// === 2. UNIVERSAL RENDERING ENGINE (KaTeX) ===
// ============================================================

function renderMath(targetId = null) {
    if (typeof renderMathInElement !== 'function') return;

    const renderOptions = {
        delimiters: [
            {left: "$$", right: "$$", display: true},
            {left: "$", right: "$", display: false},
            {left: "\\(", right: "\\)", display: false},
            {left: "\\[", right: "\\]", display: true}
        ],
        throwOnError: false
    };

    if (targetId) {
        const el = document.getElementById(targetId);
        if (el) renderMathInElement(el, renderOptions);
    } else {
        const form = document.getElementById("quiz-form");
        const result = document.getElementById("result");
        if (form) renderMathInElement(form, renderOptions);
        if (result) renderMathInElement(result, renderOptions);
    }
}

// ============================================================
// === 3. DOCUMENT DELIVERY ENGINE (FROM BASE A - PRESERVED) ===
// === v1.2 PATCH: instant shimmer on tap; verify in background; then load iframe ===
// ============================================================

function injectDocViewerHTML() {
    if (document.getElementById('smart-doc-viewer')) return;
    
    const viewerHTML = `
    <div id="smart-doc-viewer" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.95); z-index:9999; align-items:center; justify-content:center; backdrop-filter:blur(5px);">
        <div style="background:#1a1a2e; width:95%; height:95%; border-radius:15px; padding:0; display:flex; flex-direction:column; box-shadow:0 10px 40px rgba(0,0,0,0.5); border:2px solid #72efdd; overflow:hidden; position:relative;">
            
            <!-- Header -->
            <div style="display:flex; justify-content:space-between; align-items:center; padding:15px 20px; background:#0d1b2a; border-bottom:1px solid #3e506e; height:50px; box-sizing:border-box;">
                <h3 id="viewer-title" style="color:white; margin:0; font-size:1.1em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:70%;">Document</h3>
                <button onclick="closeDocViewer()" style="background:#dc3545; color:white; border:none; padding:6px 15px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:0.9em;">✕ Close</button>
            </div>

            <!-- Loading Skeleton Overlay (Visible initially) -->
            <div id="doc-loader-overlay" class="viewer-loader">
                <div class="viewer-skeleton-box"></div>
                <p id="doc-loader-text" style="color:#72efdd; margin-top:20px; font-size:0.9em;">Verifying access...</p>
                <!-- Download progress (shown only while a file is being downloaded) -->
                <div id="doc-progress-wrap" style="display:none; width:80%; max-width:420px; margin-top:12px; text-align:center;">
                    <div class="dp-track"><div id="doc-progress-fill" class="dp-fill"></div></div>
                    <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:0.8em; color:#a0a8b4;">
                        <span id="doc-progress-pct">0%</span>
                        <span id="doc-progress-detail"></span>
                    </div>
                    <button onclick="closeDocViewer()" style="margin-top:10px; background:transparent; color:#a0a8b4; border:1px solid #3e506e; padding:5px 14px; border-radius:6px; cursor:pointer; font-size:0.8em;">Cancel</button>
                </div>
            </div>

            <!-- PDF.js canvas container (pages are drawn here) -->
            <div id="pdf-canvas-container" style="flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; align-items:center; background:#222; gap:15px;">
                <!-- PDF.js will inject <canvas> elements here -->
            </div>
            
            <!-- Document voice reader (TTS) -->
            <style>
                .dp-track { height:10px; background:#2b3a55; border-radius:6px; overflow:hidden; }
                .dp-fill { height:100%; width:0%; background:linear-gradient(90deg,#72efdd,#4ea8de); border-radius:6px; transition:width .25s ease; }
                #doc-reader-bar .dr-row { display:flex; align-items:center; justify-content:center; flex-wrap:wrap; gap:6px; padding:8px 10px; }
                #doc-reader-bar .dr-btn { min-width:40px; height:38px; padding:0 10px; border-radius:8px; border:1px solid #3e506e; background:#1a1a2e; color:#fff; font-size:1em; cursor:pointer; }
                #doc-reader-bar .dr-btn:disabled { opacity:.4; cursor:default; }
                #doc-reader-bar .dr-primary { background:#72efdd; color:#0d1b2a; border-color:#72efdd; font-weight:bold; min-width:46px; }
                #doc-reader-bar .dr-page { color:#e0e6ed; font-size:.85em; min-width:84px; text-align:center; }
                #doc-reader-bar .dr-status { color:#72efdd; font-size:.8em; }
                #doc-reader-bar .dr-chip { border:1px solid #3e506e; background:#1a1a2e; color:#72efdd; border-radius:14px; padding:4px 12px; font-size:.75em; cursor:pointer; }
                #doc-reader-bar .dr-chip.off { color:#a0a8b4; }
                #doc-reader-bar .dr-set label { display:block; color:#a0a8b4; font-size:.8em; margin:8px 0 4px; }
                #doc-reader-bar .dr-set select { width:100%; padding:9px; border-radius:8px; background:#1a1a2e; color:#fff; border:1px solid #3e506e; }
                #doc-reader-bar .dr-set input[type=range] { width:100%; }
                @media (max-width:480px) { #doc-reader-bar .dr-status { display:none; } }
            </style>
            <div id="doc-reader-bar" style="display:none; background:#0d1b2a; border-top:1px solid #3e506e;">
                <div id="doc-reader-settings" class="dr-set" style="display:none; padding:6px 14px 10px; border-bottom:1px solid #3e506e;">
                    <label for="dr-voice">Voice</label>
                    <select id="dr-voice" onchange="setTtsVoice(this.value)"></select>
                    <label for="dr-rate">Speed: <span id="dr-rate-label">1×</span></label>
                    <input type="range" id="dr-rate" min="0.5" max="2" step="0.25" value="1" oninput="setTtsRate(this.value); _docReaderSyncUi();">
                    <div style="color:#7d8797; font-size:.72em; margin-top:6px;">Voice and speed changes apply from the next sentence.</div>
                    <div id="dr-furn-list"></div>
                </div>
                <div id="dr-furn-row" style="display:none; text-align:center; padding:6px 10px 0;">
                    <button id="dr-furn" class="dr-chip" onclick="docReaderToggleFurniture()"></button>
                </div>
                <div class="dr-row">
                    <button id="dr-play" class="dr-btn dr-primary" onclick="docReaderToggle()" aria-label="Read aloud">▶</button>
                    <button id="dr-prev" class="dr-btn" onclick="docReaderStep(-1)" aria-label="Previous page">⏮</button>
                    <span id="dr-page" class="dr-page">Page 1 / 1</span>
                    <button id="dr-next" class="dr-btn" onclick="docReaderStep(1)" aria-label="Next page">⏭</button>
                    <button id="dr-stop" class="dr-btn" onclick="docReaderStop()" aria-label="Stop reading" disabled>⏹</button>
                    <button id="dr-speed" class="dr-btn" onclick="docReaderCycleSpeed()" aria-label="Reading speed">1×</button>
                    <button class="dr-btn" onclick="docReaderToggleSettings()" aria-label="Reader settings">🎛️</button>
                    <span id="dr-status" class="dr-status">🎧 Read aloud</span>
                </div>
            </div>

            <div style="text-align:center; color:#888; font-size:0.75em; padding:5px; background:#0d1b2a; border-top:1px solid #3e506e;">
                Protected Content - Kaeri EdTech
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', viewerHTML);
}

// ── Stage 1: show the modal + shimmer skeleton IMMEDIATELY (instant feedback on tap) ──
function showDocViewerLoading(title) {
    const viewer = document.getElementById('smart-doc-viewer');
    const container = document.getElementById('pdf-canvas-container');
    const titleEl = document.getElementById('viewer-title');
    const loader = document.getElementById('doc-loader-overlay');
    const loaderText = document.getElementById('doc-loader-text');
    
    if (!viewer || !container) {
        injectDocViewerHTML();
        setTimeout(() => showDocViewerLoading(title), 50);
        return;
    }
    
    titleEl.textContent = title || "Document";
    container.innerHTML = "";                             // Clear previous to prevent ghosting
    _docResetUi();                                        // clear progress bar + voice reader from any previous document
    if (loaderText) loaderText.textContent = 'Verifying access...';
    if (loader) loader.style.display = 'flex';            // Show shimmer right now
    viewer.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

// ── Offline document cache (IndexedDB) ──
const OFFLINE_DB_NAME = 'kaeri_offline_docs';
const STORE_NAME = 'documents';

function getDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB not supported')); return; }
        const req = indexedDB.open(OFFLINE_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

let _lastOfflineError = null;      // why the last save failed (e.g. QuotaExceededError), for the student-facing message

/** Read an offline entry. Returns an ArrayBuffer (new format), a Base64 string (older saves) or null. */
async function getOfflineDoc(key) {
    let db = null;
    try {
        db = await getDb();
        return await new Promise((resolve) => {
            const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
    finally { try { if (db) db.close(); } catch (e) {} }
}

/** Save an entry. Returns true only when the browser confirms the write; false (with _lastOfflineError set) otherwise. */
async function saveDocOffline(key, value) {
    let db = null;
    try {
        db = await getDb();
        return await new Promise((resolve) => {
            let tx;
            try {
                tx = db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put(value, key);
            } catch (e) { _lastOfflineError = e; resolve(false); return; }
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => { _lastOfflineError = tx.error; resolve(false); };
            tx.onabort = () => { _lastOfflineError = tx.error; resolve(false); };
        });
    } catch (e) { _lastOfflineError = e; return false; }
    finally { try { if (db) db.close(); } catch (e) {} }
}

/** Base64 -> bytes. Documents are stored as raw bytes: about 25% smaller than the Base64 text. */
function _b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/**
 * Ask the browser to keep this site's offline files. Without this, Chrome treats them as "best effort"
 * and can delete them when the phone runs low on space. Chrome grants it to bookmarked / installed sites.
 */
async function _ensurePersistentStorage() {
    try {
        if (!navigator.storage || !navigator.storage.persist) return false;
        if (navigator.storage.persisted && await navigator.storage.persisted()) return true;
        return !!(await navigator.storage.persist());
    } catch (e) { return false; }
}
window.addEventListener('load', function () { _ensurePersistentStorage(); });   // re-asks on every visit: granted once the site is bookmarked/installed

function _offlineTipOnce() {
    try {
        if (localStorage.getItem('kaeri_persist_tip')) return;
        localStorage.setItem('kaeri_persist_tip', '1');
    } catch (e) {}
    showAppNotification("💡 Tip: bookmark this page or add it to your home screen so your phone keeps your offline documents.", "info", 7000);
}

/** Tell the student what happened after a download: saved, or why not. */
async function _reportOfflineSave(saved) {
    if (saved) {
        const persisted = await _ensurePersistentStorage();
        showAppNotification("✅ Saved. This document now opens offline.", "info", 2500);
        if (!persisted) setTimeout(_offlineTipOnce, 3000);
        return;
    }
    const quota = _lastOfflineError && (_lastOfflineError.name === 'QuotaExceededError' || /quota/i.test(String(_lastOfflineError.message || '')));
    showAppNotification(quota
        ? "⚠️ Your phone is low on storage, so this document could not be saved for offline use. Free some space and open it again."
        : "⚠️ This document could not be saved for offline use. It will download again next time.", "warning", 6000);
}

/** Server replies that really mean "this session is over" (vs. an Apps Script hiccup such as "Validation error"). */
function _isDefinitiveSessionFailure(msg) {
    return /revoked|expired|mismatch|not found|different account|invalid/i.test(String(msg || ''));
}
function _isDefinitiveDenial(v) {
    return !!v && (v.code === 'SESSION_INVALID' || v.code === 'SCOPE_DENIED' ||
        /revoked|expired|mismatch|not found|denied|unavailable|different account/i.test(String(v.message || '')));
}
function _localExpiryValid() {
    const e = parseInt(localStorage.getItem(`expiry_${currentTermKey}`), 10);
    return !!e && Date.now() < e;
}

async function clearOfflineDocs() {
    try {
        const db = await getDb();
        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
        try { db.close(); } catch (e) {}
        try { if ('caches' in window) await caches.delete('kaeri-video-chunks-v1'); } catch (e) {}   // saved video chunks (service worker in script.js)
        console.log("Offline document cache purged.");
    } catch (e) {
        console.error("Failed to clear offline cache", e);
    }
}

// ── Stage 2: render the PDF with PDF.js (only called AFTER verification succeeds) ──
let _docRenderId = 0;   // bumped whenever the viewer closes, so an in-flight render stops itself

async function renderPdfFromBase64(base64Data, title) {
    const container = document.getElementById('pdf-canvas-container');
    const loader = document.getElementById('doc-loader-overlay');
    if (!container) return;
    const myRenderId = ++_docRenderId;
    const _lt = document.getElementById('doc-loader-text');
    if (_lt) _lt.textContent = 'Preparing document...';
    container.innerHTML = ''; // Clear previous document

    try {
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js not loaded');

        // Raw bytes (new offline format) or Base64 text (older saves)
        const bytes = (typeof base64Data === 'string') ? _b64ToBytes(base64Data)
                    : (base64Data instanceof Uint8Array ? base64Data : new Uint8Array(base64Data));

        // Load with PDF.js
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        if (myRenderId !== _docRenderId) return;   // viewer was closed meanwhile
        _docPdf = pdf;
        _docReaderInit(pdf.numPages);              // voice reader becomes available

        // Hide loader, show page count
        if (loader) loader.style.display = 'none';
        const titleEl = document.getElementById('viewer-title');
        if (titleEl) titleEl.textContent = title + ' (' + pdf.numPages + ' pages)';

        // Render every page
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            if (myRenderId !== _docRenderId) return;
            const viewport = page.getViewport({ scale: 1.5 }); // Scale 1.5 makes it readable on mobile

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            canvas.dataset.page = pageNum;
            canvas.style.maxWidth = '100%';
            canvas.style.boxShadow = '0 4px 10px rgba(0,0,0,0.5)';
            canvas.style.background = 'white';
            container.appendChild(canvas);

            await page.render({ canvasContext: context, viewport: viewport }).promise;
        }

        // Fire-and-forget analytics
        logAnalyticsEvent('document_view', `Viewed: ${title}`);
    } catch (err) {
        console.error(err);
        if (myRenderId !== _docRenderId) return;
        if (loader) loader.style.display = 'none';
        container.innerHTML = '<p style="color:#dc3545; text-align:center;">Failed to render PDF. The file might be corrupted or not a PDF.</p>';
    }
}

// ============================================================
// === DOWNLOAD PROGRESS BAR (shown while a PDF downloads) ===
// The server work (reading the file from Drive) sends no bytes, so that wait is an
// estimate that creeps towards 30%. The transfer itself is real: bytes received vs the
// expected size. Everything is capped at 96% until the file has fully arrived.
// ============================================================
let _docAbort = null;
let _docProgTimer = null;
const _docProg = { shown: 0, stage: 'idle', start: 0, got: 0, total: 0 };

function _fmtBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
}

/** Expected size of the Base64 download, from the Documents sheet "FileSize" (e.g. "4.04 MB"). 0 = unknown. */
function _expectedDocBytes(fileId) {
    try {
        const list = _docsCache[currentTermKey] || [];
        const d = list.find(x => String(x.fileId) === String(fileId));
        if (!d || !d.size) return 0;
        const m = String(d.size).trim().match(/^([\d.,]+)\s*(B|KB|MB|GB)?$/i);
        if (!m) return 0;
        const n = parseFloat(m[1].replace(/,/g, ''));
        if (!isFinite(n) || n <= 0) return 0;
        const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[(m[2] || 'B').toUpperCase()];
        return Math.round(n * mult * 4 / 3) + 400;   // Base64 inflates by 4/3, plus the JSON envelope
    } catch (e) { return 0; }
}

function _docProgressRender() {
    const p = _docProg;
    const fill = document.getElementById('doc-progress-fill');
    const pct = document.getElementById('doc-progress-pct');
    const det = document.getElementById('doc-progress-detail');
    if (fill) fill.style.width = p.shown + '%';
    if (pct) pct.textContent = Math.floor(p.shown) + '%';
    if (det) {
        det.textContent = p.stage === 'server' ? 'Preparing file...'
                        : p.stage === 'transfer' ? (p.got ? _fmtBytes(p.got) + ' received' : 'Starting download...')
                        : p.stage === 'done' ? 'Done' : '';
    }
}

function _docProgressTick() {
    const p = _docProg;
    const t = (Date.now() - p.start) / 1000;
    let target = 0;
    if (p.stage === 'server') {
        target = 30 * (1 - Math.exp(-t / 5));                       // creeps towards 30%, never reaches it
    } else if (p.stage === 'transfer') {
        const frac = p.total > 0 ? Math.min(p.got / p.total, 1)     // real: bytes received / expected
                                 : 1 - Math.exp(-p.got / 1500000);  // size unknown: smooth curve
        target = 30 + 65 * frac;
    }
    p.shown = Math.max(p.shown, Math.min(target, 96));
    _docProgressRender();
}

function _docProgressStart() {
    clearInterval(_docProgTimer);
    Object.assign(_docProg, { shown: 0, stage: 'server', start: Date.now(), got: 0, total: 0 });
    const wrap = document.getElementById('doc-progress-wrap');
    if (wrap) wrap.style.display = 'block';
    _docProgressRender();
    _docProgTimer = setInterval(_docProgressTick, 150);
}

function _docProgressFinish() {
    clearInterval(_docProgTimer); _docProgTimer = null;
    _docProg.stage = 'done'; _docProg.shown = 100;
    _docProgressRender();
}

function _docProgressStop() {
    clearInterval(_docProgTimer); _docProgTimer = null;
    _docProg.stage = 'idle'; _docProg.shown = 0;
    const wrap = document.getElementById('doc-progress-wrap');
    if (wrap) wrap.style.display = 'none';
    _docProgressRender();
}

/** POST to the Gatekeeper and stream the response so the bar can show real progress. Returns the parsed JSON. */
async function _fetchDocWithProgress(body, expectedBytes, signal) {
    _docProgressStart();
    const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: body,
        signal: signal
    });
    const len = parseInt(res.headers.get('Content-Length'), 10);
    _docProg.total = (isFinite(len) && len > 0) ? len : expectedBytes;
    _docProg.stage = 'transfer';

    if (!res.body || !res.body.getReader) return await res.json();   // old browser: no streaming, bar just jumps

    const reader = res.body.getReader();
    const chunks = [];
    while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        _docProg.got += part.value.length;
    }
    const all = new Uint8Array(_docProg.got);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
    chunks.length = 0;
    return JSON.parse(new TextDecoder().decode(all));
}

// ============================================================
// === DOCUMENT VOICE READER (TTS) ===
// Reads the open PDF aloud page by page with the app's existing Smart TTS engine
// (voice, speed, pausing, maths clean-up). Works offline with on-device voices.
// ============================================================
let _docPdf = null;
const _docTextCache = {};
const _docReader = { active: false, busy: false, internal: false, token: 0, page: 1, total: 0 };
const _DOC_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
let _docScrollBound = false;

// ---------- Page furniture: headers/footers that repeat on every page (copyright lines, page numbers...) ----------
// Learned per document from RECURRENCE (same text, same vertical band, on most pages), so it works for any
// publisher. Position alone never removes text; a keyword (©, "all rights reserved") is needed without recurrence.
const _docFurn = { on: true, learning: false, keys: new Set(), list: [], ready: Promise.resolve() };
try { _docFurn.on = localStorage.getItem('kaeri_doc_skip_furniture') !== '0'; } catch (e) {}
let _docOpenFileId = '';
const _DOC_FURN_KEYWORDS = /(©|\(c\)\s*\d{4}|all\s+rights\s+reserved|may\s+not\s+be\s+(scanned|copied|duplicated|posted))/i;

function _docCleanText(t) {
    return String(t).replace(/[­]/g, '')
        .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff')
        .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
        .replace(/\s+/g, ' ').trim();
}

/** Same text (digits/case/spacing ignored) in the same 5% vertical band = same piece of furniture. */
function _docFurnKey(text, band) {
    return text.toLowerCase().replace(/\s+/g, '').replace(/\d+/g, '#') + '|' + band;
}

/** Group raw PDF.js items into visual lines with position (top = 0 at the page top, 1 at the bottom) and font size. */
function _docGroupLines(items, view) {
    const fsOf = it => Math.abs(it.height) || Math.abs((it.transform || [])[3]) || Math.abs((it.transform || [])[0]) || 10;
    const y0 = view ? view[1] : 0;
    const H = view ? ((view[3] - view[1]) || 1) : 0;
    const lines = [];
    const seen = new Set();                 // overprinted duplicates: identical text drawn twice at the same spot
    let cur = null, prev = null;
    function flush() {
        if (cur && cur.t.trim()) {
            cur.top = H ? 1 - (cur.y - y0) / H : 0.5;
            cur.band = Math.max(0, Math.min(19, Math.floor(cur.top * 20)));
            lines.push(cur);
        }
        cur = null; prev = null;
    }
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const str = it.str || '';
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        const fs = fsOf(it);
        if (str.trim()) {
            // Overprint: the same text drawn twice at (almost) the same spot. Compare cleaned text ("ﬁ" == "fi")
            // and look in the neighbouring 1pt cells, so a 0.2pt nudge between the two layers can't split a pair.
            const ct = _docCleanText(str), rx = Math.round(tr[4]), ry = Math.round(tr[5]);
            let dup = false;
            for (let dx = -1; dx <= 1 && !dup; dx++)
                for (let dy = -1; dy <= 1 && !dup; dy++)
                    if (seen.has(ct + '|' + (rx + dx) + '|' + (ry + dy))) dup = true;
            if (dup) continue;
            seen.add(ct + '|' + rx + '|' + ry);
            if (prev && Math.abs(tr[5] - prev.tr[5]) > Math.max(2, fs * 0.45)) flush();   // new baseline = new line (small shifts are super/subscripts)
            if (!cur) cur = { t: '', x: tr[4], y: tr[5], fs: fs, top: 0.5, band: 10 };
            else if (prev) {
                const gap = tr[4] - (prev.tr[4] + (prev.w || 0));
                const avg = (it.width || 0) / Math.max(1, str.length);                  // average glyph width: scales with condensed text
                if (gap > Math.max(0.3 * (avg || fs * 0.5), 0.5) && !/\s$/.test(cur.t) && !/^\s/.test(str)) cur.t += ' ';
            }
            cur.t += str;
            prev = { tr: tr, w: it.width || 0 };
        }
        if (it.hasEOL) flush();
    }
    flush();

    // Dominant body font size (by characters), ignoring the top/bottom margins
    const hist = {};
    const inBody = l => !H || (l.top > 0.12 && l.top < 0.88);
    lines.forEach(l => { if (inBody(l)) { const k = Math.round(l.fs); hist[k] = (hist[k] || 0) + l.t.length; } });
    if (!Object.keys(hist).length) lines.forEach(l => { const k = Math.round(l.fs); hist[k] = (hist[k] || 0) + l.t.length; });
    let bodyFs = 12, best = 0;
    Object.keys(hist).forEach(k => { if (hist[k] > best) { best = hist[k]; bodyFs = +k; } });
    return { lines: lines, bodyFs: bodyFs };
}

function _docIsFurniture(text, line, bodyFs, furn) {
    for (let d = -1; d <= 1; d++) if (furn.keys.has(_docFurnKey(text, line.band + d))) return true;    // learned: recurs on most pages
    return line.fs <= 0.75 * bodyFs && _DOC_FURN_KEYWORDS.test(text);                                    // small print with copyright wording
}

/**
 * Turn PDF.js text items into clean, speakable text.
 * - Repeating headers/footers (page furniture) are dropped.
 * - Lines that merely WRAP (same font size, normal line spacing, previous line not ended by punctuation)
 *   are joined with a space, so a sentence is spoken in one go with no pause at the right-hand edge.
 * - A real break (bullet, heading, paragraph gap, sentence end) becomes a pause.
 */
function _docBuildPageText(items, view, furn) {
    const BULLET = /^[•●▪■◦○·–—-]\s*/;
    const g = _docGroupLines(items, view);

    // Clean each line; drop furniture; note whether it starts with a bullet marker
    const L = [];
    g.lines.forEach(l => {
        let t = _docCleanText(l.t);
        const edge = l.top <= 0.12 || l.top >= 0.88;
        if (furn && edge && t && _docIsFurniture(t, l, g.bodyFs, furn)) return;
        const bullet = BULLET.test(t);
        t = t.replace(BULLET, '').trim();
        if (!t || /^(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?$/i.test(t)) return;        // empty / lone page numbers
        L.push({ t: t, x: l.x, y: l.y, fs: l.fs, bullet: bullet });
    });

    // Join wrapped lines; keep real breaks as pauses
    let text = '';
    for (let i = 0; i < L.length; i++) {
        if (i === 0) { text = L[0].t; continue; }
        const P = L[i - 1], C = L[i];
        const gap = P.y - C.y;                                                  // distance down the page
        const sameSize = Math.abs(C.fs - P.fs) <= Math.max(1, 0.15 * P.fs);
        const close = gap > 0 && gap <= 1.6 * Math.max(C.fs, P.fs);             // normal line spacing, not a paragraph/bullet gap
        const ended = /[.!?:;]$/.test(P.t);
        if (/[A-Za-z]-$/.test(P.t) && /^[a-z]/.test(C.t) && sameSize && close) text = text.slice(0, -1) + C.t;   // de-hyphenate
        else if (!ended && !C.bullet && sameSize && close) text += ' ' + C.t;                                      // wrapped line: same sentence
        else text += '\n' + C.t;                                                                                    // real break: pause
    }
    return text.trim();
}

/** Learn this document's furniture from a sample of pages (or load it from the offline cache). */
async function _docLearnFurniture(pdf, total, fileId) {
    const F = { keys: new Set(), list: [] };
    try {
        if (fileId) {
            const c = await getOfflineDoc('furn:' + fileId);
            if (c && c.v === 1 && c.pages === total && Array.isArray(c.keys)) {
                c.keys.forEach(k => F.keys.add(k));
                F.list = c.list || [];
                return F;
            }
        }
        const idx = [];
        if (total <= 8) { for (let n = 1; n <= total; n++) idx.push(n); }
        else { for (let i = 0; i < 8; i++) idx.push(1 + Math.round(i * (total - 1) / 7)); }   // 8 pages spread across the document

        const counts = new Map(), example = new Map();
        const groups = await Promise.all(idx.map(async n => {
            const page = await pdf.getPage(n);
            const tc = await page.getTextContent();
            return _docGroupLines(tc.items, page.view);
        }));
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const seenOnPage = new Set();
            g.lines.forEach(l => {
                const t = _docCleanText(l.t);
                if ((t.match(/[A-Za-z]/g) || []).length < 8) return;                 // needs real words (never lone bullets/numbers)
                if (!(l.top <= 0.12 || l.top >= 0.88)) return;                        // only the top/bottom margins
                if (l.fs > 0.75 * g.bodyFs) return;                                   // small print only: slide titles AND running headers set in body-size type are always kept
                const k = _docFurnKey(t, l.band);
                if (seenOnPage.has(k)) return;
                seenOnPage.add(k);
                counts.set(k, (counts.get(k) || 0) + 1);
                if (!example.has(k)) example.set(k, t.replace(/\s*\d{1,3}$/, ''));
            });
        }
        const need = Math.max(3, Math.ceil(0.4 * idx.length));                       // on 40%+ of the sampled pages
        counts.forEach((c, k) => { if (c >= need) { F.keys.add(k); F.list.push(example.get(k)); } });
        if (fileId) saveDocOffline('furn:' + fileId, { v: 1, pages: total, keys: Array.from(F.keys), list: F.list });
    } catch (e) { /* learning is best-effort: on failure nothing is skipped */ }
    return F;
}

async function _docPageText(n) {
    if (_docTextCache[n] !== undefined) return _docTextCache[n];
    if (!_docPdf || n < 1 || n > _docReader.total) return '';
    const pdf = _docPdf;
    try { await _docFurn.ready; } catch (e) {}          // furniture is learned before any page is read
    if (pdf !== _docPdf) return '';
    let out = '';
    try {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        out = _docBuildPageText(tc.items, page.view, _docFurn.on ? _docFurn : null);
    } catch (e) { out = ''; }
    if (pdf !== _docPdf) return '';
    _docTextCache[n] = out;
    return out;
}

function _docCanvases() {
    const c = document.getElementById('pdf-canvas-container');
    return c ? Array.prototype.slice.call(c.querySelectorAll('canvas[data-page]')) : [];
}

/** The page nearest the top of the viewer: where "Read aloud" starts from. */
function _docVisiblePage() {
    const c = document.getElementById('pdf-canvas-container');
    const cvs = _docCanvases();
    if (!c || !cvs.length) return 1;
    const top = c.getBoundingClientRect().top + 40;
    for (let i = 0; i < cvs.length; i++) {
        if (cvs[i].getBoundingClientRect().bottom > top) return parseInt(cvs[i].dataset.page, 10) || (i + 1);
    }
    return parseInt(cvs[cvs.length - 1].dataset.page, 10) || cvs.length;
}

function _docReaderFocusPage(n) {
    const c = document.getElementById('pdf-canvas-container');
    const cvs = _docCanvases();
    cvs.forEach(cv => { cv.style.outline = ''; });
    const t = cvs.find(cv => parseInt(cv.dataset.page, 10) === n);
    if (!t || !c) return;
    if (_docReader.active) t.style.outline = '3px solid #72efdd';
    const y = t.getBoundingClientRect().top - c.getBoundingClientRect().top + c.scrollTop - 10;
    try { c.scrollTo({ top: y, behavior: 'smooth' }); } catch (e) { c.scrollTop = y; }
}

function _docReaderSyncUi() {
    const $ = id => document.getElementById(id);
    const play = $('dr-play'), stop = $('dr-stop'), pg = $('dr-page'), spd = $('dr-speed'), st = $('dr-status');
    const rate = $('dr-rate'), rl = $('dr-rate-label');
    const r = _docReader;
    const reading = r.active && !ttsPaused;
    if (play) { play.textContent = reading ? '⏸' : '▶'; play.setAttribute('aria-label', reading ? 'Pause reading' : (ttsPaused ? 'Resume reading' : 'Read aloud')); }
    if (stop) stop.disabled = !r.active;
    if (pg) pg.textContent = 'Page ' + (r.active ? r.page : _docVisiblePage()) + ' / ' + r.total;
    const rateTxt = ttsRate.toFixed(2).replace(/0$/, '').replace(/\.0$/, '') + '×';
    if (spd) spd.textContent = rateTxt;
    if (rl) rl.textContent = rateTxt;
    if (rate) rate.value = ttsRate;
    if (st) st.textContent = !r.active ? '🎧 Read aloud' : (r.busy ? '⏳ Preparing...' : (ttsPaused ? '⏸ Paused' : '🔊 Reading...'));
}

function _docFillVoices() {
    const sel = document.getElementById('dr-voice');
    if (!sel) return;
    _loadVoices();
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = 'Automatic (best English voice)';
    sel.appendChild(auto);
    const norm = v => String(v.lang || '').replace('_', '-');
    const english = ttsVoices.filter(v => /^en/i.test(norm(v)));
    (english.length ? english : ttsVoices).forEach(v => {
        const o = document.createElement('option');
        o.value = v.voiceURI; o.textContent = v.name + ' (' + norm(v) + ')';
        sel.appendChild(o);
    });
    sel.value = ttsVoiceURI && Array.prototype.some.call(sel.options, o => o.value === ttsVoiceURI) ? ttsVoiceURI : '';
}

/** Called once the PDF is loaded: reset reader state and show the bar. */
function _docReaderInit(numPages) {
    Object.keys(_docTextCache).forEach(k => delete _docTextCache[k]);
    Object.assign(_docReader, { active: false, busy: false, internal: false, page: 1, total: numPages });
    // Learn the document's repeating headers/footers in the background (finished before the first page is read)
    _docFurn.keys = new Set(); _docFurn.list = [];
    const _pdfNow = _docPdf, _idNow = _docOpenFileId;
    _docFurn.learning = true;
    _docFurnSyncUi();
    _docFurn.ready = _docLearnFurniture(_pdfNow, numPages, _idNow).then(F => {
        if (_pdfNow !== _docPdf) return;
        _docFurn.keys = F.keys; _docFurn.list = F.list;
        _docFurn.learning = false;
        _docFurnSyncUi();
    });
    _docReader.token++;
    const bar = document.getElementById('doc-reader-bar');
    if (bar) bar.style.display = ttsSupported ? 'block' : 'none';
    const c = document.getElementById('pdf-canvas-container');
    if (c && !_docScrollBound) {
        _docScrollBound = true;
        let raf = 0;
        c.addEventListener('scroll', function () {
            if (_docReader.active || raf) return;
            raf = requestAnimationFrame(function () { raf = 0; _docReaderSyncUi(); });
        }, { passive: true });
    }
    _docReaderSyncUi();
}

/** Reset everything doc-related when a viewer opens or closes. */
function _docResetUi() {
    if (_docAbort) { try { _docAbort.abort(); } catch (e) {} _docAbort = null; }
    _docProgressStop();
    if (_docReader.active) docReaderStop();
    _docReader.token++;
    _docReader.total = 0;
    ttsOnFinish = null;
    const bar = document.getElementById('doc-reader-bar');
    if (bar) bar.style.display = 'none';
    _docFurn.keys = new Set(); _docFurn.list = []; _docFurn.learning = false; _docFurn.ready = Promise.resolve();
    _docFurnSyncUi();
    const set = document.getElementById('doc-reader-settings');
    if (set) set.style.display = 'none';
    if (_docPdf) { try { _docPdf.destroy(); } catch (e) {} _docPdf = null; }
    _vidRelease();   // stop a playing video and free its memory
}

/** Engine callback (see stopReading): something else stopped the speech, so the document reader is no longer "reading". */
function _docReaderOnStop() {
    if (_docReader.internal || !_docReader.active) return;
    _docReader.token++;
    _docReader.active = false;
    _docReader.busy = false;
    _docCanvases().forEach(cv => { cv.style.outline = ''; });
    _docReaderSyncUi();
}

async function _docReaderPlayFrom(startPage) {
    if (!_docPdf) return;
    const token = ++_docReader.token;
    _docReader.active = true;
    _docReader.busy = true;
    _docReader.page = startPage;
    _docReaderSyncUi();

    // Find the first page from here that actually has text (scanned pages have none)
    let p = startPage, text = '';
    while (p <= _docReader.total) {
        text = await _docPageText(p);
        if (token !== _docReader.token) return;      // stopped / jumped while extracting
        if (text) break;
        p++;
    }
    _docReader.busy = false;
    if (!text) {
        showAppNotification("🔇 No readable text found. This PDF looks like scanned images.", "warning", 3500);
        _docReader.active = false;
        _docReaderSyncUi();
        return;
    }

    _docReader.page = p;
    _docReaderFocusPage(p);
    _docReaderSyncUi();

    _docReader.internal = true;                       // readText() calls stopReading() first: don't treat that as a user stop
    try { readText('Page ' + p + '. ' + text, { force: true }); }
    finally { _docReader.internal = false; }

    // Move on to the next page when this one finishes
    ttsOnFinish = function () {
        if (token !== _docReader.token) return;
        if (p < _docReader.total) {
            _docReaderPlayFrom(p + 1);
        } else {
            _docReader.active = false;
            _docCanvases().forEach(cv => { cv.style.outline = ''; });
            _docReaderSyncUi();
            showAppNotification("✅ Finished reading the document.", "info", 2500);
        }
    };
    _docPageText(p + 1);                              // prefetch the next page's text so there is no gap
}

function docReaderToggle() {
    if (!ttsSupported) {
        showAppNotification("🔇 This browser can't read aloud. Try Chrome or Safari.", "warning", 3500);
        return;
    }
    if (!_docPdf) return;
    if (!_docReader.active) {
        // Speak a silent utterance inside the tap: unlocks audio on iPhones before the async text extraction
        try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch (e) {}
        _docReaderPlayFrom(_docVisiblePage());
        logAnalyticsEvent('doc_tts_start', 'Document voice reader');
        return;
    }
    if (_docReader.busy) return;
    if (ttsPaused || ttsSpeaking) { toggleReadPause(); _docReaderSyncUi(); }
}

function docReaderStop() {
    if (!_docReader.active) return;
    stopReading();            // engine calls _docReaderOnStop → resets the reader state and UI
}

function docReaderStep(delta) {
    if (!_docPdf) return;
    const cur = _docReader.active ? _docReader.page : _docVisiblePage();
    const t = Math.min(_docReader.total, Math.max(1, cur + delta));
    if (_docReader.active) { _docReaderPlayFrom(t); }     // jump the reading to that page
    else { _docReaderFocusPage(t); setTimeout(_docReaderSyncUi, 350); }
}

function docReaderCycleSpeed() {
    let next = _DOC_RATES.find(r => r > ttsRate + 0.01);
    if (next === undefined) next = _DOC_RATES[0];
    setTtsRate(next);
    _docReaderSyncUi();
}

/** Show "🧹 Skipping headers & footers (n)" when furniture was found; the settings panel lists what is skipped. */
function _docFurnSyncUi() {
    const row = document.getElementById('dr-furn-row');
    const btn = document.getElementById('dr-furn');
    const list = document.getElementById('dr-furn-list');
    const n = _docFurn.list.length;
    if (row) row.style.display = (n || _docFurn.learning) ? 'block' : 'none';
    if (btn) {
        btn.textContent = _docFurn.learning ? '🧹 Learning headers & footers…'
                        : _docFurn.on ? '🧹 Skipping headers & footers (' + n + ')'
                        : '📄 Reading headers & footers (skip: off)';
        btn.classList.toggle('off', !_docFurn.on && !_docFurn.learning);
    }
    if (list) {
        list.innerHTML = '';
        if (n) {
            const h = document.createElement('div');
            h.style.cssText = 'color:#a0a8b4;font-size:.75em;margin-top:8px;';
            h.textContent = 'Repeated on every page:';
            list.appendChild(h);
            _docFurn.list.forEach(t => {
                const d = document.createElement('div');
                d.style.cssText = 'color:#7d8797;font-size:.7em;margin-top:3px;';
                d.textContent = t.length > 90 ? t.slice(0, 90) + '…' : t;
                list.appendChild(d);
            });
        }
    }
}

function docReaderToggleFurniture() {
    _docFurn.on = !_docFurn.on;
    try { localStorage.setItem('kaeri_doc_skip_furniture', _docFurn.on ? '1' : '0'); } catch (e) {}
    Object.keys(_docTextCache).forEach(k => delete _docTextCache[k]);   // re-extract pages with the new setting
    _docFurnSyncUi();
    showAppNotification(_docFurn.on ? "🧹 Skipping repeated headers & footers." : "📄 Reading everything, including headers & footers.", "info", 2200);
    if (_docReader.active) _docReaderPlayFrom(_docReader.page);
}

function docReaderToggleSettings() {
    const set = document.getElementById('doc-reader-settings');
    if (!set) return;
    const open = set.style.display === 'none';
    set.style.display = open ? 'block' : 'none';
    if (open) { _docFillVoices(); _docReaderSyncUi(); }
}

// ── Non-PDF fallback (video, PPTX, Word): Drive preview iframe. Needs internet; not cached. ──
function loadNonPdfPreview(fileId, title) {
    const container = document.getElementById('pdf-canvas-container');
    const loader = document.getElementById('doc-loader-overlay');
    if (!container) return;
    container.innerHTML = `<iframe src="https://drive.google.com/file/d/${fileId}/preview" style="width:100%; height:100%; min-height:100%; border:none; background:white;" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    if (loader) loader.style.display = 'none';
    logAnalyticsEvent('document_view', `Viewed: ${title}`);
}

// ── Convenience wrapper (backwards compatible: shows + loads in one shot) ──
function openDocumentViewer(fileId, title) {
    if (!fileId || fileId === 'undefined') {
        showAppNotification("⚠️ Document link unavailable", "error");
        return;
    }
    attemptOpenDoc(fileId, title);
}

function closeDocViewer() {
    const viewer = document.getElementById('smart-doc-viewer');
    if (viewer) {
        viewer.style.display = 'none';
        _docRenderId++;   // stop any in-flight PDF render
        _docResetUi();    // cancel a running download, stop the progress bar and the voice reader
        const container = document.getElementById('pdf-canvas-container');
        if (container) container.innerHTML = "";
        document.body.style.overflow = 'auto';
    }
}

// ============================================================
// === NEW: Document Access Control & Quiz Starter Helpers ===
// ============================================================

// Document access bouncer — shows skeleton INSTANTLY, verifies, then renders.
// PDFs are downloaded through the Gatekeeper, cached in IndexedDB, and drawn by PDF.js.
// A cached file is NEVER read before the access check passes (online: server, offline: local expiry).
async function attemptOpenDoc(fileId, title, mimeType) {
    if (!hasFullAccess) {
        // Free user: show message and payment modal
        showAppNotification("⚠️ Documents are only accessible in Full Access mode.", "warning", 2500);
        setTimeout(() => {
            openPaymentModal();
        }, 1000);
        return;
    }

    const isPdf = !mimeType || String(mimeType).toLowerCase().includes('pdf');
    _docOpenFileId = fileId;
    const sessionPayload = { code: userCode, email: userEmail };
    const loaderText = () => document.getElementById('doc-loader-text');

    // ── 1. INSTANT FEEDBACK: show the viewer + shimmer right now ──
    showDocViewerLoading(title);

    // ── 2. OFFLINE: local expiry check (the "bouncer"), then the IndexedDB cache ──
    if (!navigator.onLine) {
        const expiry = parseInt(localStorage.getItem(`expiry_${currentTermKey}`), 10);
        if (!expiry || Date.now() >= expiry) {
            closeDocViewer();
            showAppNotification("⏳ Session expired. Connect to internet to verify.", "warning");
            return;
        }
        if (!isPdf) {
            closeDocViewer();
            showAppNotification("📡 You are offline. This file type needs an internet connection.", "warning");
            return;
        }
        const offlineCopy = await getOfflineDoc(fileId);
        if (offlineCopy) {
            if (loaderText()) loaderText().textContent = 'Loading from offline cache...';
            renderPdfFromBase64(offlineCopy, title);
        } else {
            closeDocViewer();
            showAppNotification("📡 You are offline and haven't viewed this document before.", "warning");
        }
        return;
    }

    try {
        // ── 3. ONLINE, non-PDF (video / PPTX / Word): verify, then Drive preview iframe (not cached) ──
        if (!isPdf) {
            const vres = await fetch(APPS_SCRIPT_URL, {
                method: 'POST',
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify({ action: 'verify_document_access', file_id: fileId, session: sessionPayload })
            });
            const vdata = await vres.json();
            if (vdata.success) {
                showAppNotification("📄 Previewing Office/Video files requires an internet connection.", "info");
                loadNonPdfPreview(fileId, title);
            } else {
                _denyDocAccess(vdata);
            }
            return;
        }

        // ── 4. ONLINE, PDF: if cached, still verify with the server before reading the cache ──
        const cachedCopy = await getOfflineDoc(fileId);
        if (cachedCopy) {
            if (loaderText()) loaderText().textContent = 'Verifying access...';
            // A definitive "no" from the server (revoked, expired, wrong account, document removed) blocks the file.
            // A hiccup (Apps Script error, slow or flaky network) must NOT: then the local expiry decides.
            let allowed = false, timedOut = false;
            const vctl = new AbortController();
            _docAbort = vctl;
            const vtimer = setTimeout(() => { timedOut = true; vctl.abort(); }, 8000);
            try {
                const vres = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                    body: JSON.stringify({ action: 'verify_document_access', file_id: fileId, session: sessionPayload }),
                    signal: vctl.signal
                });
                const vdata = await vres.json();
                if (vdata.success) allowed = true;
                else if (_isDefinitiveDenial(vdata)) { _denyDocAccess(vdata); return; }
                else allowed = _localExpiryValid();
            } catch (e) {
                if (e && e.name === 'AbortError' && !timedOut) return;      // the student closed the viewer
                allowed = _localExpiryValid();
            } finally { clearTimeout(vtimer); }
            if (!allowed) {
                closeDocViewer();
                showAppNotification("⏳ Session expired. Connect to internet to verify.", "warning");
                return;
            }
            if (loaderText()) loaderText().textContent = 'Loading from offline cache...';
            renderPdfFromBase64(cachedCopy, title);
            return;
        }

        // ── 5. ONLINE, PDF, not cached: download via Gatekeeper (it verifies access itself) ──
        if (loaderText()) loaderText().textContent = 'Downloading securely...';
        _docAbort = new AbortController();
        const _myAbort = _docAbort;
        const data = await _fetchDocWithProgress(
            JSON.stringify({ action: 'download_document', file_id: fileId, session: sessionPayload }),
            _expectedDocBytes(fileId),
            _myAbort.signal
        );
        if (_myAbort.signal.aborted) return;   // viewer was closed / another document opened meanwhile

        if (data.success && data.data && data.data.base64) {
            _docProgressFinish();
            const pdfBytes = _b64ToBytes(data.data.base64);
            data.data.base64 = null;                                      // free the big text copy
            const saved = await saveDocOffline(fileId, pdfBytes.buffer);  // raw bytes: smaller, and opens without re-decoding
            _reportOfflineSave(saved);
            renderPdfFromBase64(pdfBytes, title);
        } else {
            _denyDocAccess(data);
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;   // the student cancelled / closed the viewer
        closeDocViewer();
        showAppNotification("⚠️ Connection error. Could not load the document.", "error");
    }
}

// Denied / failed: close the viewer, tell the student why, log out if the session is dead
function _denyDocAccess(data) {
    closeDocViewer();
    showAppNotification("❌ Access Denied: " + ((data && data.message) || "Unknown error"), "error");
    if (data && data.code === 'SESSION_INVALID') {
        handleSessionExpired(data.message);
    }
}

// Short Answer starter - initializes with specified number of questions
function startActualShortAnswer(limit) {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    
    let q = shuffle([...currentShortData]).slice(0, limit);
    currentQuizData = q;
    currentQuizType = 'shortAnswer';
    currentQuestionIndex = 0;
    currentScore = 0;
    
    if (q.length === 0) {
        container.innerHTML = "<p>No short answer questions available.</p>";
        updateProgress(0, 0);
        return;
    }
    displayShortAnswerQuestion();
    logAnalyticsEvent('quiz_start', `Short Answer (${limit} questions)`);
}

// Step selector for Short Answer preset buttons
function selectShortAnswerStep(step, label) {
    const totalAvailable = currentShortData.length;
    const finalCount = (step > totalAvailable) ? totalAvailable : step;
    showAppNotification(`🎯 Starting ${finalCount} question practice`, "success", 1500);
    setTimeout(() => startActualShortAnswer(finalCount), 500);
}

// Custom number handler for Short Answer
function startCustomShortAnswer() {
    const input = document.getElementById('custom-sa-count');
    if (!input) return;
    
    let requestedCount = parseInt(input.value);
    const totalAvailable = currentShortData.length;
    
    if (isNaN(requestedCount) || requestedCount < 1) {
        showAppNotification("⚠️ Please enter a valid number", "warning");
        return;
    }
    
    if (requestedCount > totalAvailable) {
        showAppNotification(`ℹ️ Only ${totalAvailable} available. Using all.`, "info", 2000);
        requestedCount = totalAvailable;
    }
    
    startActualShortAnswer(requestedCount);
}

// ============================================================
// === MODIFIED: Document Renderer (RESTORED FROM BASE A) ===
// ============================================================

/** Short, student-friendly label for a document's MIME type (never prints the raw string). */
function docTypeLabel(mime) {
    const t = String(mime || '').toLowerCase();
    if (t.indexOf('pdf') !== -1) return { label: 'PDF', icon: '📕' };
    if (t.indexOf('presentation') !== -1 || t.indexOf('powerpoint') !== -1 || t.indexOf('slides') !== -1) return { label: 'SLIDES', icon: '📊' };
    // Spreadsheets BEFORE Word: "officedocument.spreadsheetml" also contains the word "document".
    if (t.indexOf('spreadsheet') !== -1 || t.indexOf('excel') !== -1 || t.indexOf('sheet') !== -1) return { label: 'EXCEL', icon: '📗' };
    if (t.indexOf('word') !== -1 || t.indexOf('msword') !== -1 || t.indexOf('document') !== -1) return { label: 'DOC', icon: '📘' };
    if (t.indexOf('video') !== -1 || t.indexOf('mp4') !== -1) return { label: 'VIDEO', icon: '🎥' };
    if (t.indexOf('image') !== -1 || t.indexOf('jpg') !== -1 || t.indexOf('jpeg') !== -1 || t.indexOf('png') !== -1) return { label: 'IMAGE', icon: '🖼️' };
    return { label: 'FILE', icon: '📄' };
}

// ── Thumbnail fallback through the Gatekeeper "Middle Man" ───────────────────
// Each card first tries Drive's own thumbnail URL. If the browser can't load it
// (restricted file), the Gatekeeper fetches the preview as the Middle Man and
// returns it; if that also fails, the card keeps its file-type icon.
var _thumbCache = {};
var _thumbQueue = [];
var _thumbActive = 0;

function thumbShowIcon_(img, icon) {
    img.onerror = null;
    img.style.display = 'none';
    const box = img.parentElement;
    if (box && !box.querySelector('.doc-thumb-fallback')) {
        const sp = document.createElement('span');
        sp.className = 'doc-thumb-fallback';
        sp.style.cssText = 'font-size:48px; opacity:0.5; color:#a0a8b4;';
        sp.textContent = icon;
        box.insertBefore(sp, img);
    }
}

function thumbFallback_(img, icon) {
    img.onerror = null;                       // never loop
    const id = img.getAttribute('data-thumb-id');
    if (_thumbCache[id]) { img.onerror = function () { thumbShowIcon_(img, icon); }; img.src = _thumbCache[id]; return; }
    _thumbQueue.push({ img: img, icon: icon, id: id });
    thumbPump_();
}

function thumbPump_() {
    while (_thumbActive < 3 && _thumbQueue.length) {
        const job = _thumbQueue.shift();
        _thumbActive++;
        fetch(DOCS_SCRIPT_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: 'GET_DOCUMENT_THUMBNAIL', file_id: job.id })
        })
        .then(function (r) { return r.json(); })
        .then(function (res) {
            const uri = res && res.success && res.data && res.data.dataUri;
            if (uri) {
                _thumbCache[job.id] = uri;
                job.img.onerror = function () { thumbShowIcon_(job.img, job.icon); };
                job.img.src = uri;
            } else thumbShowIcon_(job.img, job.icon);
        })
        .catch(function () { thumbShowIcon_(job.img, job.icon); })
        .then(function () { _thumbActive--; thumbPump_(); });
    }
}

async function renderDocuments() {
    // IMPORTANT: Uses DOCS_SCRIPT_URL (Gatekeeper) to fetch data
    
    const container = document.getElementById("quiz-form");
    
    // Show skeleton grid while loading
    let skeletonHTML = `
        <h2 style="text-align:center; margin-bottom:20px;">📚 Loading Library...</h2>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px; padding:20px 0;">
    `;
    for(let i=0; i<8; i++) {
        skeletonHTML += `<div class="skeleton" style="height:180px; background:linear-gradient(90deg, #2b3a55 25%, #3e506e 50%, #2b3a55 75%); background-size:200% 100%; animation:shimmer 1.5s infinite; border-radius:10px;"></div>`;
    }
    skeletonHTML += `</div>`;
    
    container.innerHTML = skeletonHTML;
    document.getElementById("result").innerHTML = "";
    
    currentQuizType = 'documents'; 
    updateProgress(0, 0);

    try {
        // Flattened payload for Gatekeeper
        const payload = JSON.stringify({
            action: 'GET_STUDENT_DOCS',
            course: currentCourse, 
            term: currentTerm      
        });

        // FETCHING FROM GATEKEEPER URL
        const response = await fetch(DOCS_SCRIPT_URL, {
            method: 'POST',
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: payload
        });
        
        const data = await response.json();
        const documents = data.documents || (data.data && data.data.documents) || [];
        const success = data.success || false;
        if (success) { _docsCache[currentTermKey] = documents; applyModeAvailability(); }
        
        if (!success || documents.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:30px;"><h3>📂 Library Empty</h3><p>No active documents found.</p><button class="restart-button" onclick="exitQuiz()">Back to Menu</button></div>`;
            return;
        }

        let html = `<h2 style="text-align:center; margin-bottom:20px;">📚 ${currentCourse} Library</h2>`;
        
        // Add status banner for free users
        if (!hasFullAccess) {
            html += `
                <div style="background:#2b3a55; border-left:6px solid #ffc107; padding:15px; border-radius:8px; margin-bottom:20px;">
                    <p style="margin:0; color:#ffc107; font-weight:bold;">🔒 Preview Mode</p>
                    <p style="margin:5px 0 0 0; font-size:0.9em;">Documents are visible but locked. Unlock Full Access to view them.</p>
                </div>`;
        }
        
        html += `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px; padding:20px 0;">`;

        documents.forEach(doc => {
    const shortDesc = doc.description ? (doc.description.length > 80 ? doc.description.substring(0, 80) + '...' : doc.description) : '';
    
    // ── Clean label + fallback icon from the file's MIME type ──
    const _dt = docTypeLabel(doc.type);
    const displayType = _dt.label;
    const fallbackIcon = _dt.icon;
    
    const lockIcon = hasFullAccess ? "👁️ Open" : "🔒 Locked";
    const lockColor = hasFullAccess ? "#28a745" : "#dc3545";
    const cardOpacity = hasFullAccess ? "1" : "0.75";
    
    html += `
    <div class="doc-card" onclick="attemptOpenDoc('${doc.fileId}', '${doc.title.replace(/'/g, "\\'")}', '${String(doc.type || '').replace(/'/g, "\\'")}')" 
         style="background:#2b3a55; padding:15px; border-radius:10px; border-left:5px solid ${lockColor}; 
                cursor:pointer; transition:0.3s; box-shadow: 0 4px 8px rgba(0,0,0,0.2); opacity: ${cardOpacity};">

        <!-- ── THUMBNAIL CONTAINER ── -->
        <div style="width:100%; height:140px; background:linear-gradient(135deg, #1b263b, #0d1b2a); border-radius:8px; margin-bottom:12px; overflow:hidden; display:flex; align-items:center; justify-content:center; border:1px solid #3e506e; position:relative;">
            <img src="https://drive.google.com/thumbnail?id=${doc.fileId}&sz=w400"
                 data-thumb-id="${doc.fileId}"
                 alt="${doc.title}"
                 loading="lazy"
                 style="width:100%; height:100%; object-fit:cover; transition:0.3s;"
                 onerror="thumbFallback_(this, '${fallbackIcon}')">
            <div style="position:absolute; bottom:6px; right:8px; background:rgba(0,0,0,0.7); padding:2px 10px; border-radius:12px; font-size:9px; color:#fff; text-transform:uppercase; letter-spacing:0.5px;">
                ${displayType}
            </div>
        </div>

        <div style="font-size:0.7em; text-transform:uppercase; color:${lockColor}; font-weight:bold; letter-spacing:1px; margin-bottom:5px;">${doc.topic || 'General'}</div>
        <div style="font-size:1.1em; font-weight:bold; color:white; margin-bottom:8px; line-height:1.3;">${doc.title}</div>
        <div style="font-size:0.85em; color:#a0a8b4; margin-bottom:10px;">${shortDesc}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid #3e506e; padding-top:10px;">
            <span style="background:#0d1b2a; padding:2px 8px; border-radius:4px; font-size:0.7em; color:#fff;">${displayType} • ${doc.size || 'Unknown'}</span>
            <span style="color:${lockColor}; font-size:0.9em; font-weight:bold;">${lockIcon}</span>
        </div>
    </div>`;
});
        html += `</div>`;
        html += `<div style="text-align:center; margin-top:20px;"><button class="restart-button" onclick="exitQuiz()">⬅ Back to Menu</button></div>`;
        container.innerHTML = html;

    } catch (e) {
        container.innerHTML = `<div style="text-align:center; padding:20px; color:#dc3545;"><h3>⚠️ Connection Error</h3><p>Could not load library.</p><button class="restart-button" onclick="renderDocuments()">Try Again</button></div>`;
    }
}

// ============================================================
// === COURSE VIDEOS (same Gatekeeper "Middle Man" as documents) ===
// The video file stays PRIVATE in Drive. The Gatekeeper checks the student's code and scope and
// sends the file in Base64 chunks (get_video_chunk).
//  • Normal path: the service worker built into script.js turns those chunks into a seekable video stream,
//    so playback starts after the first chunk while the rest keeps downloading ahead. Every
//    chunk is also saved in Cache Storage, so a watched video plays offline (same local-expiry
//    guard as PDFs).
//  • Fallback (no service worker): download everything, save a Blob in
//    IndexedDB, then play.
// Both paths play in the same built-in player (_mountVideoPlayer) inside the viewer window.
// ============================================================
const _VID_MAX_BYTES = 250 * 1024 * 1024;   // fallback path only: refuse absurdly large files
const _VID_CHUNK = 3 * 1024 * 1024;         // must match CHUNK in the worker block at the top
const _VID_CACHE = 'kaeri-video-chunks-v1'; // must match CACHE in the worker block at the top
let _vidObjUrl = null;
let _vidReg = null;
let _vidCurrentId = null;
let _vidFailHandled = false;
let _vidMsgBound = false;
let _kvHideTimer = null;

function _vidEsc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

/** Stop the playing video, stop background saving and free memory. Called whenever the viewer resets or closes. */
function _vidRelease() {
    const closingId = _vidCurrentId;
    _vidCurrentId = null;
    if (_kvHideTimer) { clearTimeout(_kvHideTimer); _kvHideTimer = null; }
    const v = document.querySelector('#pdf-canvas-container video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {} }
    if (_vidObjUrl) { try { URL.revokeObjectURL(_vidObjUrl); } catch (e) {} _vidObjUrl = null; }
    try {
        if (closingId && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'VID_STOP', id: closingId });
        }
    } catch (e) {}
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
}

/** The Gatekeeper puts its reason code under data.code; accept either place. */
function _vidDenied(res) {
    const code = res && (res.code || (res.data && res.data.code));
    _denyDocAccess(Object.assign({}, res || {}, { code: code }));
}

function openVideoByIndex(i) {
    const v = (_videosCache[currentTermKey] || [])[i];
    if (!v) return;
    attemptOpenVideo(v.fileId, v.title);
}

async function renderVideos() {
    const container = document.getElementById("quiz-form");

    let skeletonHTML = `
        <h2 style="text-align:center; margin-bottom:20px;">📺 Loading Videos...</h2>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px; padding:20px 0;">
    `;
    for (let i = 0; i < 4; i++) {
        skeletonHTML += `<div class="skeleton" style="height:180px; background:linear-gradient(90deg, #2b3a55 25%, #3e506e 50%, #2b3a55 75%); background-size:200% 100%; animation:shimmer 1.5s infinite; border-radius:10px;"></div>`;
    }
    skeletonHTML += `</div>`;
    container.innerHTML = skeletonHTML;
    document.getElementById("result").innerHTML = "";

    currentQuizType = 'videos';
    updateProgress(0, 0);

    try {
        let videos = await _fetchVideosForTerm(currentTermKey, currentCourse, currentTerm);
        if (videos === null) videos = _videosCache[currentTermKey] || null;   // offline: last known list
        if (videos === null) {
            container.innerHTML = `<div style="text-align:center; padding:20px; color:#dc3545;"><h3>⚠️ Connection Error</h3><p>Could not load videos.</p><button class="restart-button" onclick="renderVideos()">Try Again</button> <button class="restart-button" onclick="exitQuiz()">Back to Menu</button></div>`;
            return;
        }
        applyModeAvailability();

        if (videos.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:30px;"><h3>📺 No Videos Yet</h3><p>No videos uploaded for this term.</p><button class="restart-button" onclick="exitQuiz()">Back to Menu</button></div>`;
            return;
        }

        let html = `<h2 style="text-align:center; margin-bottom:20px;">📺 ${_vidEsc(currentCourse)} Videos</h2>`;

        if (!hasFullAccess) {
            html += `
                <div style="background:#2b3a55; border-left:6px solid #ffc107; padding:15px; border-radius:8px; margin-bottom:20px;">
                    <p style="margin:0; color:#ffc107; font-weight:bold;">🔒 Preview Mode</p>
                    <p style="margin:5px 0 0 0; font-size:0.9em;">Videos are visible but locked. Unlock Full Access to watch them.</p>
                </div>`;
        }

        html += `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px; padding:20px 0;">`;

        videos.forEach((vid, i) => {
            const desc = String(vid.description || '');
            const shortDesc = desc.length > 80 ? desc.substring(0, 80) + '...' : desc;
            const lockIcon = hasFullAccess ? "▶️ Play" : "🔒 Locked";
            const lockColor = hasFullAccess ? "#28a745" : "#dc3545";
            const cardOpacity = hasFullAccess ? "1" : "0.75";

            html += `
            <div class="doc-card" onclick="openVideoByIndex(${i})"
                 style="background:#2b3a55; padding:15px; border-radius:10px; border-left:5px solid ${lockColor};
                        cursor:pointer; transition:0.3s; box-shadow: 0 4px 8px rgba(0,0,0,0.2); opacity:${cardOpacity};">

                <div style="width:100%; height:140px; background:linear-gradient(135deg, #1b263b, #0d1b2a); border-radius:8px; margin-bottom:12px; overflow:hidden; display:flex; align-items:center; justify-content:center; border:1px solid #3e506e; position:relative;">
                    <img src="https://drive.google.com/thumbnail?id=${_vidEsc(vid.fileId)}&sz=w400"
                         data-thumb-id="${_vidEsc(vid.fileId)}"
                         alt="${_vidEsc(vid.title)}"
                         loading="lazy"
                         style="width:100%; height:100%; object-fit:cover; transition:0.3s;"
                         onerror="thumbFallback_(this, '🎥')">
                    <div style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:none;">
                        <span style="font-size:34px; color:#fff; background:rgba(0,0,0,0.55); width:56px; height:56px; border-radius:50%; display:flex; align-items:center; justify-content:center; padding-left:4px; box-sizing:border-box;">▶</span>
                    </div>
                    <div style="position:absolute; bottom:6px; right:8px; background:rgba(0,0,0,0.7); padding:2px 10px; border-radius:12px; font-size:9px; color:#fff; text-transform:uppercase; letter-spacing:0.5px;">VIDEO</div>
                </div>

                <div style="font-size:0.7em; text-transform:uppercase; color:${lockColor}; font-weight:bold; letter-spacing:1px; margin-bottom:5px;">${_vidEsc(vid.topic || 'General')}</div>
                <div style="font-size:1.1em; font-weight:bold; color:white; margin-bottom:8px; line-height:1.3;">${_vidEsc(vid.title)}</div>
                <div style="font-size:0.85em; color:#a0a8b4; margin-bottom:10px;">${_vidEsc(shortDesc)}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid #3e506e; padding-top:10px;">
                    <span style="background:#0d1b2a; padding:2px 8px; border-radius:4px; font-size:0.7em; color:#fff;">VIDEO • ${_vidEsc(vid.size || 'Unknown')}</span>
                    <span style="color:${lockColor}; font-size:0.9em; font-weight:bold;">${lockIcon}</span>
                </div>
            </div>`;
        });
        html += `</div>`;
        html += `<div style="text-align:center; margin-top:20px;"><button class="restart-button" onclick="exitQuiz()">⬅ Back to Menu</button></div>`;
        container.innerHTML = html;

    } catch (e) {
        container.innerHTML = `<div style="text-align:center; padding:20px; color:#dc3545;"><h3>⚠️ Connection Error</h3><p>Could not load videos.</p><button class="restart-button" onclick="renderVideos()">Try Again</button></div>`;
    }
}

// ── Service-worker glue ──────────────────────────────────────────────────────
/** script.js is its own service worker: find this file's URL. */
function _vidSwUrl() {
    const me = document.currentScript && document.currentScript.src;
    if (me) { _vidSwUrl._u = me; return me; }
    if (_vidSwUrl._u) return _vidSwUrl._u;
    const tags = document.querySelectorAll('script[src]');
    for (let i = 0; i < tags.length; i++) {
        if (/(^|\/)script\.js(\?|#|$)/.test(tags[i].getAttribute('src'))) return (_vidSwUrl._u = tags[i].src);
    }
    return (_vidSwUrl._u = new URL('script.js', location.href).href);
}
if (!_IS_SW && document.currentScript) _vidSwUrl._u = document.currentScript.src;

/** Resolves once the given worker is activated; rejects when it fails or takes too long. */
function _vidWaitActivated(sw, ms) {
    return new Promise(function (resolve, reject) {
        if (!sw) { reject(new Error('no worker')); return; }
        if (sw.state === 'activated') { resolve(); return; }
        const t = setTimeout(function () { reject(new Error('worker activation timed out')); }, ms);
        sw.addEventListener('statechange', function () {
            if (sw.state === 'activated') { clearTimeout(t); resolve(); }
            else if (sw.state === 'redundant') { clearTimeout(t); reject(new Error('worker install failed')); }
        });
    });
}

async function _vidRegisterOnce() {
    const swUrl = _vidSwUrl();
    let reg = await navigator.serviceWorker.getRegistration();
    const ours = reg && reg.active && reg.active.scriptURL.split('?')[0] === swUrl.split('?')[0];
    if (!ours) {
        if (!navigator.onLine) throw new Error('offline and worker not installed');
        reg = await navigator.serviceWorker.register(swUrl, { updateViaCache: 'none' });
    } else if (navigator.onLine) {
        reg.update().catch(function () {});   // pick up fixes to script.js in the background
    }
    await _vidWaitActivated(reg.active || reg.waiting || reg.installing, 20000);
    reg = (await navigator.serviceWorker.getRegistration()) || reg;
    if (!navigator.serviceWorker.controller) {
        // the page was opened before the worker existed: ask it to take control now
        const target = reg.active;
        const got = new Promise(function (res) {
            const t = setTimeout(res, 6000);
            navigator.serviceWorker.addEventListener('controllerchange', function () { clearTimeout(t); res(); }, { once: true });
        });
        if (target) target.postMessage({ type: 'VID_CLAIM' });
        await got;
    }
    if (!navigator.serviceWorker.controller) throw new Error('worker is not controlling this page');
    return reg;
}

async function _vidEnsureSW() {
    if (!('serviceWorker' in navigator) || !('caches' in window) || !window.isSecureContext) return false;
    let reg = null;
    try {
        try { reg = await _vidRegisterOnce(); }
        catch (e1) {
            console.warn('[VIDEO] worker start failed, retrying clean:', e1);
            if (!navigator.onLine) throw e1;
            const all = await navigator.serviceWorker.getRegistrations();
            for (let k = 0; k < all.length; k++) { try { await all[k].unregister(); } catch (e) {} }
            reg = await _vidRegisterOnce();
        }
        _vidReg = reg;
        if (!_vidMsgBound) {
            _vidMsgBound = true;
            navigator.serviceWorker.addEventListener('message', function (ev) {
                const d = ev.data || {};
                if (!d.type || String(d.type).indexOf('VID_') !== 0 || d.id !== _vidCurrentId) return;
                if (d.type === 'VID_FILL') _vidOnFill(d);
                else if (d.type === 'VID_FAIL') _vidOnFail(d.reply);
            });
        }
        return true;
    } catch (e) {
        console.warn('[VIDEO] service worker unavailable:', e);
        return false;
    }
}

function _vidKey(path) { return new URL(path, _vidReg.scope).href; }

/** What is saved on this device for a video: { total, have, count } or null. */
async function _vidSavedInfo(fileId) {
    try {
        const cache = await caches.open(_VID_CACHE);
        const mr = await cache.match(_vidKey('__kmeta__/' + encodeURIComponent(fileId)));
        if (!mr) return null;
        const meta = await mr.json();
        const prefix = _vidKey('__kchunk__/' + encodeURIComponent(fileId) + '/');
        const have = (await cache.keys()).filter(function (r) { return r.url.indexOf(prefix) === 0; }).length;
        return { total: meta.total, have: have, count: Math.ceil(meta.total / _VID_CHUNK) };
    } catch (e) { return null; }
}

function _vidSendCtx(fileId, ctx) {
    return new Promise(function (resolve) {
        try {
            const ch = new MessageChannel();
            const t = setTimeout(function () { resolve(false); }, 2000);
            ch.port1.onmessage = function () { clearTimeout(t); resolve(true); };
            navigator.serviceWorker.controller.postMessage({ type: 'VID_CTX', id: fileId, ctx: ctx }, [ch.port2]);
        } catch (e) { resolve(false); }
    });
}

function _vidOnFill(d) {
    const el = document.querySelector('#pdf-canvas-container .kv-save');
    if (!d.count) return;
    if (d.done >= d.count) {
        if (el) { el.textContent = '✅ Saved offline'; el.title = 'This video plays without internet'; }
        if (!_vidOnFill.toasted || _vidOnFill.toasted !== d.id) {
            _vidOnFill.toasted = d.id;
            showAppNotification("✅ Saved. This video now plays offline.", "info", 2500);
            _ensurePersistentStorage().then(function (persisted) { if (!persisted) setTimeout(_offlineTipOnce, 3000); });
        }
    } else if (el) {
        el.textContent = '⬇ ' + Math.floor((d.done / d.count) * 100) + '%';
        el.title = 'Saving for offline use';
    }
}

function _vidOnFail(reply) {
    if (_vidFailHandled || !_vidCurrentId) return;
    const code = reply && (reply.code || (reply.data && reply.data.code));
    if (_isDefinitiveDenial(reply) || code === 'DRIVE_UNAVAILABLE') {
        _vidFailHandled = true;
        _vidDenied(reply);
    }
    // anything else: the player shows its own "Tap to retry" message when the stream breaks
}

// ── Built-in player (no external library) ────────────────────────────────────
function _kvInjectStyle() {
    if (document.getElementById('kv-style')) return;
    const st = document.createElement('style');
    st.id = 'kv-style';
    st.textContent = `
    .kv-wrap{position:relative;width:100%;background:#000;border-radius:8px;overflow:hidden;user-select:none;-webkit-user-select:none;outline:none;font-family:inherit}
    .kv-wrap video{display:block;width:100%;max-height:70vh;background:#000}
    .kv-wrap.kv-max{position:fixed;left:0;top:0;right:0;bottom:0;width:100vw;height:100vh;height:100dvh;z-index:2147483000;border-radius:0;display:flex;align-items:center;justify-content:center}
    .kv-wrap.kv-max video{max-height:100%;height:100%}
    html.kv-lock,html.kv-lock body{overflow:hidden}
    .kv-wrap:fullscreen{border-radius:0;display:flex;align-items:center;justify-content:center;max-height:none}
    .kv-wrap:fullscreen video{max-height:100vh;height:100%}
    .kv-wrap:-webkit-full-screen{border-radius:0;display:flex;align-items:center;justify-content:center}
    .kv-wrap:-webkit-full-screen video{max-height:100vh;height:100%}
    .kv-center{position:absolute;left:0;right:0;top:0;bottom:70px;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .kv-big{pointer-events:auto;width:68px;height:68px;border-radius:50%;border:0;background:rgba(0,0,0,.6);color:#fff;font-size:30px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0 0 0 4px}
    .kv-spin{position:absolute;width:46px;height:46px;border:4px solid rgba(255,255,255,.25);border-top-color:#72efdd;border-radius:50%;animation:kvspin .8s linear infinite}
    @keyframes kvspin{to{transform:rotate(360deg)}}
    .kv-bar{position:absolute;left:0;right:0;bottom:0;padding:18px 10px 6px;background:linear-gradient(transparent,rgba(0,0,0,.88));transition:opacity .25s}
    .kv-wrap.kv-hide .kv-bar,.kv-wrap.kv-hide .kv-center{opacity:0;pointer-events:none}
    .kv-wrap.kv-hide{cursor:none}
    .kv-seek{position:relative;height:24px;display:flex;align-items:center}
    .kv-track{position:absolute;left:0;right:0;top:10px;height:4px;background:rgba(255,255,255,.25);border-radius:2px;overflow:hidden}
    .kv-buf{position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.45)}
    .kv-played{position:absolute;left:0;top:0;bottom:0;width:0;background:#72efdd}
    .kv-range{position:relative;width:100%;height:24px;margin:0;background:transparent;-webkit-appearance:none;appearance:none;cursor:pointer}
    .kv-range::-webkit-slider-runnable-track{background:transparent;height:24px}
    .kv-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#72efdd;margin-top:5px;border:0}
    .kv-range::-moz-range-track{background:transparent;height:24px}
    .kv-range::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#72efdd}
    .kv-row{display:flex;align-items:center;gap:2px;color:#fff;font-size:13px}
    .kv-btn{background:none;border:0;color:#fff;min-width:42px;height:42px;font-size:18px;cursor:pointer;border-radius:6px;padding:0 4px}
    .kv-btn.kv-txt{font-size:12px;font-weight:bold}
    .kv-btn:active{background:rgba(255,255,255,.18)}
    .kv-time{flex:1;min-width:0;white-space:nowrap;padding:0 4px;font-variant-numeric:tabular-nums}
    .kv-save{font-size:11px;color:#72efdd;white-space:nowrap;padding:0 4px}
    .kv-msg{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(0,0,0,.8);color:#fff;text-align:center;padding:20px;font-size:15px}
    .kv-msg button{background:#72efdd;color:#0d1b2a;border:0;border-radius:8px;padding:10px 18px;font-weight:bold;cursor:pointer;font-size:15px}
    `;
    document.head.appendChild(st);
}

function _kvFmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}

/** Put a video on screen with the built-in controls. src = stream URL or blob URL. */
function _mountVideoPlayer(src, title, opts) {
    opts = opts || {};
    const container = document.getElementById('pdf-canvas-container');
    const loader = document.getElementById('doc-loader-overlay');
    if (!container) return null;
    _kvInjectStyle();
    container.innerHTML = '';
    if (typeof _docProgressStop === 'function') { try { _docProgressStop(); } catch (e) {} }

    const wrap = document.createElement('div');
    wrap.className = 'kv-wrap';
    wrap.tabIndex = 0;
    wrap.innerHTML = `
        <video playsinline webkit-playsinline preload="auto" disablepictureinpicture controlslist="nodownload noremoteplayback"></video>
        <div class="kv-center"><div class="kv-spin"></div><button type="button" class="kv-big" aria-label="Play">▶</button></div>
        <div class="kv-bar">
            <div class="kv-seek"><div class="kv-track"><div class="kv-buf"></div><div class="kv-played"></div></div>
                <input class="kv-range" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek"></div>
            <div class="kv-row">
                <button type="button" class="kv-btn" data-k="play" aria-label="Play or pause">▶</button>
                <button type="button" class="kv-btn kv-txt" data-k="back" aria-label="Back 10 seconds">−10s</button>
                <button type="button" class="kv-btn kv-txt" data-k="fwd" aria-label="Forward 10 seconds">+10s</button>
                <span class="kv-time">0:00 / 0:00</span>
                <span class="kv-save"></span>
                <button type="button" class="kv-btn kv-txt" data-k="speed" aria-label="Playback speed">1×</button>
                <button type="button" class="kv-btn" data-k="mute" aria-label="Mute">🔊</button>
                <button type="button" class="kv-btn" data-k="fs" aria-label="Maximize" title="Maximize">⤢</button>
            </div>
        </div>
        <div class="kv-msg"><div class="kv-msg-text"></div><button type="button">Try again</button></div>`;

    const v = wrap.querySelector('video');
    const q = function (sel) { return wrap.querySelector(sel); };
    const big = q('.kv-big'), spin = q('.kv-spin'), range = q('.kv-range'), bufEl = q('.kv-buf'),
          playedEl = q('.kv-played'), timeEl = q('.kv-time'), saveEl = q('.kv-save'), msgEl = q('.kv-msg');
    const btn = function (k) { return wrap.querySelector('[data-k="' + k + '"]'); };
    let dragging = false, started = false;
    const rates = [1, 1.25, 1.5, 2, 0.75];
    let rateIdx = 0;

    if (opts.savedFull) saveEl.textContent = '✅ Saved offline';

    const dur = function () { return isFinite(v.duration) ? v.duration : 0; };
    function refresh() {
        const d = dur(), t = v.currentTime || 0;
        if (!dragging) timeEl.textContent = _kvFmt(t) + ' / ' + _kvFmt(d);
        playedEl.style.width = (d ? (t / d) * 100 : 0) + '%';
        if (!dragging) range.value = d ? Math.round((t / d) * 1000) : 0;
        let buffEnd = 0;
        for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= t + 0.5 && v.buffered.end(i) >= t) { buffEnd = v.buffered.end(i); break; }
        }
        bufEl.style.width = (d ? Math.min(100, (buffEnd / d) * 100) : 0) + '%';
    }
    function syncPlay() {
        const playing = !v.paused && !v.ended;
        btn('play').textContent = playing ? '⏸' : '▶';
        big.textContent = v.ended ? '↻' : '▶';
        big.style.display = playing ? 'none' : 'flex';
    }
    function showControls() {
        wrap.classList.remove('kv-hide');
        if (_kvHideTimer) clearTimeout(_kvHideTimer);
        if (!v.paused && !v.ended) _kvHideTimer = setTimeout(function () { wrap.classList.add('kv-hide'); }, 3000);
    }
    function play() { const p = v.play(); if (p && p.catch) p.catch(function () {}); }
    function toggle() { if (v.ended) v.currentTime = 0; if (v.paused) play(); else v.pause(); }
    function skip(d) { const t = (v.currentTime || 0) + d; v.currentTime = Math.max(0, dur() ? Math.min(dur(), t) : t); showControls(); }
    function isMax() {
        const d = document;
        return !!(d.fullscreenElement || d.webkitFullscreenElement) || wrap.classList.contains('kv-max');
    }
    function syncMax() {
        const m = isMax(), b = btn('fs');
        if (!b) return;
        b.textContent = m ? '⤡' : '⤢';
        b.setAttribute('aria-label', m ? 'Minimize' : 'Maximize');
        b.title = m ? 'Minimize' : 'Maximize';
    }
    function toggleFs() {
        const d = document, fsEl = d.fullscreenElement || d.webkitFullscreenElement;
        if (fsEl) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
        if (wrap.classList.contains('kv-max')) {   // minimize the CSS-maximized fallback
            wrap.classList.remove('kv-max');
            d.documentElement.classList.remove('kv-lock');
            syncMax();
            return;
        }
        let p;
        const cssMax = function () {
            if (v.webkitEnterFullscreen && !wrap.requestFullscreen && !wrap.webkitRequestFullscreen) { try { v.webkitEnterFullscreen(); return; } catch (e) {} }
            wrap.classList.add('kv-max');
            d.documentElement.classList.add('kv-lock');
            syncMax();
        };
        try {
            if (wrap.requestFullscreen) p = wrap.requestFullscreen();
            else if (wrap.webkitRequestFullscreen) p = wrap.webkitRequestFullscreen();
            else { cssMax(); return; }
        } catch (e) { cssMax(); return; }
        Promise.resolve(p).then(function () {
            try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
        }).catch(cssMax);
    }
    document.addEventListener('fullscreenchange', syncMax);
    document.addEventListener('webkitfullscreenchange', syncMax);
    function showError(text) {
        spin.style.display = 'none';
        q('.kv-msg-text').textContent = text;
        msgEl.style.display = 'flex';
    }

    big.onclick = toggle;
    btn('play').onclick = toggle;
    btn('back').onclick = function () { skip(-10); };
    btn('fwd').onclick = function () { skip(10); };
    btn('speed').onclick = function () {
        rateIdx = (rateIdx + 1) % rates.length;
        v.playbackRate = rates[rateIdx];
        btn('speed').textContent = rates[rateIdx] + '×';
        showControls();
    };
    btn('mute').onclick = function () { v.muted = !v.muted; btn('mute').textContent = v.muted ? '🔇' : '🔊'; showControls(); };
    btn('fs').onclick = toggleFs;
    v.addEventListener('click', function () { if (wrap.classList.contains('kv-hide')) showControls(); else toggle(); });
    v.addEventListener('dblclick', toggleFs);
    v.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    range.addEventListener('input', function () {
        dragging = true;
        const d = dur();
        if (d) timeEl.textContent = _kvFmt((range.value / 1000) * d) + ' / ' + _kvFmt(d);
        showControls();
    });
    range.addEventListener('change', function () {
        const d = dur();
        if (d) { v.currentTime = (range.value / 1000) * d; spin.style.display = 'block'; }
        dragging = false;
    });
    wrap.addEventListener('keydown', function (e) {
        const k = e.key;
        if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
        else if (k === 'ArrowLeft') { e.preventDefault(); skip(-5); }
        else if (k === 'ArrowRight') { e.preventDefault(); skip(5); }
        else if (k === 'f') { e.preventDefault(); toggleFs(); }
        else if (k === 'm') { e.preventDefault(); btn('mute').click(); }
    });
    wrap.addEventListener('pointermove', showControls);
    wrap.addEventListener('touchstart', showControls, { passive: true });

    ['timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'seeked'].forEach(function (ev) { v.addEventListener(ev, refresh); });
    ['play', 'pause', 'ended'].forEach(function (ev) { v.addEventListener(ev, function () { syncPlay(); showControls(); }); });
    v.addEventListener('waiting', function () { spin.style.display = 'block'; });
    ['playing', 'canplay', 'seeked'].forEach(function (ev) { v.addEventListener(ev, function () { spin.style.display = 'none'; }); });
    v.addEventListener('playing', function () {
        if (started) return;
        started = true;
        logAnalyticsEvent('video_view', `Watched: ${title}`);
        if (opts.onFirstPlay) opts.onFirstPlay();
    });
    v.addEventListener('error', function () {
        if (!v.getAttribute('src') || !_vidCurrentId) return;   // the viewer is closing: ignore
        showError('⚠️ Connection problem. The video stopped loading.');
    });
    msgEl.querySelector('button').onclick = function () {
        const t = v.currentTime || 0;
        msgEl.style.display = 'none';
        spin.style.display = 'block';
        v.src = src;
        v.load();
        v.addEventListener('loadedmetadata', function once() {
            v.removeEventListener('loadedmetadata', once);
            try { v.currentTime = t; } catch (e) {}
            play();
        });
    };

    container.appendChild(wrap);
    if (loader) loader.style.display = 'none';
    spin.style.display = 'block';
    syncPlay();
    v.src = src;
    v.load();
    play();   // autoplay may be blocked: the big ▶ button stays on screen
    try { wrap.focus({ preventScroll: true }); } catch (e) {}
    return v;
}

/** Fallback path: play a finished Blob. */
function _playVideoBlob(blob, title) {
    _vidRelease();
    _vidObjUrl = URL.createObjectURL(blob);
    _mountVideoPlayer(_vidObjUrl, title, { savedFull: true });
}

/** Normal path: stream through the built-in service worker. Returns false when the worker could not be primed. */
async function _playVideoStream(fileId, title, sessionPayload, offline) {
    const ctx = { u: APPS_SCRIPT_URL, c: sessionPayload.code, e: sessionPayload.email, d: sessionPayload.device_fp };
    if (!(await _vidSendCtx(fileId, ctx))) return false;
    if (_vidCurrentId !== fileId) return true;   // closed while preparing
    const src = new URL('__kvid__/' + encodeURIComponent(fileId) + '.mp4', _vidReg.scope).href;
    const info = await _vidSavedInfo(fileId);
    const complete = !!(info && info.count && info.have >= info.count);
    _mountVideoPlayer(src, title, {
        savedFull: complete,
        onFirstPlay: function () {
            // keep downloading ahead (and saving) while the student watches
            if (!offline && !complete && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'VID_FILL', id: fileId });
            }
        }
    });
    return true;
}

/**
 * Download a video through the Gatekeeper in chunks (first chunk alone, the rest 3 at a time).
 * Returns { success:true, blob } or the Gatekeeper's failure reply. Throws AbortError when cancelled.
 */
async function _downloadVideoChunks(fileId, sessionPayload, signal) {
    const CHUNK = 3 * 1024 * 1024, PARALLEL = 3, RETRIES = 3;

    async function fetchChunk(start) {
        let last = null;
        for (let a = 0; a < RETRIES; a++) {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            try {
                const res = await fetch(APPS_SCRIPT_URL, {
                    method: 'POST',
                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                    body: JSON.stringify({ action: 'get_video_chunk', file_id: fileId, start: start, length: CHUNK, session: sessionPayload }),
                    signal: signal
                });
                const j = await res.json();
                if (j && j.success && j.data && typeof j.data.base64 === 'string') return j;
                last = j;
                const code = j && (j.code || (j.data && j.data.code));
                if (_isDefinitiveDenial(j) || code === 'DRIVE_UNAVAILABLE') return j;   // retrying will not change the answer
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                last = { success: false, message: 'Network error' };
            }
            await new Promise(function (r) { setTimeout(r, 800 * (a + 1)); });
        }
        return last || { success: false, message: 'Download failed' };
    }

    _docProgressStart();
    const first = await fetchChunk(0);
    if (!(first && first.success && first.data)) return first;

    const total = first.data.total;
    if (!total || total > _VID_MAX_BYTES) return { success: false, message: 'Video unavailable: file is too large for this device.' };
    const mime = first.data.mimeType || 'video/mp4';
    const count = Math.ceil(total / CHUNK);
    const parts = new Array(count);

    _docProg.total = total;
    _docProg.stage = 'transfer';
    function keep(i, b64) {
        const bytes = _b64ToBytes(b64);
        parts[i] = bytes;
        _docProg.got += bytes.length;
    }
    keep(0, first.data.base64);

    let next = 1, failure = null;
    async function worker() {
        while (!failure) {
            const i = next++;
            if (i >= count) return;
            const r = await fetchChunk(i * CHUNK);
            if (!(r && r.success && r.data)) { failure = r || { success: false, message: 'Download failed' }; return; }
            keep(i, r.data.base64);
        }
    }
    const workers = [];
    for (let w = 0; w < Math.min(PARALLEL, count - 1); w++) workers.push(worker());
    await Promise.all(workers);
    if (failure) return failure;

    let got = 0;
    for (let i = 0; i < count; i++) { if (!parts[i]) return { success: false, message: 'Download incomplete' }; got += parts[i].length; }
    if (got !== total) return { success: false, message: 'Download incomplete. Please try again.' };

    return { success: true, blob: new Blob(parts, { type: mime }) };
}

/** Server check before a saved copy is used. true = go ahead; false = the UI was already handled. */
async function _vidVerifyOnline(fileId, sessionPayload) {
    const lt = document.getElementById('doc-loader-text');
    if (lt) lt.textContent = 'Verifying access...';
    let allowed = false, timedOut = false;
    const vctl = new AbortController();
    _docAbort = vctl;
    const vtimer = setTimeout(() => { timedOut = true; vctl.abort(); }, 8000);
    try {
        const vres = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({ action: 'verify_video_access', file_id: fileId, session: sessionPayload }),
            signal: vctl.signal
        });
        const vdata = await vres.json();
        if (vdata.success) allowed = true;
        else if (_isDefinitiveDenial(vdata)) { _vidDenied(vdata); return false; }
        else allowed = _localExpiryValid();
    } catch (e) {
        if (e && e.name === 'AbortError' && !timedOut) return false;      // the student closed the viewer
        allowed = _localExpiryValid();
    } finally { clearTimeout(vtimer); }
    if (!allowed) {
        closeDocViewer();
        showAppNotification("⏳ Session expired. Connect to internet to verify.", "warning");
        return false;
    }
    return true;
}

/** Fallback path: download everything first, save a Blob, then play. */
async function _vidDownloadThenPlay(fileId, title, sessionPayload, key) {
    const lt = () => document.getElementById('doc-loader-text');
    const _vMeta = (_videosCache[currentTermKey] || []).find(x => String(x.fileId) === String(fileId));
    const _vSize = _vMeta && _vMeta.size ? ' (' + _vMeta.size + ')' : '';
    if (lt()) lt().textContent = 'Downloading securely' + _vSize + '. Keep this window open: the video plays when the download finishes and is saved for offline use.';
    _docAbort = new AbortController();
    const myAbort = _docAbort;
    const result = await _downloadVideoChunks(fileId, sessionPayload, myAbort.signal);
    if (myAbort.signal.aborted) return;   // viewer closed / another file opened meanwhile

    if (result && result.success && result.blob) {
        _docProgressFinish();
        _playVideoBlob(result.blob, title);
        const saved = await saveDocOffline(key, result.blob);
        const quota = !saved && _lastOfflineError && (_lastOfflineError.name === 'QuotaExceededError' || /quota/i.test(String(_lastOfflineError.message || '')));
        if (saved) {
            const persisted = await _ensurePersistentStorage();
            showAppNotification("✅ Saved. This video now plays offline.", "info", 2500);
            if (!persisted) setTimeout(_offlineTipOnce, 3000);
        } else {
            showAppNotification(quota
                ? "⚠️ Your phone is low on storage, so this video could not be saved for offline use."
                : "⚠️ This video could not be saved for offline use. It will download again next time.", "warning", 6000);
        }
    } else {
        _vidDenied(result);
    }
}

// Video access bouncer — same order as documents: instant viewer, local expiry when offline,
// server check before any saved copy is used, then stream (or download) through the Gatekeeper.
async function attemptOpenVideo(fileId, title) {
    if (!hasFullAccess) {
        showAppNotification("⚠️ Videos are only accessible in Full Access mode.", "warning", 2500);
        setTimeout(() => { openPaymentModal(); }, 1000);
        return;
    }

    const key = 'vid_' + fileId;
    const sessionPayload = { code: userCode, email: userEmail, device_fp: deviceFP || localStorage.getItem('device_fp') || 'unknown' };
    const loaderText = () => document.getElementById('doc-loader-text');

    showDocViewerLoading(title);
    _vidCurrentId = fileId;
    _vidFailHandled = false;
    if (loaderText()) loaderText().textContent = 'Preparing video...';

    const swReady = await _vidEnsureSW();
    if (_vidCurrentId !== fileId) return;   // the student closed the viewer or opened another video

    // ── OFFLINE: local expiry check, then a saved copy ──
    if (!navigator.onLine) {
        if (!_localExpiryValid()) {
            closeDocViewer();
            showAppNotification("⏳ Session expired. Connect to internet to verify.", "warning");
            return;
        }
        const legacy = await getOfflineDoc(key);
        if (legacy instanceof Blob) { _playVideoBlob(legacy, title); return; }
        const info = swReady ? await _vidSavedInfo(fileId) : null;
        if (info && info.count && info.have >= info.count && await _playVideoStream(fileId, title, sessionPayload, true)) return;
        closeDocViewer();
        showAppNotification("📡 You are offline and haven't saved this video yet.", "warning");
        return;
    }

    try {
        // ── ONLINE with something already saved: the server must still say yes ──
        const legacy = await getOfflineDoc(key);
        const info = swReady ? await _vidSavedInfo(fileId) : null;
        if (legacy instanceof Blob || info) {
            if (!(await _vidVerifyOnline(fileId, sessionPayload))) return;
            if (_vidCurrentId !== fileId) return;
            if (legacy instanceof Blob) { _playVideoBlob(legacy, title); return; }
        }

        // ── ONLINE: stream through the Gatekeeper (it checks access on the first chunk) ──
        if (swReady && await _playVideoStream(fileId, title, sessionPayload, false)) return;

        // ── The streaming player could not start: no download screen, just say why ──
        closeDocViewer();
        showAppNotification(swReady
            ? "⚠️ Could not start the video. Check your connection and try again."
            : "⚠️ Video player is still starting. Please refresh the page once (needs HTTPS) and open the video again.", "error", 6000);
    } catch (e) {
        if (e && e.name === 'AbortError') return;   // the student cancelled / closed the viewer
        closeDocViewer();
        showAppNotification("⚠️ Connection error. Could not load the video.", "error");
    }
}

// ============================================================
// === 4. SECURITY & AUTHENTICATION (GATEKEEPER) ===
// === v1.1 PATCH: three-reason session check + days_remaining tiers ===
// === All calls route to APPS_SCRIPT_URL → Gatekeeper backend ===
// ============================================================

async function checkAccessStatus() {
    const storedToken = localStorage.getItem(`token_${currentTermKey}`);
    const storedExpiry = localStorage.getItem(`expiry_${currentTermKey}`);
    const storedEmail = localStorage.getItem(`email_${currentTermKey}`);
    const storedCode = localStorage.getItem(`code_${currentTermKey}`);
    
    if (storedToken && storedExpiry && Date.now() < parseInt(storedExpiry) && storedEmail && storedCode) {
        userEmail = storedEmail;
        userCode = storedCode;
        enableFullAccessUI();
        // After enabling UI, fetch session status to update banner
        checkSessionStatus();
        // Start silent revalidation
        startSilentRevalidation();
        return;
    }
    enableDemoUI();
}

async function verifyCodeFromModal() {
    const userCodeInput = document.getElementById('access-code-input').value.trim();
    if (!userCodeInput) return alert("Please enter a code.");
    const userEmailInput = prompt("Enter the Email you used to pay:"); 
    if (!userEmailInput) return alert("Email required for verification.");

    // Generate or retrieve device fingerprint
    deviceFP = localStorage.getItem('device_fp');
    if (!deviceFP) {
        deviceFP = navigator.userAgent + "_" + Math.random().toString(36).substring(7);
        localStorage.setItem('device_fp', deviceFP);
    }

    showAppNotification("🔍 Verifying with Server...", "info");

    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
                action: 'validate_access_code',   // Gatekeeper action
                code: userCodeInput,
                email: userEmailInput,
                device_fp: deviceFP,
                course: currentCourse,
                term: currentTerm
            })
        });

        const result = await response.json();

        if (result.success) {
            // Store session data
            const expiryTimestamp = result.data.expiry_timestamp;
            const sessionToken = result.data.session_token;
            localStorage.setItem(`token_${currentTermKey}`, sessionToken || "VALID");
            localStorage.setItem(`expiry_${currentTermKey}`, expiryTimestamp);
            localStorage.setItem(`email_${currentTermKey}`, userEmailInput);
            localStorage.setItem(`code_${currentTermKey}`, userCodeInput);
            
            userEmail = userEmailInput;
            userCode = userCodeInput;
            
            closePaymentModal();
            enableFullAccessUI();
            
            // Fetch session status and start silent revalidation
            checkSessionStatus();
            startSilentRevalidation();
            
            showAppNotification("✅ " + result.message, "success");
        } else {
            showAppNotification("❌ " + result.message, "error");
        }
    } catch (e) {
        showAppNotification("⚠️ Connection Error. Check internet.", "error");
    }
}

// ============================================================
// === NEW: Silent Revalidation & Session Status (GATEKEEPER) ===
// ============================================================

async function silentRevalidation() {
    if (!hasFullAccess || !userEmail || !userCode) return;
    
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
                action: 'silent_revalidation',   // Gatekeeper action
                email: userEmail,
                code: userCode,
                session_token: localStorage.getItem(`token_${currentTermKey}`) || ''
            })
        });
        const result = await response.json();
        if (!result.success) {
            if (!_isDefinitiveSessionFailure(result.message)) {
                console.warn('Silent revalidation: server hiccup, keeping session', result.message);   // e.g. "Validation error"
                return;
            }
            // Session really invalid – log out
            handleSessionExpired(result.message);
        }
    } catch (e) {
        // Network error – ignore, but could optionally show a warning after several failures
        console.warn('Silent revalidation failed', e);
    }
}

async function checkSessionStatus() {
    if (!hasFullAccess || !userEmail || !userCode) return;
    
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
                action: 'check_session_status',   // Gatekeeper action
                email: userEmail,
                code: userCode
            })
        });
        const result = await response.json();
        
        if (!result.success) {
            // Session invalid — generic reason from server (but not an Apps Script hiccup such as "Status check failed")
            if (!_isDefinitiveSessionFailure(result.message)) {
                console.warn('Session status: server hiccup, keeping session', result.message);
                return;
            }
            handleSessionExpired(result.message);
            return;
        }
        
        const data = result.data;
        
        // ── three specific reasons for invalidity, each with its own message ──
        if (data.email_match === false) {
            handleSessionExpired('This code belongs to a different account.');
            return;
        }
        if (data.is_active === false) {
            handleSessionExpired('Your access has been revoked.');
            return;
        }
        if (data.is_expired === true) {
            handleSessionExpired('Your subscription has expired.');
            return;
        }
        
        // Update banner with expiry date
        if (data.expiry_date) {
            const expiryDate = new Date(data.expiry_date);
            updateModeBanner(`✅ FULL ACCESS (expires ${expiryDate.toLocaleDateString()})`);
            
            // Show notification with days remaining
            if (data.days_remaining !== null && data.days_remaining !== undefined) {
                const days = data.days_remaining;
                if (days > 0) {
                    showAppNotification(`ℹ️ Your license expires in ${days} day(s).`, 'info', 5000);
                } else if (days === 0) {
                    showAppNotification(`⚠️ Your license expires today!`, 'warning', 7000);
                }
            }
        }
    } catch (e) {
        console.warn('Session status check failed', e);
    }
}

function handleSessionExpired(message) {
    // Clear all stored session data
    localStorage.removeItem(`token_${currentTermKey}`);
    localStorage.removeItem(`expiry_${currentTermKey}`);
    localStorage.removeItem(`email_${currentTermKey}`);
    localStorage.removeItem(`code_${currentTermKey}`);
    hasFullAccess = false;
    userEmail = '';
    userCode = '';
    if (revalidationInterval) {
        clearInterval(revalidationInterval);
        revalidationInterval = null;
    }
    // Halt any document currently on screen and delete all offline copies
    closeDocViewer();
    clearOfflineDocs();
    // Drop the in-memory lists and the saved video list, then reload them for the demo view
    Object.keys(_docsCache).forEach(function (k) { delete _docsCache[k]; });
    Object.keys(_videosCache).forEach(function (k) { delete _videosCache[k]; });
    try { localStorage.removeItem('kaeri_videos_' + currentTermKey); } catch (e) {}
    if (currentCourse && currentTerm) {
        _loadDocsAvailability(currentTermKey, currentCourse, currentTerm);
        _loadVideosAvailability(currentTermKey, currentCourse, currentTerm);
    }
    enableDemoUI();
    showAppNotification(`⏳ ${message || 'Session expired. Please log in again.'}`, 'warning');
}

function startSilentRevalidation() {
    if (revalidationInterval) clearInterval(revalidationInterval);
    // Run every 5 minutes
    revalidationInterval = setInterval(silentRevalidation, KAERI_CONFIG.revalidationMs);
    // Also run once immediately after a short delay
    setTimeout(silentRevalidation, KAERI_CONFIG.revalidationWarmupMs);
}

// ============================================================
// === NEW: Silent Analytics Logging (GATEKEEPER) ===
// ============================================================

function logAnalyticsEvent(actionType, details) {
    // Fire and forget – user never sees this
    fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
            action: 'log_system_event',   // Gatekeeper action
            email: userEmail || (hasFullAccess ? 'full_access' : 'demo'),
            actionType: actionType,
            course: currentCourse,
            term: currentTerm,
            details: details,
            device_fp: deviceFP || localStorage.getItem('device_fp') || 'unknown'
        })
    }).catch(() => {}); // Silent failure
}

// ============================================================
// === MODIFIED: Demo Limit Function (Documents bypass) ===
// ============================================================

function blockDemo(type) {
    // Documents are always visible (just locked), so don't count attempts
    if (type === 'documents') return false;
    
    if (hasFullAccess) return false;
    
    const key = `demo_${type}_used_${currentTermKey}`;
    let attempts = parseInt(localStorage.getItem(key) || "0");
    const maxAttempts = getDemoLimit();
    const attemptsLeft = maxAttempts - attempts;
    
    if (attempts < maxAttempts) {
        showAppNotification(`Demo Mode: ${attemptsLeft} attempts remaining.`, "info", 2000);
    }
    
    if (attempts >= maxAttempts) {
        showAppNotification(`Demo limit reached. Unlock Full Access!`, "warning");
        openPaymentModal(); 
        return true;
    }
    
    localStorage.setItem(key, attempts + 1);
    return false;
}

// ── Peek: has this term's demo budget for `type` any charges left? ──
// Does NOT modify storage, does NOT notify.
function canUseDemo(type) {
    if (type === 'documents') return true;
    if (hasFullAccess) return true;
    const key = `demo_${type}_used_${currentTermKey}`;
    const attempts = parseInt(localStorage.getItem(key) || "0");
    return attempts < getDemoLimit();
}

// ── Charge: consume one attempt and notify the user. ──
// Callers must check canUseDemo() first if they want to gate the action.
function consumeDemoAttempt(type) {
    if (type === 'documents') return;
    if (hasFullAccess) return;

    const key = `demo_${type}_used_${currentTermKey}`;
    const attempts = parseInt(localStorage.getItem(key) || "0");
    const maxAttempts = getDemoLimit();
    const attemptsLeft = maxAttempts - attempts;

    if (attemptsLeft > 0) {
        showAppNotification(`Demo Mode: ${attemptsLeft} attempts remaining.`, "info", 2000);
    }
    localStorage.setItem(key, attempts + 1);
}
// ============================================================
// === 5. PROGRESS TRACKING ENGINE (localStorage only) ===
// ============================================================

const PROGRESS_KEY_PREFIX = 'kaeri_progress_v1_';

function _progressKey() {
    return `${PROGRESS_KEY_PREFIX}${currentTermKey}`;
}

function _loadProgress() {
    try {
        return JSON.parse(localStorage.getItem(_progressKey()) || 'null') || {
            sessions: [],
            streak: { count: 0, lastDate: null },
            totalQuestions: 0,
            totalCorrect: 0,
            flashcardSessions: 0,
            mcqBest: 0,
            saBest: 0,
            essayBest: 0
        };
    } catch(e) {
        return {
            sessions: [],
            streak: { count: 0, lastDate: null },
            totalQuestions: 0,
            totalCorrect: 0,
            flashcardSessions: 0,
            mcqBest: 0,
            saBest: 0,
            essayBest: 0
        };
    }
}

function _saveProgress(data) {
    try {
        if (data.sessions.length > 60) {
            data.sessions = data.sessions.slice(-60);
        }
        localStorage.setItem(_progressKey(), JSON.stringify(data));
    } catch(e) {}
}

function _updateStreak(data) {
    const today = new Date().toISOString().slice(0, 10);
    const last  = data.streak.lastDate;
    if (last === today) return;
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    if (last === yesterday) {
        data.streak.count += 1;
    } else {
        data.streak.count = 1;
    }
    data.streak.lastDate = today;
}

function recordProgressSession(type, score, total, label) {
    if (!currentTermKey) return;
    const data    = _loadProgress();
    const percent = total > 0 ? Math.round((score / total) * 100) : 0;
    data.sessions.push({ type, score, total, percent, ts: Date.now(), label: label || type });
    if (type !== 'flashcard') {
        data.totalQuestions += total;
        data.totalCorrect   += score;
    }
    if (type === 'mcq')         data.mcqBest          = Math.max(data.mcqBest,   percent);
    if (type === 'shortAnswer') data.saBest            = Math.max(data.saBest,    percent);
    if (type === 'essay')       data.essayBest         = Math.max(data.essayBest, percent);
    if (type === 'flashcard')   data.flashcardSessions += 1;
    _updateStreak(data);
    _saveProgress(data);
}

function _timeAgo(ts) {
    const diff  = Date.now() - ts;
    const mins  = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days  = Math.floor(diff / 864e5);
    if (mins  < 1)   return 'just now';
    if (mins  < 60)  return `${mins}m ago`;
    if (hours < 24)  return `${hours}h ago`;
    if (days  === 1) return 'yesterday';
    return `${days}d ago`;
}

function _confirmResetProgress() {
    const m = document.getElementById('reset-modal');
    if (m) m.classList.add('show');
}

function renderProgressDashboard() {
    const container = document.getElementById('quiz-form');
    container.innerHTML = '';
    document.getElementById('result').innerHTML = '';
    currentQuizType = 'dashboard';
    updateProgress(0, 0);

    if (!currentTermKey) {
        container.innerHTML = '<p style="text-align:center;color:#a0a8b4;">Load a course first.</p>';
        return;
    }

    const data     = _loadProgress();
    const sessions = data.sessions;

    const overallPct = data.totalQuestions > 0
        ? Math.round((data.totalCorrect / data.totalQuestions) * 100) : 0;

    const last7  = sessions.filter(s => Date.now() - s.ts < 7  * 864e5);
    const last30 = sessions.filter(s => Date.now() - s.ts < 30 * 864e5);
    const recent = sessions.slice(-10);

    function modeAvg(type) {
        const s = sessions.filter(x => x.type === type && x.total > 0);
        if (!s.length) return null;
        return Math.round(s.reduce((a, b) => a + b.percent, 0) / s.length);
    }
    const mcqAvg = modeAvg('mcq');
    const saAvg  = modeAvg('shortAnswer');
    const esAvg  = modeAvg('essay');

    const streakCount = data.streak.count || 0;
    const streakColor = streakCount >= 7 ? '#ffc107' : streakCount >= 3 ? '#72efdd' : '#a0a8b4';

    function bar(pct, color) {
        if (pct === null) return '<span style="color:#555;font-size:0.85em;">No data yet</span>';
        const fill = Math.max(0, Math.min(100, pct));
        return `<div style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;height:8px;background:#2b3a55;border-radius:4px;overflow:hidden;">
                <div style="width:${fill}%;height:100%;background:${color};border-radius:4px;"></div>
            </div>
            <span style="font-size:0.85em;color:white;font-weight:700;min-width:36px;text-align:right;">${pct}%</span>
        </div>`;
    }

    function sparkline(pts) {
        if (!pts.length) return '<span style="color:#555;font-size:0.8em;">No sessions yet</span>';
        const W = 200, H = 40, pad = 4;
        const maxV = Math.max(...pts.map(p => p.percent), 1);
        const xs = pts.map((_, i) => pad + i * ((W - pad*2) / Math.max(pts.length - 1, 1)));
        const ys = pts.map(p => H - pad - (p.percent / 100) * (H - pad*2));
        const poly = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
        const dots = pts.map((p, i) => {
            const c = p.percent >= 70 ? '#72efdd' : p.percent >= 50 ? '#ffc107' : '#ef4444';
            return `<circle cx="${xs[i]}" cy="${ys[i]}" r="3" fill="${c}"/>`;
        }).join('');
        return `<svg width="${W}" height="${H}" style="overflow:visible;display:block;">
            <polyline points="${poly}" fill="none" stroke="#3e506e" stroke-width="1.5" stroke-linejoin="round"/>
            ${dots}
        </svg>`;
    }

    function sessionList() {
        const rev = [...sessions].reverse().slice(0, 5);
        if (!rev.length) return '<p style="color:#555;font-size:0.85em;text-align:center;">No sessions yet.</p>';
        const icon = { mcq:'\uD83D\uDCDD', shortAnswer:'\u270D\uFE0F', essay:'\uD83D\uDCC4', flashcard:'\uD83C\uDCCF' };
        return rev.map(s => {
            const color = s.percent >= 70 ? '#72efdd' : s.percent >= 50 ? '#ffc107' : '#ef4444';
            const lbl   = s.type === 'flashcard'
                ? `${icon[s.type]||'\uD83D\uDCDA'} ${s.label} \u2014 ${s.total} cards`
                : `${icon[s.type]||'\uD83D\uDCDA'} ${s.label} \u2014 ${s.score}/${s.total} (${s.percent}%)`;
            return `<div style="display:flex;justify-content:space-between;align-items:center;
                        padding:9px 12px;border-radius:8px;background:#0d1b2a;
                        border-left:3px solid ${color};margin-bottom:6px;">
                <span style="font-size:0.88em;color:white;">${lbl}</span>
                <span style="font-size:0.75em;color:#555;white-space:nowrap;margin-left:8px;">${_timeAgo(s.ts)}</span>
            </div>`;
        }).join('');
    }

    container.innerHTML = `
    <div style="max-width:520px;margin:0 auto;padding:4px;">

        <div style="text-align:center;margin-bottom:20px;">
            <h2 style="color:white;margin:0 0 4px 0;">\uD83D\uDCCA My Progress</h2>
            <p style="color:#a0a8b4;font-size:0.85em;margin:0;">${currentCourse} ${currentTerm}</p>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:18px;">
            <div style="background:#1e2a3a;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #2b3a55;">
                <div style="font-size:1.6em;font-weight:900;color:#72efdd;">${overallPct}%</div>
                <div style="font-size:0.72em;color:#a0a8b4;margin-top:3px;">Overall Accuracy</div>
            </div>
            <div style="background:#1e2a3a;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #2b3a55;">
                <div style="font-size:1.6em;font-weight:900;color:${streakColor};">${streakCount}\uD83D\uDD25</div>
                <div style="font-size:0.72em;color:#a0a8b4;margin-top:3px;">Day Streak</div>
            </div>
            <div style="background:#1e2a3a;border-radius:10px;padding:14px 10px;text-align:center;border:1px solid #2b3a55;">
                <div style="font-size:1.6em;font-weight:900;color:white;">${sessions.length}</div>
                <div style="font-size:0.72em;color:#a0a8b4;margin-top:3px;">Total Sessions</div>
            </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;">
            <div style="background:#1e2a3a;border-radius:10px;padding:12px;border:1px solid #2b3a55;">
                <div style="font-size:0.72em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;">Questions Answered</div>
                <div style="font-size:1.3em;font-weight:700;color:white;">${data.totalQuestions.toLocaleString()}</div>
                <div style="font-size:0.75em;color:#72efdd;">${data.totalCorrect.toLocaleString()} correct</div>
            </div>
            <div style="background:#1e2a3a;border-radius:10px;padding:12px;border:1px solid #2b3a55;">
                <div style="font-size:0.72em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px;">Activity</div>
                <div style="font-size:0.85em;color:white;">Last 7 days: <strong style="color:#72efdd;">${last7.length}</strong></div>
                <div style="font-size:0.85em;color:white;">Last 30 days: <strong style="color:#72efdd;">${last30.length}</strong></div>
            </div>
        </div>

        <div style="background:#1e2a3a;border-radius:10px;padding:16px;border:1px solid #2b3a55;margin-bottom:18px;">
            <div style="font-size:0.78em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:14px;">Performance by Mode</div>
            <div style="margin-bottom:10px;${_dashModeVisible('renderQuiz', data.mcqBest) ? '' : 'display:none;'}">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:0.85em;color:white;">\uD83D\uDCDD MCQ</span>
                    <span style="font-size:0.75em;color:#a0a8b4;">Best: ${data.mcqBest}%</span>
                </div>
                ${bar(mcqAvg, '#72efdd')}
            </div>
            <div style="margin-bottom:10px;${_dashModeVisible('renderShortAnswers', data.saBest) ? '' : 'display:none;'}">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:0.85em;color:white;">\u270D\uFE0F Short Answer</span>
                    <span style="font-size:0.75em;color:#a0a8b4;">Best: ${data.saBest}%</span>
                </div>
                ${bar(saAvg, '#ffc107')}
            </div>
            <div style="margin-bottom:2px;${_dashModeVisible('renderEssaySimulation', data.essayBest) ? '' : 'display:none;'}">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:0.85em;color:white;">\uD83D\uDCC4 Essay Sim</span>
                    <span style="font-size:0.75em;color:#a0a8b4;">Best: ${data.essayBest}%</span>
                </div>
                ${bar(esAvg, '#e67e00')}
            </div>
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid #2b3a55;${_dashModeVisible('renderFlashcardTopics', data.flashcardSessions) ? '' : 'display:none;'}">
                <span style="font-size:0.85em;color:white;">\uD83C\uDCCF Flashcard Sessions</span>
                <span style="float:right;font-size:0.85em;color:#a78bfa;font-weight:700;">${data.flashcardSessions}</span>
            </div>
        </div>

        <div style="background:#1e2a3a;border-radius:10px;padding:16px;border:1px solid #2b3a55;margin-bottom:18px;">
            <div style="font-size:0.78em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;">Score Trend (last ${recent.filter(s=>s.type!=='flashcard').length} quiz sessions)</div>
            <div style="overflow-x:auto;">${sparkline(recent.filter(s => s.type !== 'flashcard'))}</div>
            <div style="margin-top:8px;display:flex;gap:14px;font-size:0.72em;color:#a0a8b4;">
                <span><span style="color:#72efdd;">●</span> \u226570%</span>
                <span><span style="color:#ffc107;">●</span> 50\u201369%</span>
                <span><span style="color:#ef4444;">●</span> &lt;50%</span>
            </div>
        </div>

        <div style="background:#1e2a3a;border-radius:10px;padding:16px;border:1px solid #2b3a55;margin-bottom:20px;">
            <div style="font-size:0.78em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;">Recent Sessions</div>
            ${sessionList()}
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:10px;">
            <button onclick="exitQuiz()" class="back-button" style="margin:0;">\u2B05\uFE0F Back to Course</button>
            <button onclick="_confirmResetProgress()"
                style="background:transparent;color:#ef4444;border:1px solid #ef4444;
                       padding:10px 16px;border-radius:8px;cursor:pointer;font-size:0.85em;">
                \uD83D\uDDD1\uFE0F Reset Progress
            </button>
        </div>
    </div>`;
}

// ============================================================
// === 5b. UI & NAVIGATION ===
// === v1.1 PATCH: + overlay manager, shell actions, focus utilities ===
// ============================================================

// --- Overlay manager (stack-based) ---
// Later rounds refactor existing modals (payment, print preview, doc viewer)
// to push/pop through these; for now they're a utility available to callers.
const overlayStack = [];

function openOverlay(el, trigger) {
    if (!el) return;
    overlayStack.push({
        el: el,
        trigger: trigger || document.activeElement,
        prevFocus: document.activeElement
    });
    el.classList.add('show');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    syncBodyScroll();
    const autofocus = el.querySelector('[data-autofocus]') || el;
    setTimeout(function () { focusAndReveal(autofocus); }, 50);
}

function closeOverlay(el) {
    if (!el) return;
    const i = overlayStack.findIndex(function (o) { return o.el === el; });
    if (i === -1) {
        el.classList.remove('show');
        syncBodyScroll();
        return;
    }
    const entry = overlayStack.splice(i, 1)[0];
    el.classList.remove('show');
    syncBodyScroll();
    if (entry.prevFocus && document.contains(entry.prevFocus)) {
        focusAndReveal(entry.prevFocus, { behavior: 'auto' });
    }
}

function syncBodyScroll() {
    document.body.style.overflow = overlayStack.length > 0 ? 'hidden' : '';
}

// --- Focus utilities (reduced-motion aware) ---
function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function focusAndReveal(el, opts) {
    if (!el) return;
    opts = opts || {};
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    try {
        el.scrollIntoView({
            block: 'nearest',
            inline: 'nearest',
            behavior: opts.behavior || (prefersReducedMotion() ? 'auto' : 'smooth')
        });
    } catch (e) {}
}

function mountScreen(el) {
    // Accessibility only: screen readers land on the new screen. Scrolling is handled by _focusScreen().
    if (!el) return;
    el.setAttribute('tabindex', '-1');
    try { el.focus({ preventScroll: true }); } catch (e) {}
}

// --- Shell action bar ---
// Renders the mode's footer buttons + an automatic "Back to Courses" chip
// whenever a course is loaded. All existing modes keep their current buttons;
// this is a new helper that later rounds route them through.
function setShellActions(buttons) {
    const bar = document.querySelector('.shell-actions');
    if (!bar) return;
    bar.innerHTML = '';

    if (currentCourse && currentTerm) {
        const backChip = document.createElement('button');
        backChip.className = 'back-button';
        backChip.innerHTML = '📚 Back to Courses';
        backChip.onclick = function () { backToMenu(); };
        backChip.style.background = '#2b3a55';
        backChip.style.color = '#72efdd';
        backChip.style.border = '1px solid #3e506e';
        backChip.style.fontWeight = '600';
        backChip.style.flexShrink = '0';
        bar.appendChild(backChip);
    }

    (buttons || []).forEach(function (btn) {
        if (!btn) return;
        btn.style.marginTop = '0';
        bar.appendChild(btn);
    });
}

// --- Existing UI state handlers (unchanged) ---

function enableFullAccessUI() {
    hasFullAccess = true;
    updateModeBanner("✅ FULL ACCESS"); // Will be updated with expiry by checkSessionStatus
    const banner = document.getElementById('mode-banner');
    if(banner) {
        banner.className = 'full-access-banner';
        banner.classList.remove('demo-mode-banner');
    }
    const unlockBtn = document.getElementById('unlock-btn');
    if(unlockBtn) unlockBtn.style.display = 'none';
    const priceChip = document.getElementById('price-banner');
    if(priceChip) priceChip.style.display = 'none';
    clearDemoLocks();
}

function enableDemoUI() {
    hasFullAccess = false;
    updateModeBanner("🔒 Demo Mode");
    const banner = document.getElementById('mode-banner');
    if(banner) {
        banner.className = 'demo-mode-banner';
        banner.classList.remove('full-access-banner');
    }
    const unlockBtn = document.getElementById('unlock-btn');
    if(unlockBtn) unlockBtn.style.display = 'block';
    const priceChip = document.getElementById('price-banner');
    if(priceChip) priceChip.style.display = 'block';
}

function loadCourse(course, term) {
    // Mode kill switch: the previous term's modes/data must never be usable under the new term's title.
    hideModeButtons();
    currentMcqData = []; currentShortData = []; currentEssayData = []; currentFlashcardTopics = {};
    document.body.setAttribute('data-course', course);
    document.body.setAttribute('data-term', term);

    // Prices and durations are never passed in; they always come from the live config.
    const termLabel = String(term).replace(/^T/i, '');
    const titleEl = document.getElementById('course-title');
    if (titleEl) titleEl.textContent = course + ' Term ' + termLabel + ' Study Materials';

    renderCourseBanner(course, term);
    const banner = document.getElementById('price-banner');
    if (banner) banner.style.display = 'block';
    try { updatePlanCards(course); } catch (e) {}
    // Deep links / slow networks: config may not be here yet. Fetch (or refresh a stale copy) and re-render.
    loadSystemConfig().catch(function () { refreshPriceUI(); });
    navigate({ course: course, term: term });   // Back button returns to the previous screen

    const landing = document.getElementById('landing-view');
    if (landing) landing.style.display = 'none';
    const landH = document.getElementById('landing-header');
    if (landH) landH.style.display = 'none';
    const courseView = document.getElementById('course-view');
    if (courseView) courseView.style.display = 'block';
    const fixedH = document.getElementById('fixed-header');
    if (fixedH) fixedH.style.display = 'block';
    document.body.classList.add('view-course');
    window.scrollTo(0, 0);

    setTimeout(function () {
        const qf = document.getElementById('quiz-form');
        const rs = document.getElementById('result');
        if (qf) qf.innerHTML = '';
        if (rs) rs.innerHTML = '';
        updateProgress(0, 0);
        initializeCourseLogic();
    }, KAERI_CONFIG.courseLoadDelayMs);
}

function backToMenu() {
    document.getElementById('landing-view').style.display = 'block';
    document.getElementById('landing-header').style.display = 'block'; 
    document.getElementById('course-view').style.display = 'none';
    document.getElementById('fixed-header').style.display = 'none';
    document.getElementById('price-banner').style.display = 'none';
    document.body.classList.remove('view-course');
    document.body.classList.remove('quiz-running');
    document.body.classList.remove('in-mode');
    document.body.classList.remove('final-screen');
    showCourses(true);

    document.getElementById('quiz-form').innerHTML = '';
    document.getElementById('result').innerHTML = '';
    document.body.removeAttribute('data-course');
    document.body.removeAttribute('data-term');
    stopReading(); 
    closeDocViewer();
    window.scrollTo(0,0);
    
    // Stop revalidation when leaving course
    if (revalidationInterval) {
        clearInterval(revalidationInterval);
        revalidationInterval = null;
    }
}

function toggleTerms(courseId) {
    const termButtons = document.getElementById(courseId + '-terms');
    const courseButton = termButtons.previousElementSibling;
    if (termButtons.style.display === 'flex') {
        termButtons.style.display = 'none';
        courseButton.classList.remove('active');
    } else {
        document.querySelectorAll('.term-buttons').forEach(section => {
            if (section.id !== courseId + '-terms') {
                section.style.display = 'none';
                section.previousElementSibling.classList.remove('active');
            }
        });
        termButtons.style.display = 'flex';
        courseButton.classList.add('active');
    }
}

// ============================================================
// === REPLACED: openPaymentModal (with auto-load) ===
// ============================================================
function openPaymentModal(intent) {
    const modal = document.getElementById('payment-modal');
    if (modal) modal.classList.add('show');

    // A plan card passes { course, term }; every other caller passes nothing.
    purchaseIntent = (intent && typeof intent.course === 'string' && typeof intent.term === 'string')
        ? { course: _up(intent.course), term: _up(intent.term) }
        : null;

    const v = getViewedScope();
    const c = purchaseIntent ? purchaseIntent.course : (v.course || _up(currentCourse));
    const t = purchaseIntent ? purchaseIntent.term   : (v.term   || _up(currentTerm));
    const termName = document.getElementById('pay-term-name');
    if (termName) termName.textContent = (c && t) ? payScopeLabel(c, t) : 'Choose what to unlock';
    _showPayHeader(c, t);

    // ─── LIPILA: reset all views and initialize state ───
    window._lipilaCtx = {
        course: c,
        term: t,
        saleId: null, email: null, timer: null, countdown: null,
        amount: null,
        lipilaEnabled: false,
        pollIntervalMs: 5000,
        abandonTimeoutMinutes: 15
    };
    ['payMethodSelector','lipilaFormView','lipilaPinWaiting','lipilaSuccess','lipilaFailed','lipilaHeld','lipilaExpired'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
    var payViewEl = document.getElementById('pay-view');
    var statusViewEl = document.getElementById('status-view');
    var tabsEl = document.querySelector('.tabs');
    if (payViewEl) payViewEl.classList.add('hidden');
    if (statusViewEl) statusViewEl.classList.add('hidden');
    if (tabsEl) tabsEl.style.display = 'none';

    // Ask backend whether Lipila is available; decide which view to show
    callPaymentApi('getPaymentOptions', {}).then(function(res){
        window._lipilaCtx.lipilaEnabled = !!(res && res.lipilaEnabled);
        window._lipilaCtx.pollIntervalMs = (res && res.pollIntervalMs) || 5000;
        window._lipilaCtx.abandonTimeoutMinutes = (res && res.abandonTimeoutMinutes) || 15;

        // Try to resume an in-flight Lipila payment for the same course/term
        var pendingId = sessionStorage.getItem('lipila_pending_saleId');
        var pendingEmail = sessionStorage.getItem('lipila_pending_email');
        var pendingCourse = sessionStorage.getItem('lipila_pending_course');
        var pendingTerm = sessionStorage.getItem('lipila_pending_term');

        // A payment already in flight always wins over the current selection (prevents double charges).
        if (pendingId && pendingEmail) {
            window._lipilaCtx.saleId = pendingId;
            window._lipilaCtx.email = pendingEmail;
            if (pendingCourse) window._lipilaCtx.course = pendingCourse;
            if (pendingTerm) window._lipilaCtx.term = pendingTerm;
            document.getElementById('lipilaPinWaiting').classList.remove('hidden');
            document.getElementById('lipilaPhoneMasked').textContent =
                '••• ••• ' + (sessionStorage.getItem('lipila_pending_phone') || '').slice(-4);
            document.getElementById('lipilaAmountConfirm').textContent =
                'K' + (sessionStorage.getItem('lipila_pending_amount') || '0.00');
            startLipilaPolling(parseInt(sessionStorage.getItem('lipila_pending_started') || '0', 10) || 0);
            return;
        }

        // Normal flow
        if (window._lipilaCtx.lipilaEnabled) {
            document.getElementById('payMethodSelector').classList.remove('hidden');
        } else {
            if (tabsEl) tabsEl.style.display = '';
            if (payViewEl) payViewEl.classList.remove('hidden');
            var form = document.getElementById('paymentForm');
            if (form) form.classList.remove('hidden');
        }
    }).catch(function(){
        // If getPaymentOptions fails, fall back to manual only
        if (tabsEl) tabsEl.style.display = '';
        if (payViewEl) payViewEl.classList.remove('hidden');
        var form = document.getElementById('paymentForm');
        if (form) form.classList.remove('hidden');
    });

    // Loads (or reuses) live prices, fills the dropdowns and applies purchaseIntent.
    loadCourses();

    // Focus the code input after a short delay
    setTimeout(() => {
        const input = document.getElementById('access-code-input');
        if(input) input.focus();
    }, 400);
}


// ============================================================
// === REPLACED: closePaymentModal with idempotency reset ===
// ============================================================
function closePaymentModal() {
    // Stop any in-flight Lipila polling
    stopLipilaTimers();

    const modal = document.getElementById('payment-modal');
    if (modal) modal.classList.remove('show');

    // Reset the subscription guide (idempotency)
    const guide = document.getElementById('subscription-guide');
    if (guide) guide.removeAttribute('open');
}

function updateModeBanner(message) {
    const banner = document.getElementById("mode-banner");
    if (banner) banner.textContent = message;
}

function showAppNotification(message, type = 'info', duration = 5000) {
    const el = document.getElementById('app-notification');
    if (!el) return alert(message);
    
    const msgSpan = el.querySelector('.notification-message');
    if (msgSpan) msgSpan.textContent = message;
    else el.innerText = message;

    el.className = ''; 
    void el.offsetWidth; 
    el.className = 'show ' + type;

    if (el.timeoutId) clearTimeout(el.timeoutId);
    el.timeoutId = setTimeout(() => {
        el.classList.remove('show');
    }, duration);

    const closeBtn = el.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.onclick = () => {
            el.classList.remove('show');
            clearTimeout(el.timeoutId);
        };
    }
}

function updateProgress(current, total) {
    const fill = document.getElementById("progress-fill");
    const text = document.getElementById("progress-text");
    const percent = total === 0 ? 0 : (current / total) * 100;
    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = `Progress: ${current} of ${total}`;
    const wrap = document.getElementById("progress-wrap");
    if (wrap) wrap.classList.toggle('on', total > 0);
    _syncQuizStrip(current, total, percent);
}

function clearDemoLocks() {
    ["mcq", "shortAnswer", "essay", "flashcard", "documents"].forEach(
        m => localStorage.removeItem(`demo_${m}_used_${currentTermKey}`)
    );
}

// ============================================================
// === NEW: PAYMENT API FUNCTIONS (SERVER 3) ===
// ============================================================

function callPaymentApi(action, payload = {}, retries = 2) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KAERI_CONFIG.paymentTimeoutMs);

    return fetch(PAYMENT_API_URL, {
        method: 'POST',
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...payload }),
        signal: controller.signal
    })
    .then(res => {
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    })
    .catch(err => {
        clearTimeout(timeout);
        if (retries > 0) {
            return new Promise(resolve => setTimeout(resolve, KAERI_CONFIG.paymentRetryGapMs))
                .then(() => callPaymentApi(action, payload, retries - 1));
        }
        throw err;
    });
}

function showAlert(icon, title, text) {
    return Swal.fire({
        icon, title, text,
        background: '#1b263b',
        color: '#e0e6ed',
        confirmButtonColor: '#007bff',
        confirmButtonText: 'OK',
        backdrop: 'rgba(13,27,42,0.85)'
    });
}

/** Amount + duration shown in the modal header. Live values only. */
function _showPayHeader(course, term) {
    const price = (course && term) ? getPriceFor(course, term) : null;
    const days  = (course && term) ? getDurationFor(course, term) : null;
    const amountEl = document.getElementById('pay-amount');
    if (amountEl) amountEl.textContent = price === null ? '—' : 'K' + price.toFixed(2);
    const durEl = document.getElementById('pay-duration');
    if (durEl) durEl.textContent = (price !== null && days) ? formatDays(days) + ' of access' : '';
}

function _hasOption(select, value) {
    return !!select && Array.prototype.some.call(select.options, function (o) { return o.value === value; });
}

/** Select a course + term in the form, synchronously (no timers, no races). */
function selectPurchase(course, term) {
    const cs = document.getElementById('courseSelect');
    const ts = document.getElementById('termSelect');
    if (!cs || !ts) return false;
    const c = _up(course), t = _up(term);
    if (!c || !_hasOption(cs, c)) { updatePrice(); return false; }
    cs.value = c;
    updateTerms();                              // rebuilds term options synchronously
    if (t && _hasOption(ts, t)) ts.value = t;
    updatePrice();
    return true;
}

/** Rebuilds the form from the live config and restores what the student wants selected. */
function renderPaymentForm() {
    const form = document.getElementById('paymentForm');
    if (form) form.classList.remove('hidden');
    const cs = document.getElementById('courseSelect');
    const ts = document.getElementById('termSelect');

    // Priority: card the student just tapped → what they already picked → the course they are studying.
    let want = null;
    if (purchaseIntent) {
        want = purchaseIntent;
        purchaseIntent = null;
    } else if (cs && cs.value) {
        want = { course: cs.value, term: ts ? ts.value : '' };
    } else {
        const v = getViewedScope();
        const c = v.course || _up(currentCourse);
        const t = v.term || _up(currentTerm);
        if (c) want = { course: c, term: t };
    }

    populateCourseDropdown();
    if (want) selectPurchase(want.course, want.term);
    updatePlanCards();
}

function loadCourses() {
    const loader = document.getElementById('init-loader');
    const form = document.getElementById('paymentForm');
    if (!loader || !form) return Promise.resolve();

    const hadCache = SYSTEM_CONFIG.loaded;
    if (hadCache) {
        // Instant: render from the cached config, refresh quietly behind it.
        loader.classList.add('hidden');
        renderPaymentForm();
    } else {
        loader.classList.remove('hidden');
        form.classList.add('hidden');
    }

    return loadSystemConfig()
        .then(function () {
            loader.classList.add('hidden');
            renderPaymentForm();
        })
        .catch(function (err) {
            loader.classList.add('hidden');
            if (!hadCache) {
                showAlert('error', 'Connection Error', (err && err.message && err.message !== 'Failed to fetch')
                    ? err.message : 'Could not reach the server. Check your connection and try again.');
            }
        });
}

function _courseOrder(keys) {
    // Real courses alphabetically, the Global entry (ALL) last.
    return keys.slice().sort(function (a, b) {
        if (a === 'ALL') return 1;
        if (b === 'ALL') return -1;
        return a < b ? -1 : (a > b ? 1 : 0);
    });
}

// Course codes currently rendered in the course list (the program/year the student is browsing).
function getLandingPageCourses() {
    const codes = new Set();
    document.querySelectorAll('#course-list .course-button').forEach(function (btn) {
        const m = btn.textContent.trim().match(/^([A-Z0-9]+)/i);
        if (m) codes.add(m[1].toUpperCase());
    });
    return Array.from(codes);
}

function populateCourseDropdown() {
    const courseSelect = document.getElementById('courseSelect');
    if (!courseSelect) return;
    courseSelect.innerHTML = '<option value="" disabled selected>Select Course...</option>';
    // Only offer courses on the student's current list (+ Global + the course being viewed/bought).
    const onScreen = getLandingPageCourses();
    const keep = new Set(onScreen);
    try {
        const v = getViewedScope();
        if (v && v.course) keep.add(String(v.course).toUpperCase());
        if (purchaseIntent && purchaseIntent.course) keep.add(String(purchaseIntent.course).toUpperCase());
    } catch (e) {}
    const allKeys = Object.keys(inventory || {});
    const visibleKeys = onScreen.length ? allKeys.filter(c => c === 'ALL' || keep.has(c.toUpperCase())) : allKeys;
    _courseOrder(visibleKeys).forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = code === 'ALL' ? 'Global Access (all courses)' : code;
        courseSelect.appendChild(opt);
    });
    const termSelect = document.getElementById('termSelect');
    if (termSelect) {
        termSelect.innerHTML = '<option value="" disabled selected>Select Course First</option>';
        termSelect.disabled = true;
    }
    updatePrice();
}

function updateTerms() {
    const course = document.getElementById('courseSelect')?.value;
    const terms = (inventory && inventory[course]) || {};
    const termSelect = document.getElementById('termSelect');
    if (!termSelect) return;
    termSelect.innerHTML = '<option value="" disabled selected>Select Term...</option>';
    termSelect.disabled = true;
    const termKeys = _courseOrder(Object.keys(terms));
    if (termKeys.length === 0) {
        termSelect.innerHTML = '<option value="" disabled selected>No terms</option>';
        updatePrice();
        return;
    }
    termKeys.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = (t === 'ALL') ? (course === 'ALL' ? 'All courses & terms' : 'All terms (Full Course)') : t;
        termSelect.appendChild(opt);
    });
    termSelect.disabled = false;
    if (termKeys.length === 1) termSelect.value = termKeys[0];   // e.g. Global Access has only one choice
    updatePrice();
}

/** One function renders every price/duration line in the modal. Live values only. */
function updatePrice() {
    const course = document.getElementById('courseSelect')?.value;
    const term = document.getElementById('termSelect')?.value;
    const display = document.getElementById('priceDisplay');
    const durDisplay = document.getElementById('durationDisplay');

    const ready = !!(course && term);
    const price = ready ? getPriceFor(course, term) : null;
    const days  = ready ? getDurationFor(course, term) : null;

    if (display) display.textContent = price !== null ? 'K' + price.toFixed(2) : 'K0.00';
    if (durDisplay) durDisplay.textContent = (price !== null && days) ? formatDays(days) + ' (starts on first use)' : '—';
    const devices = ready ? getMaxDevicesFor(course, term) : null;
    const devRow = document.getElementById('devicesRow');
    const devEl = document.getElementById('devicesDisplay');
    if (devRow) devRow.style.display = (price !== null && devices) ? 'flex' : 'none';
    if (devEl) devEl.textContent = devices ? devices + (devices === 1 ? ' device' : ' devices') : '—';

    if (ready) {
        const termName = document.getElementById('pay-term-name');
        if (termName) termName.textContent = payScopeLabel(course, term);
        _showPayHeader(course, term);
    } else {
        _showPayHeader('', '');
    }
    updatePlanCards();
    lipilaSyncFromForm();
}


// ═══════════════════════════════════════════════════════════
// ═══ LIPILA FRONTEND FUNCTIONS ═══
// ═══════════════════════════════════════════════════════════

/** Local shims — safe even if toast / isValidZambianMobile don't exist elsewhere */
function _lipilaToast(msg, type) {
    return showAppNotification(String(msg || ''), type || 'info');
}
function _lipilaValidPhone(p) {
    return /^(\+260|0)(9[5-7]|7[5-7])\d{7}$/.test(String(p || '').replace(/[\s-]/g, ''));
}

function selectPaymentMethod(method) {
    var payViewEl = document.getElementById('pay-view');
    var tabsEl = document.querySelector('.tabs');
    var form = document.getElementById('paymentForm');

    document.getElementById('payMethodSelector').classList.add('hidden');

    if (method === 'lipila') {
        if (payViewEl) payViewEl.classList.add('hidden');
        if (tabsEl) tabsEl.style.display = 'none';
        document.getElementById('lipilaFormView').classList.remove('hidden');

        // Prefill what we know (never overwrite what the student already typed)
        var em = document.getElementById('lipilaEmail');
        var knownEmail = localStorage.getItem('student_email') || sessionStorage.getItem('student_email') || '';
        var manualEmail = form && form.querySelector('input[name="email"]');
        if (em && !em.value) em.value = knownEmail || (manualEmail && manualEmail.value) || '';
        var nm = document.getElementById('lipilaFullName');
        var manualName = form && form.querySelector('input[name="fullName"]');
        if (nm && !nm.value && manualName && manualName.value) nm.value = manualName.value;

        lipilaSyncFromForm();
        lipilaFetchPrice();
    } else {
        // Manual path — restore tabs and show the manual form (selection is shared, so it is already in place)
        document.getElementById('lipilaFormView').classList.add('hidden');
        if (tabsEl) tabsEl.style.display = '';
        if (payViewEl) payViewEl.classList.remove('hidden');
        if (form) form.classList.remove('hidden');
        // Carry details typed in the Lipila form over to the screenshot form
        var le = document.getElementById('lipilaEmail'), ln = document.getElementById('lipilaFullName');
        if (form && le && le.value) { var me = form.querySelector('input[name="email"]'); if (me && !me.value) me.value = le.value; }
        if (form && ln && ln.value) { var mn = form.querySelector('input[name="fullName"]'); if (mn && !mn.value) mn.value = ln.value; }
    }
}

function backToMethodSelector() {
    document.getElementById('lipilaFormView').classList.add('hidden');
    document.getElementById('payMethodSelector').classList.remove('hidden');
}

/* ── Course / Term for BOTH payment methods ──────────────────────────────
   The screenshot form's #courseSelect / #termSelect are the single source of
   truth. The Lipila selects are a live mirror of them: changing either pair
   updates the other, the header, the plan cards and the price boxes.        */

function _lipilaPriceNote(msg) {
    var n = document.getElementById('lipilaPriceNote');
    if (!n) return;
    n.textContent = msg || '';
    n.style.display = msg ? 'block' : 'none';
}

function _lipilaPayBtnRender() {
    var btn = document.getElementById('lipilaPayBtn');
    if (!btn) return;
    var ctx = window._lipilaCtx || {};
    var ready = !!(ctx.course && ctx.term);
    if (!ready) { btn.disabled = true; btn.textContent = 'Select course & term'; return; }
    if (typeof ctx.amount === 'number') { btn.disabled = false; btn.textContent = 'Pay K' + ctx.amount.toFixed(2); return; }
    btn.disabled = true;
    btn.textContent = ctx.priceError ? 'Price unavailable' : 'Checking price…';
}

function lipilaSyncFromForm() {
    var cs = document.getElementById('courseSelect'), ts = document.getElementById('termSelect');
    var lcs = document.getElementById('lipilaCourseSelect'), lts = document.getElementById('lipilaTermSelect');
    if (!cs || !ts || !lcs || !lts || !window._lipilaCtx) return;
    var ctx = window._lipilaCtx;

    if (lcs.innerHTML !== cs.innerHTML) lcs.innerHTML = cs.innerHTML;
    lcs.value = cs.value || '';
    if (lts.innerHTML !== ts.innerHTML) lts.innerHTML = ts.innerHTML;
    lts.disabled = ts.disabled;
    lts.value = ts.value || '';

    var course = cs.value || '', term = ts.value || '';
    var changed = (ctx.course !== course || ctx.term !== term);
    ctx.course = course; ctx.term = term;
    if (changed) { ctx.amount = null; ctx.priceError = false; }

    var ready = !!(course && term);
    var price = ready ? getPriceFor(course, term) : null;
    var days = ready ? getDurationFor(course, term) : null;
    var devices = ready ? getMaxDevicesFor(course, term) : null;
    var amtEl = document.getElementById('lipilaAmount');
    if (amtEl) amtEl.textContent = price !== null ? 'K' + price.toFixed(2) : 'K—';
    var durEl = document.getElementById('lipilaDuration');
    if (durEl) durEl.textContent = (price !== null && days) ? formatDays(days) + ' (starts on first use)' : '—';
    var devRow = document.getElementById('lipilaDevicesRow'), devEl = document.getElementById('lipilaDevices');
    if (devRow) devRow.style.display = (price !== null && devices) ? 'flex' : 'none';
    if (devEl) devEl.textContent = devices ? devices + (devices === 1 ? ' device' : ' devices') : '—';
    if (ready && price === null && SYSTEM_CONFIG.loaded) _lipilaPriceNote('This plan is not available right now. Choose another option.');
    else if (!ctx.priceError) _lipilaPriceNote('');

    _lipilaPayBtnRender();

    // Re-confirm the authoritative price whenever the choice changes while the Lipila form is on screen.
    var view = document.getElementById('lipilaFormView');
    if (changed && ready && ctx.lipilaEnabled && view && !view.classList.contains('hidden')) lipilaFetchPrice();
}

function lipilaCourseChanged() {
    var v = document.getElementById('lipilaCourseSelect').value;
    var cs = document.getElementById('courseSelect');
    if (!cs || !v) return;
    cs.value = v;
    updateTerms();            // rebuilds terms, calls updatePrice → mirrors back here
}

function lipilaTermChanged() {
    var v = document.getElementById('lipilaTermSelect').value;
    var ts = document.getElementById('termSelect');
    if (!ts || !v) return;
    ts.value = v;
    updatePrice();
}

var _lipilaPriceTimer = null, _lipilaPriceSeq = 0;
function lipilaFetchPrice() {
    var ctx = window._lipilaCtx;
    if (!ctx) return;
    clearTimeout(_lipilaPriceTimer);
    if (!ctx.course || !ctx.term) { _lipilaPayBtnRender(); return; }
    var seq = ++_lipilaPriceSeq, course = ctx.course, term = ctx.term;
    ctx.amount = null; ctx.priceError = false;
    _lipilaPayBtnRender();
    _lipilaPriceTimer = setTimeout(function () {
        callPaymentApi('getLipilaPrice', { course: course, term: term }, 2)
            .then(function (res) {
                if (seq !== _lipilaPriceSeq) return;            // a newer choice superseded this answer
                if (res && res.success && typeof res.amount === 'number') {
                    ctx.amount = res.amount; ctx.priceError = false;
                    var amtEl = document.getElementById('lipilaAmount');
                    if (amtEl) amtEl.textContent = 'K' + res.amount.toFixed(2);
                    _lipilaPriceNote('');
                } else {
                    ctx.priceError = true;
                    _lipilaPriceNote((res && res.message) || 'Instant payment is not available for this plan. Choose another, or pay by screenshot.');
                }
                _lipilaPayBtnRender();
            })
            .catch(function () {
                if (seq !== _lipilaPriceSeq) return;
                ctx.priceError = true;
                _lipilaPriceNote('Could not confirm the price. Check your connection and re-select the term to retry.');
                _lipilaPayBtnRender();
            });
    }, 200);
}

function _lipilaAskPriceChange(oldAmt, newAmt, msg) {
    var text = msg || ('The price is now K' + newAmt.toFixed(2) + (typeof oldAmt === 'number' ? ' (was K' + oldAmt.toFixed(2) + ')' : '') + '. Continue?');
    if (typeof Swal === 'undefined') return Promise.resolve(window.confirm(text));
    return Swal.fire({
        icon: 'question', title: 'Price updated', text: text,
        showCancelButton: true, confirmButtonText: 'Pay K' + newAmt.toFixed(2), cancelButtonText: 'Cancel',
        background: '#1b263b', color: '#e0e6ed', confirmButtonColor: '#007bff',
        backdrop: 'rgba(13,27,42,0.85)'
    }).then(function (r) { return !!r.isConfirmed; });
}

function initiateLipila(confirmedAmount) {
    var ctx = window._lipilaCtx;
    var name = (document.getElementById('lipilaFullName').value || '').trim();
    var email = (document.getElementById('lipilaEmail').value || '').trim().toLowerCase();
    var phone = (document.getElementById('lipilaPhone').value || '').trim();
    if (!ctx.course) return _lipilaToast('Select a course', 'warning');
    if (!ctx.term) return _lipilaToast('Select a term', 'warning');
    if (!name) return _lipilaToast('Enter your full name', 'warning');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return _lipilaToast('Enter a valid email', 'warning');
    if (!_lipilaValidPhone(phone)) return _lipilaToast('Enter a valid Zambian mobile number', 'warning');
    if (typeof ctx.amount !== 'number') return _lipilaToast('Still confirming the price — try again in a moment', 'info');

    var course = ctx.course, term = ctx.term, sentAmount = ctx.amount;
    var btn = document.getElementById('lipilaPayBtn');
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Starting…';
    var release = function () { btn.dataset.busy = '0'; _lipilaPayBtnRender(); };

    callPaymentApi('initiateLipilaPayment', {
        fullName: name, email: email, course: course, term: term,
        phone: phone, expectedAmount: sentAmount
    }, 3).then(function(res){
        if (res && res.success) {
            btn.dataset.busy = '0';
            ctx.saleId = res.saleId;
            ctx.email = email;
            var started = Date.now();
            try {
                sessionStorage.setItem('lipila_pending_saleId', res.saleId);
                sessionStorage.setItem('lipila_pending_email', email);
                sessionStorage.setItem('lipila_pending_course', course);
                sessionStorage.setItem('lipila_pending_term', term);
                sessionStorage.setItem('lipila_pending_phone', phone);
                sessionStorage.setItem('lipila_pending_amount', Number(res.amount).toFixed(2));
                sessionStorage.setItem('lipila_pending_started', String(started));
                sessionStorage.setItem('student_email', email);
                localStorage.setItem('student_email', email);
            } catch (e) {}
            if (res.pollIntervalMs) ctx.pollIntervalMs = res.pollIntervalMs;
            if (res.abandonTimeoutMinutes) ctx.abandonTimeoutMinutes = res.abandonTimeoutMinutes;

            document.getElementById('lipilaFormView').classList.add('hidden');
            document.getElementById('lipilaPinWaiting').classList.remove('hidden');
            document.getElementById('lipilaPhoneMasked').textContent =
                res.phoneMasked || ('••• ••• ' + phone.slice(-4));
            document.getElementById('lipilaAmountConfirm').textContent = 'K' + Number(res.amount).toFixed(2);
            if (res.reused) _lipilaToast('You already had a payment request open for this plan — resuming it.', 'info');
            startLipilaPolling(started);
            return;
        }
        if (res && res.code === 'PRICE_CHANGED' && typeof res.newAmount === 'number') {
            release();
            _lipilaAskPriceChange(sentAmount, res.newAmount, res.message).then(function (ok) {
                if (ok) { ctx.amount = res.newAmount; var a = document.getElementById('lipilaAmount'); if (a) a.textContent = 'K' + res.newAmount.toFixed(2); _lipilaPayBtnRender(); initiateLipila(); }
                else { lipilaFetchPrice(); }
            });
            return;
        }
        if (res && (res.code === 'LIPILA_UNAVAILABLE' || res.code === 'LIPILA_DOWN' || res.fallbackToManual)) {
            release();
            _lipilaToast(res.message || 'Instant payment is unavailable right now — switching to the screenshot option', 'warning');
            setTimeout(function(){ selectPaymentMethod('manual'); }, 1200);
            return;
        }
        release();
        _lipilaToast((res && res.message) || 'Could not start payment', 'error');
    }).catch(function(){
        release();
        _lipilaToast('Connection error. Please try again.', 'error');
    });
}

function startLipilaPolling(startedAt) {
    var ctx = window._lipilaCtx;
    stopLipilaTimers();                 // bumps ctx._gen so any older poll chain dies

    // Countdown from a wall-clock deadline (accurate even when the tab was throttled in the background)
    var total = (ctx.abandonTimeoutMinutes || 15) * 60;
    var started = startedAt || Date.now();
    var left = function () { return Math.max(0, total - Math.floor((Date.now() - started) / 1000)); };
    updateLipilaCountdown(left());
    ctx.countdown = setInterval(function(){ updateLipilaCountdown(left()); }, 1000);

    var transient = 0, inFlight = false, saleId = ctx.saleId, gen = ctx._gen;
    var ind = function (on) {
        var el = document.getElementById('lipilaTransientIndicator');
        if (el) el.classList.toggle('hidden', !on);
    };
    function schedule() {
        if (ctx.saleId !== saleId || ctx._gen !== gen) return;
        // Back off after repeated hiccups; stay slow while the tab is hidden.
        var base = ctx.pollIntervalMs || 5000;
        var delay = transient >= 3 ? Math.max(base * 3, 15000) : (document.hidden ? Math.max(base * 3, 15000) : base);
        ctx.timer = setTimeout(poll, delay);
    }
    function poll() {
        if (ctx.saleId !== saleId || ctx._gen !== gen || inFlight) return;
        inFlight = true;
        callPaymentApi('checkLipilaPayment', { saleId: saleId, email: ctx.email }, 1)
            .then(function(res){
                inFlight = false;
                if (ctx.saleId !== saleId) return;
                if (!res || res.transient) { transient++; ind(true); return schedule(); }
                transient = 0; ind(false);
                if (res.status === 'completed') return showLipilaSuccess(res);
                if (res.status === 'failed') return showLipilaFailed(res);
                if (res.status === 'held') return showLipilaHeld(res);
                if (res.status === 'expired') return showLipilaExpired(res);
                schedule();                                   // 'pending' → keep polling
            })
            .catch(function(){
                inFlight = false;
                if (ctx.saleId !== saleId) return;
                transient++; ind(true); schedule();
            });
    }
    ctx._poll = poll;
    poll();
}

// Check straight away when the student returns to the tab after approving on their phone.
document.addEventListener('visibilitychange', function () {
    var ctx = window._lipilaCtx;
    if (!document.hidden && ctx && ctx.saleId && ctx.timer && typeof ctx._poll === 'function') {
        clearTimeout(ctx.timer);
        ctx._poll();
    }
});

function updateLipilaCountdown(seconds) {
    var el = document.getElementById('lipilaCountdown');
    if (!el) return;
    if (seconds <= 0) { el.textContent = 'Finalising — this can take a moment…'; return; }
    var m = Math.floor(seconds / 60), s = seconds % 60;
    el.textContent = 'Expires in ' + m + ':' + (s < 10 ? '0' : '') + s;
}

function stopLipilaTimers() {
    if (window._lipilaCtx) {
        window._lipilaCtx._gen = (window._lipilaCtx._gen || 0) + 1;
        if (window._lipilaCtx.timer) { clearTimeout(window._lipilaCtx.timer); window._lipilaCtx.timer = null; }
        if (window._lipilaCtx.countdown) { clearInterval(window._lipilaCtx.countdown); window._lipilaCtx.countdown = null; }
    }
}

function clearLipilaSession() {
    sessionStorage.removeItem('lipila_pending_saleId');
    sessionStorage.removeItem('lipila_pending_email');
    sessionStorage.removeItem('lipila_pending_course');
    sessionStorage.removeItem('lipila_pending_term');
    sessionStorage.removeItem('lipila_pending_phone');
    sessionStorage.removeItem('lipila_pending_amount');
    sessionStorage.removeItem('lipila_pending_started');
}

function showLipilaSuccess(res) {
    stopLipilaTimers();
    clearLipilaSession();
    document.getElementById('lipilaPinWaiting').classList.add('hidden');
    document.getElementById('lipilaSuccess').classList.remove('hidden');
    document.getElementById('lipilaSuccessCode').textContent = res.code || '—';
    document.getElementById('lipilaSuccessScope').textContent =
        (typeof res.amount === 'number' ? 'K' + res.amount.toFixed(2) + ' · ' : '') +
        (res.course ? payScopeLabel(_up(res.course), _up(res.term)) : '');
    document.getElementById('lipilaSuccessEmail').textContent = window._lipilaCtx.email || '';
}

function showLipilaFailed(res) {
    stopLipilaTimers();
    clearLipilaSession();
    document.getElementById('lipilaPinWaiting').classList.add('hidden');
    document.getElementById('lipilaFailed').classList.remove('hidden');
    document.getElementById('lipilaFailedReason').textContent =
        res.message || 'No money was taken. Please try again or use the screenshot option.';
}

function showLipilaHeld(res) {
    stopLipilaTimers();
    clearLipilaSession();
    document.getElementById('lipilaPinWaiting').classList.add('hidden');
    document.getElementById('lipilaHeld').classList.remove('hidden');
}

function showLipilaExpired(res) {
    stopLipilaTimers();
    clearLipilaSession();
    document.getElementById('lipilaPinWaiting').classList.add('hidden');
    document.getElementById('lipilaExpired').classList.remove('hidden');
}

function copyLipilaCode(btn) {
    var code = document.getElementById('lipilaSuccessCode').textContent;
    if (!code || code === '—') return;
    navigator.clipboard.writeText(code).then(function(){
        btn.textContent = '✓ Copied';
        setTimeout(function(){ btn.textContent = 'Copy'; }, 2000);
    }).catch(function(){
        var ta = document.createElement('textarea');
        ta.value = code; document.body.appendChild(ta); ta.select();
        try {
            document.execCommand('copy');
            btn.textContent = '✓ Copied';
            setTimeout(function(){ btn.textContent = 'Copy'; }, 2000);
        } catch(e) {}
        document.body.removeChild(ta);
    });
}

function useLipilaCodeNow() {
    var code = document.getElementById('lipilaSuccessCode').textContent;
    closePaymentModal();
    setTimeout(function(){
        var input = document.getElementById('access-code-input');
        if (input) { input.value = code; input.focus(); }
    }, 300);
}

function retryLipila() {
    document.getElementById('lipilaFailed').classList.add('hidden');
    document.getElementById('lipilaExpired').classList.add('hidden');
    document.getElementById('lipilaHeld').classList.add('hidden');
    document.getElementById('lipilaFormView').classList.remove('hidden');
    var payViewEl = document.getElementById('pay-view');
    var tabsEl = document.querySelector('.tabs');
    if (payViewEl) payViewEl.classList.add('hidden');
    if (tabsEl) tabsEl.style.display = 'none';
    window._lipilaCtx.saleId = null;
    lipilaSyncFromForm();
    lipilaFetchPrice();
}

function fallbackToManual() {
    document.getElementById('lipilaFailed').classList.add('hidden');
    document.getElementById('lipilaExpired').classList.add('hidden');
    document.getElementById('lipilaHeld').classList.add('hidden');
    document.getElementById('lipilaFormView').classList.add('hidden');
    var payViewEl = document.getElementById('pay-view');
    var tabsEl = document.querySelector('.tabs');
    var form = document.getElementById('paymentForm');
    if (payViewEl) payViewEl.classList.remove('hidden');
    if (tabsEl) tabsEl.style.display = '';
    if (form) form.classList.remove('hidden');
}


function handleFile(input) {
    const fileName = document.getElementById('fileName');
    const dropZone = document.getElementById('dropZone');
    if (!fileName || !dropZone) return;

    if (input.files && input.files.length > 0) {
        const file = input.files[0];
        const maxSize = KAERI_CONFIG.maxPaymentScreenshotBytes;
        if (file.size > maxSize) {
            showAlert('warning', 'File Too Large', 'Please upload an image smaller than 5MB.');
            input.value = '';
            fileName.textContent = 'Tap to upload screenshot';
            dropZone.classList.remove('has-file');
            return;
        }
        if (!file.type.startsWith('image/')) {
            showAlert('warning', 'Invalid File', 'Please upload an image file (PNG, JPG, WEBP).');
            input.value = '';
            fileName.textContent = 'Tap to upload screenshot';
            dropZone.classList.remove('has-file');
            return;
        }
        fileName.innerHTML = `<span style="color:#72efdd;">${file.name}</span>`;
        dropZone.classList.add('has-file');
    } else {
        fileName.textContent = 'Tap to upload screenshot';
        dropZone.classList.remove('has-file');
    }
}

function handleSubmit() {
    if (isSubmitting) return;

    const form = document.getElementById('paymentForm');
    const fileInput = document.getElementById('fileInput');
    const file = fileInput?.files[0];

    const fullName = form?.querySelector('input[name="fullName"]')?.value.trim();
    const email = form?.querySelector('input[name="email"]')?.value.trim();
    const course = document.getElementById('courseSelect')?.value;
    const term = document.getElementById('termSelect')?.value;
    const momoNumber = form?.querySelector('input[name="momoNumber"]')?.value.trim();
    const transRef = form?.querySelector('input[name="transRef"]')?.value.trim();

    if (!fullName) return showAlert('warning', 'Missing Field', 'Please enter your full name.');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showAlert('warning', 'Invalid Email', 'Please enter a valid email address.');
    if (!course) return showAlert('warning', 'Missing Course', 'Please select a course.');
    if (!term) return showAlert('warning', 'Missing Term', 'Please select a term.');
    if (!momoNumber || momoNumber.length < 9) return showAlert('warning', 'Invalid Phone', 'Please enter a valid Mobile Money number.');
    if (!transRef) return showAlert('warning', 'Missing Reference', 'Please enter your transaction reference.');
    if (!file) return showAlert('warning', 'Proof Required', 'Please upload a screenshot of your payment.');

    isSubmitting = true;
    const submitBtn = document.getElementById('paySubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner"></span> Processing...';
    }

    const reader = new FileReader();
    reader.onload = function(evt) {
        const payload = {
            fullName, email, course, term,
            phone: momoNumber,
            txnRef: transRef,
            screenshotBase64: evt.target.result
        };

        callPaymentApi('submitPayment', { payload }, KAERI_CONFIG.paymentRetries)
            .then(res => {
                if (res.success) {
                    showAlert('success', 'Submitted!', res.message || 'Payment submitted successfully! Verification takes ~24 hours.')
                        .then(() => {
                            form?.reset();
                            const fn = document.getElementById('fileName');
                            const dz = document.getElementById('dropZone');
                            if (fn) fn.textContent = 'Tap to upload screenshot';
                            if (dz) dz.classList.remove('has-file');
                            updatePrice();
                            closePaymentModal();
                        });
                } else {
                    showAlert('error', 'Submission Failed', res.message || 'An error occurred. Please try again.');
                }
            })
            .catch(() => {
                showAlert('error', 'Network Error', 'Could not reach the server. Please check your connection.');
            })
            .finally(() => {
                isSubmitting = false;
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '✅ Submit Payment';
                }
            });
    };

    reader.onerror = function() {
        showAlert('error', 'File Error', 'Failed to read the image file. Please try again.');
        isSubmitting = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '✅ Submit Payment';
        }
    };

    reader.readAsDataURL(file);
}

function checkHistory() {
    if (isChecking) return;
    const email = document.getElementById('checkEmail')?.value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return showAlert('warning', 'Invalid Email', 'Please enter a valid email address.');
    }

    isChecking = true;
    const historyList = document.getElementById('historyList');
    if (historyList) {
        historyList.innerHTML = '<div class="skeleton" style="height:60px;"></div><div class="skeleton" style="height:60px;"></div>';
    }

    callPaymentApi('getStudentPurchaseHistory', { email }, 2)
        .then(res => {
            if (!historyList) return;
            historyList.innerHTML = '';
            if (!res.success) {
                historyList.innerHTML = `<p style="text-align:center;color:#8899a6;padding:20px;">${res.message || 'Could not fetch history.'}</p>`;
                return;
            }
            const data = res.data || [];
            if (data.length === 0) {
                historyList.innerHTML = '<p style="text-align:center;color:#8899a6;padding:20px;">No records found for this email.</p>';
                return;
            }
            data.forEach(item => {
                const st = String(item.status || '');
                const badgeClass = st === 'Completed' ? 'badge-success' :
                                   (st === 'Failed' || st === 'Abandoned' || st === 'Timed_Out_Unconfirmed') ? 'badge-danger' : 'badge-warning';
                const statusLabel = ({
                    'Pending_Lipila': 'Processing', 'Paid_Pending_Review': 'Under review', 'Paid_Code_Failed': 'Under review',
                    'Disputed': 'Under review', 'Timed_Out_Unconfirmed': 'Expired', 'Abandoned': 'Expired'
                })[st] || st;
                const methodLabel = item.paymentMethod === 'LIPILA' || item.paymentMethod === 'Lipila' || item.saleId ? '💳 Lipila' : '📱 Screenshot';
                let contentHtml = '';
                if (item.status === 'Completed' && item.accessCode) {
                    contentHtml = `
                        <div class="code-with-copy">
                            <span class="code-text">${escapeHtml(item.accessCode)}</span>
                            <button class="copy-btn" onclick="copyCode('${escapeHtml(item.accessCode)}', this)">
                                <i class="fas fa-copy"></i> Copy
                            </button>
                        </div>
                    `;
                } else if (item.status === 'Failed') {
                    contentHtml = `<div style="color:#8899a6;font-size:0.85rem;margin-top:5px;">${escapeHtml(item.verificationNotes || 'Failed')}</div>`;
                } else if (st === 'Pending_Lipila') {
                    contentHtml = `<div style="color:#8899a6;font-size:0.85rem;margin-top:5px;">Waiting for your PIN confirmation on your phone. Your code will appear here once paid.</div>
                        <button class="btn btn-inline btn-secondary" style="width:auto;padding:6px 14px;margin-top:8px;" onclick="checkHistory()">↻ Refresh status</button>`;
                } else if (statusLabel === 'Under review') {
                    contentHtml = `<div style="color:#8899a6;font-size:0.85rem;margin-top:5px;">${escapeHtml(item.verificationNotes || 'Payment received — our team is confirming it. You will get your code by email.')}</div>`;
                } else {
                    contentHtml = `<div style="color:#8899a6;font-size:0.85rem;margin-top:5px;">${escapeHtml(item.verificationNotes || 'Pending...')}</div>`;
                }

                historyList.innerHTML += `
                    <div class="history-item">
                        <div style="display:flex;justify-content:space-between;margin-bottom:5px;">
                            <span style="font-weight:700">${escapeHtml(item.course)} ${escapeHtml(item.term)}</span>
                            <span class="badge ${badgeClass}">${escapeHtml(statusLabel)}</span>
                        </div>
                        <div style="color:#8899a6;font-size:0.85rem;">${escapeHtml(item.date)} • ${methodLabel} • Ref: ${escapeHtml(item.transactionRef || item.saleId || '-')}</div>
                        ${contentHtml}
                    </div>
                `;
            });
        })
        .catch(() => {
            if (historyList) {
                historyList.innerHTML = `<p style="text-align:center;color:#8899a6;padding:20px;">Network error. Please try again later.</p>`;
            }
        })
        .finally(() => {
            isChecking = false;
        });
}

function copyCode(text, btnElement) {
    if (!text) return;
    const original = btnElement.innerHTML;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => {
                btnElement.innerHTML = '✅ Copied!';
                btnElement.classList.add('copied');
                setTimeout(() => {
                    btnElement.innerHTML = original;
                    btnElement.classList.remove('copied');
                }, 2500);
            })
            .catch(() => fallbackCopy(text, btnElement));
    } else {
        fallbackCopy(text, btnElement);
    }
}

function fallbackCopy(text, btnElement) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        btnElement.innerHTML = '✅ Copied!';
        btnElement.classList.add('copied');
        setTimeout(() => {
            btnElement.innerHTML = '<i class="fas fa-copy"></i> Copy';
            btnElement.classList.remove('copied');
        }, 2500);
    } catch (e) {
        showAlert('warning', 'Copy Failed', 'Could not copy. Please select and copy manually.');
    }
    document.body.removeChild(textarea);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function switchPayTab(tab) {
    const payView = document.getElementById('pay-view');
    const statusView = document.getElementById('status-view');
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabsContainer = document.querySelector('.tabs');

    // Hide any visible Lipila screens when switching to a tab view
    ['payMethodSelector','lipilaFormView','lipilaPinWaiting','lipilaSuccess','lipilaFailed','lipilaHeld','lipilaExpired'].forEach(function(id){
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    // Show the tabs container (may have been hidden by the Lipila method selector)
    if (tabsContainer) tabsContainer.style.display = '';

    tabButtons.forEach(b => b.classList.remove('active'));
    if (payView) payView.classList.add('hidden');
    if (statusView) statusView.classList.add('hidden');

    if (tab === 'pay') {
        tabButtons[0]?.classList.add('active');
        if (payView) payView.classList.remove('hidden');
    } else {
        tabButtons[1]?.classList.add('active');
        if (statusView) statusView.classList.remove('hidden');
    }
}


// ═══════════════════════════════════════════════════════════
// ═══ LIPILA VISIBILITY HANDLER (Patch 3.4) ═══
// ═══════════════════════════════════════════════════════════
document.addEventListener('visibilitychange', function(){
    if (document.hidden && window._lipilaCtx && window._lipilaCtx.timer) {
        clearInterval(window._lipilaCtx.timer);
        window._lipilaCtx.timer = null;
    } else if (!document.hidden && window._lipilaCtx && window._lipilaCtx.saleId && !window._lipilaCtx.timer) {
        var pinWaiting = document.getElementById('lipilaPinWaiting');
        if (pinWaiting && !pinWaiting.classList.contains('hidden')) {
            startLipilaPolling();
        }
    }
});
// ============================================================
// === 6. QUIZ ENGINE with Tiered Access ===
// === v1.1 PATCH: paid MCQ wizard (3 screens) — demo contract untouched ===
// === v1.3 PATCH: demo MCQ bulk-select picker (multi-select sub-topics),
//                 fixed 10 questions/run, shuffle forced ON ===
// === v1.6 PATCH: naturalSort applied to unit and sub-topic ordering ===
// ============================================================

// ────────────────────────────────────────────────────────────
// ── MCQ wizard state (paid only; demo never touches it) ────
// ────────────────────────────────────────────────────────────
const mcqSetupState = {
    selectedUnits:  new Set(),
    selectedSubs:   {},          // { unitName: Set<subName> }
    orderedUnits:   [],          // sequence of units to walk through
    subScreenIndex: 0,
    count:          10,
    shuffleQs:      true,
    shuffleOpts:    true,
    groupByTopic:   false
};

// ────────────────────────────────────────────────────────────
// ── Demo MCQ picker state (bulk-select, resets on course change)
// ────────────────────────────────────────────────────────────
const _demoMcqState = {
    step:               'unit',              // 'unit' | 'sub'
    selectedUnit:       null,                // single unit context when in 'sub' step
    selectedSubsByUnit: {}                   // { unitName: Set<subName> } — persists across unit switches
};

function resetMcqWizardState() {
    mcqSetupState.selectedUnits.clear();
    mcqSetupState.selectedSubs   = {};
    mcqSetupState.orderedUnits   = [];
    mcqSetupState.subScreenIndex = 0;
    mcqSetupState.count          = 10;
    mcqSetupState.shuffleQs      = true;
    mcqSetupState.shuffleOpts    = true;
    mcqSetupState.groupByTopic   = false;

    _demoMcqState.step               = 'unit';
    _demoMcqState.selectedUnit       = null;
    _demoMcqState.selectedSubsByUnit = {};
}

// ────────────────────────────────────────────────────────────
// ── Topic index — group questions by mainTopic + topic ─────
// ────────────────────────────────────────────────────────────
function buildMcqTopicIndex(questions) {
    const index = {};
    for (const q of questions) {
        const unit = q.mainTopic || 'Ungrouped';
        const sub  = q.topic     || 'General';
        if (!index[unit]) index[unit] = {};
        if (!index[unit][sub]) index[unit][sub] = [];
        index[unit][sub].push(q);
    }
    return index;
}

// Escape a string for inline onclick use (only \\ and ')
function _escInline(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Read how many demo attempts remain for this term.
function _demoAttemptsLeft() {
    const key = 'demo_mcq_used_' + currentTermKey;
    const used = parseInt(localStorage.getItem(key) || '0');
    return Math.max(0, getDemoLimit() - used);
}

// ────────────────────────────────────────────────────────────
// ── Entry point (unchanged name — HTML depends on it) ──────
// ────────────────────────────────────────────────────────────
function renderQuiz() {
    // FREE USER: peek only — do NOT consume. Consumption happens on Start.
    if (!hasFullAccess) {
        if (!canUseDemo('mcq')) {
            showAppNotification('Demo limit reached. Unlock Full Access!', 'warning');
            openPaymentModal();
            return;
        }
        renderDemoMcqPicker();
        return;
    }

    // PAID USER: three-screen wizard.
    renderMcqMenu();
}

// ────────────────────────────────────────────────────────────
// ── Demo picker router — chooses which step to render ──────
// ────────────────────────────────────────────────────────────
function renderDemoMcqPicker() {
    if (!currentMcqData || currentMcqData.length === 0) {
        const container = document.getElementById('quiz-form');
        container.innerHTML = '<div style="text-align:center;padding:40px 20px;">'
            + _emptyOrRetrying('mcq', '<h3>📭 No questions yet</h3>'
            + '<p style="color:#a0a8b4;">No MCQ content for ' + currentCourse + ' ' + currentTerm + '.</p>')
            + '</div>';
        return;
    }

    const tree  = buildMcqTopicIndex(currentMcqData);
    const units = Object.keys(tree).sort(naturalSort);

    // Reset step context only — keep selectedSubsByUnit so Try Again / unit switches persist picks.
    _demoMcqState.selectedUnit = null;

    // If the term has only one unit, skip the unit step.
    if (units.length === 1) {
        _demoMcqState.selectedUnit = units[0];
        _demoMcqState.step         = 'sub';
        renderDemoSubPicker(units[0]);
        return;
    }

    _demoMcqState.step = 'unit';
    renderDemoUnitPicker();
}

// ────────────────────────────────────────────────────────────
// ── Demo step 1 — unit picker (only if term has > 1 unit) ──
// ────────────────────────────────────────────────────────────
function renderDemoUnitPicker() {
    const container = document.getElementById('quiz-form');
    container.innerHTML = '';
    document.getElementById('result').innerHTML = '';
    currentQuizType = 'mcqDemoUnit';
    updateProgress(0, 0);

    const tree  = buildMcqTopicIndex(currentMcqData);
    const units = Object.keys(tree).sort(naturalSort);
    const attemptsLeft = _demoAttemptsLeft();

    let html = '<div style="max-width:560px;margin:0 auto;">'
        + _mcqPoolBannerHtml()
        + '<div style="text-align:center;margin-bottom:22px;">'
        + '<h2 style="color:white;margin:0 0 4px 0;">📚 Choose a Unit</h2>'
        + '<p style="color:#a0a8b4;font-size:0.85em;margin:0;">'
        + currentCourse + ' ' + currentTerm + ' · ' + units.length + ' units · ' + currentMcqData.length + ' questions'
        + '</p></div>'
        + '<div style="text-align:center;margin-bottom:16px;color:#ffc107;font-size:0.82em;'
        + 'background:#0d1b2a;border:1px solid #3e506e;border-radius:6px;padding:8px;">'
        + '🔒 Demo Mode: <strong>' + attemptsLeft + ' attempt' + (attemptsLeft === 1 ? '' : 's') + '</strong> remaining'
        + '</div>'
        + '<div>';

    units.forEach(function (u) {
        const subs = Object.keys(tree[u]);
        const qCount = subs.reduce(function (s, k) { return s + tree[u][k].length; }, 0);
        const safeU = _escInline(u);

        // Badge: how many sub-topics ticked in this unit
        const pickedSet = _demoMcqState.selectedSubsByUnit[u];
        const pickedCount = pickedSet ? pickedSet.size : 0;
        const badge = pickedCount > 0
            ? '<div style="font-size:0.72em;color:#72efdd;font-weight:700;'
              + 'background:#0d1b2a;padding:2px 8px;border-radius:10px;display:inline-block;margin-top:4px;">'
              + '● ' + pickedCount + ' selected</div>'
            : '';

        html += '<div class="demo-mcq-unit-row" '
            + 'onclick="demoSelectUnit(\'' + safeU + '\')" '
            + 'style="background:#1e2a3a;border:2px solid ' + (pickedCount > 0 ? '#28a745' : '#2b3a55') + ';'
            + 'border-radius:10px;padding:16px;margin-bottom:10px;cursor:pointer;transition:0.2s;">'
            + '<div style="display:flex;align-items:center;gap:12px;">'
            + '<div style="flex:1;">'
            + '<div style="color:white;font-size:1em;font-weight:600;line-height:1.3;">' + u + '</div>'
            + '<div style="color:#a0a8b4;font-size:0.78em;margin-top:3px;">'
            + subs.length + ' sub-topics · ' + qCount + ' questions</div>'
            + badge
            + '</div>'
            + '<div style="color:#72efdd;font-size:1.2em;font-weight:700;">→</div>'
            + '</div></div>';
    });

    html += '</div>'
        + '<button type="button" onclick="exitQuiz()" class="back-button" '
        + 'style="width:100%;margin:16px 0 0 0;">⬅️ Back to Menu</button>'
        + '</div>';

    container.innerHTML = html;
}

function demoSelectUnit(unit) {
    _demoMcqState.selectedUnit = unit;
    _demoMcqState.step         = 'sub';

    // Do NOT reset subs for this unit — keep any prior selections.
    if (!_demoMcqState.selectedSubsByUnit[unit]) {
        _demoMcqState.selectedSubsByUnit[unit] = new Set();
    }

    renderDemoSubPicker(unit);
}

// ────────────────────────────────────────────────────────────
// ── Demo step 2 — bulk-select sub-topic picker ─────────────
// ────────────────────────────────────────────────────────────
// UX: checkboxes instead of radios. User can pick any combination.
// Run length is fixed at 10 (or fewer if the pool is smaller).
// Shuffle is forced ON as an operator default.
function renderDemoSubPicker(unit) {
    const container = document.getElementById('quiz-form');
    container.innerHTML = '';
    document.getElementById('result').innerHTML = '';
    currentQuizType = 'mcqDemoSub';
    updateProgress(0, 0);

    const tree  = buildMcqTopicIndex(currentMcqData);
    const subs  = Object.keys(tree[unit] || {}).sort(naturalSort);
    const units = Object.keys(tree).sort(naturalSort);
    const multiUnit = units.length > 1;
    const attemptsLeft = _demoAttemptsLeft();
    const safeU = _escInline(unit);

    // Read this unit's persistent selection (defaults to empty Set)
    const selectedSubs = _demoMcqState.selectedSubsByUnit[unit] || new Set();

    let html = '<div style="max-width:560px;margin:0 auto;">'
        + (multiUnit ? '' : _mcqPoolBannerHtml())
        + '<div style="text-align:center;margin-bottom:20px;">';

    if (multiUnit) {
        html += '<div style="color:#a0a8b4;font-size:0.8em;letter-spacing:1px;'
            + 'text-transform:uppercase;margin-bottom:6px;">'
            + '<span onclick="renderDemoUnitPicker()" style="cursor:pointer;color:#72efdd;">← All units</span>'
            + '</div>';
    }

    html += '<h2 style="color:white;margin:0 0 4px 0;">📖 ' + unit + '</h2>'
        + '<p style="color:#a0a8b4;font-size:0.85em;margin:0;">'
        + subs.length + ' sub-topics · pick any combination'
        + '</p></div>'
        + '<div style="text-align:center;margin-bottom:16px;color:#ffc107;font-size:0.82em;'
        + 'background:#0d1b2a;border:1px solid #3e506e;border-radius:6px;padding:8px;">'
        + '🔒 Demo Mode: <strong>' + attemptsLeft + ' attempt' + (attemptsLeft === 1 ? '' : 's') + '</strong> remaining'
        + '</div>'
        + '<div id="demo-mcq-sub-list">';

    subs.forEach(function (sub) {
        const qCount = tree[unit][sub].length;
        const isSelected = selectedSubs.has(sub);
        const safeS = _escInline(sub);
        html += '<div class="demo-mcq-sub-row" data-unit="' + safeU + '" data-sub="' + safeS + '" '
            + 'onclick="demoToggleSub(\'' + safeS + '\')" '
            + 'style="background:#1e2a3a;border:2px solid ' + (isSelected ? '#28a745' : '#2b3a55') + ';'
            + 'border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;">'
            + '<div class="demo-mcq-cb" style="width:18px;height:18px;border-radius:4px;border:2px solid '
                + (isSelected ? '#28a745' : '#3e506e') + ';background:'
                + (isSelected ? '#28a745' : 'transparent') + ';flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:0.75em;color:white;font-weight:900;">'
                + (isSelected ? '✓' : '')
            + '</div>'
            + '<div style="flex:1;">'
            + '<div style="color:white;font-size:0.95em;font-weight:600;">' + sub + '</div>'
            + '<div style="color:#a0a8b4;font-size:0.75em;margin-top:2px;">' + qCount + ' question' + (qCount === 1 ? '' : 's') + '</div>'
            + '</div>'
            + '</div>';
    });

    html += '</div>'
        + '<div style="display:flex;gap:8px;margin:14px 0;">'
        + '<button type="button" onclick="demoSelectAllSubs(true)" style="flex:1;background:#2b3a55;color:#72efdd;border:1px solid #3e506e;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;margin:0;">✓ All</button>'
        + '<button type="button" onclick="demoSelectAllSubs(false)" style="flex:1;background:#2b3a55;color:#a0a8b4;border:1px solid #3e506e;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;margin:0;">✗ None</button>'
        + '</div>'
        + '<div id="demo-mcq-summary" style="background:#0d1b2a;border:1px solid #3e506e;'
            + 'border-radius:8px;padding:12px;text-align:center;color:#a0a8b4;font-size:0.88em;'
            + 'margin:16px 0;"></div>'
        + '<button type="button" id="demo-mcq-start" onclick="startDemoSubTopicMcq()" '
            + 'style="width:100%;background:#28a745;color:white;border:none;padding:14px;'
            + 'border-radius:8px;font-weight:700;font-size:1em;margin:0 0 12px 0;'
            + 'opacity:0.5;cursor:not-allowed;" disabled>'
            + '▶️ Select sub-topics above</button>'
        + '<div style="background:#0d1b2a;border:1px dashed #ffc107;border-radius:8px;'
            + 'padding:12px 14px;text-align:center;font-size:0.82em;color:#a0a8b4;line-height:1.5;">'
            + '<span style="color:#ffc107;font-weight:700;">🔓 Unlock to set question counts, '
            + 'control shuffling, and group by sub-topic</span>'
            + '</div>'
        + '<button type="button" onclick="exitQuiz()" class="back-button" '
            + 'style="width:100%;margin:12px 0 0 0;">⬅️ Back to Menu</button>'
        + '</div>';

    container.innerHTML = html;
    _updateDemoMcqSummary();
}

function demoToggleSub(sub) {
    const unit = _demoMcqState.selectedUnit;
    if (!_demoMcqState.selectedSubsByUnit[unit]) {
        _demoMcqState.selectedSubsByUnit[unit] = new Set();
    }
    const set = _demoMcqState.selectedSubsByUnit[unit];

    if (set.has(sub)) set.delete(sub);
    else              set.add(sub);

    document.querySelectorAll('.demo-mcq-sub-row').forEach(function (row) {
        const isSelected = set.has(row.dataset.sub);
        row.style.border = isSelected ? '2px solid #28a745' : '2px solid #2b3a55';
        const cb = row.querySelector('.demo-mcq-cb');
        if (cb) {
            cb.style.border     = isSelected ? '2px solid #28a745' : '2px solid #3e506e';
            cb.style.background = isSelected ? '#28a745' : 'transparent';
            cb.textContent      = isSelected ? '✓' : '';
        }
    });
    _updateDemoMcqSummary();
}

function demoSelectAllSubs(selectAll) {
    const tree = buildMcqTopicIndex(currentMcqData);
    const unit = _demoMcqState.selectedUnit;
    const subs = Object.keys(tree[unit] || {});

    _demoMcqState.selectedSubsByUnit[unit] = selectAll ? new Set(subs) : new Set();
    const set = _demoMcqState.selectedSubsByUnit[unit];

    document.querySelectorAll('.demo-mcq-sub-row').forEach(function (row) {
        const isSelected = set.has(row.dataset.sub);
        row.style.border = isSelected ? '2px solid #28a745' : '2px solid #2b3a55';
        const cb = row.querySelector('.demo-mcq-cb');
        if (cb) {
            cb.style.border     = isSelected ? '2px solid #28a745' : '2px solid #3e506e';
            cb.style.background = isSelected ? '#28a745' : 'transparent';
            cb.textContent      = isSelected ? '✓' : '';
        }
    });
    _updateDemoMcqSummary();
}

// Honest summary — real pool count, real run count, operator-fixed 10.
function _updateDemoMcqSummary() {
    const el  = document.getElementById('demo-mcq-summary');
    const btn = document.getElementById('demo-mcq-start');
    if (!el || !btn) return;

    const unit = _demoMcqState.selectedUnit;
    const set  = _demoMcqState.selectedSubsByUnit[unit] || new Set();

    if (!unit || set.size === 0) {
        el.innerHTML = 'Select one or more sub-topics to begin';
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        btn.textContent = '▶️ Select sub-topics above';
        return;
    }

    const tree = buildMcqTopicIndex(currentMcqData);
    let poolSize = 0;
    set.forEach(function (sub) {
        poolSize += ((tree[unit] && tree[unit][sub]) || []).length;
    });

    const runCount = Math.min(10, poolSize);

    el.innerHTML = '<strong style="color:#72efdd;">' + runCount + '</strong> question'
        + (runCount === 1 ? '' : 's')
        + ' from <strong style="color:#72efdd;">' + set.size + '</strong> sub-topic'
        + (set.size === 1 ? '' : 's')
        + ' <span style="color:#a0a8b4;">(of ' + poolSize + ' available)</span>';

    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    btn.textContent = '▶️ Start ' + runCount + '-question quiz';
}

function startDemoSubTopicMcq() {
    const unit = _demoMcqState.selectedUnit;
    const set  = unit ? _demoMcqState.selectedSubsByUnit[unit] : null;

    if (!unit || !set || set.size === 0) {
        showAppNotification('⚠️ Select at least one sub-topic', 'warning');
        return;
    }

    // ── CHARGE POINT — the moment of no return. ──
    if (!hasFullAccess) {
        if (!canUseDemo('mcq')) {
            showAppNotification('Demo limit reached. Unlock Full Access!', 'warning');
            openPaymentModal();
            return;
        }
        consumeDemoAttempt('mcq');
    }

    const tree = buildMcqTopicIndex(currentMcqData);
    const demoState = {
        selectedUnits: new Set([unit]),
        selectedSubs:  { [unit]: new Set(set) },
        count:         10,
        shuffleQs:     true,
        shuffleOpts:   true,
        groupByTopic:  false
    };
    const opts = { shuffleQs: true, shuffleOpts: true, groupByTopic: false };

    const questions = buildMcqQuiz(tree, demoState, opts);
    if (questions.length === 0) {
        showAppNotification('⚠️ Could not build quiz', 'warning');
        return;
    }

    currentQuizData      = questions;
    currentQuizType      = 'mcq';
    currentQuestionIndex = 0;
    currentScore         = 0;
    isSubmissionLocked   = false;

    logAnalyticsEvent('quiz_start',
        'MCQ DEMO · ' + set.size + ' sub-topics · ' + questions.length + 'Q');

    document.getElementById('result').innerHTML = '';
    displayMcqQuestion();
}

// ────────────────────────────────────────────────────────────
// ── Paid wizard screen 1: main topics ──────────────────────
// ────────────────────────────────────────────────────────────
function renderMcqMenu() {
    const container = document.getElementById('quiz-form');
    container.innerHTML = '';
    document.getElementById('result').innerHTML = '';
    currentQuizType = 'mcqMenu';
    updateProgress(0, 0);

    if (!currentMcqData || currentMcqData.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px 20px;">'
            + _emptyOrRetrying('mcq', '<h3>📭 No questions yet</h3>'
            + '<p style="color:#a0a8b4;">No MCQ content for ' + currentCourse + ' ' + currentTerm + '.</p>')
            + '</div>';
        return;
    }

    const tree  = buildMcqTopicIndex(currentMcqData);
    const units = Object.keys(tree).sort(naturalSort);

    if (mcqSetupState.selectedUnits.size === 0 && mcqSetupState.orderedUnits.length === 0) {
        units.forEach(function (u) {
            mcqSetupState.selectedUnits.add(u);
            mcqSetupState.selectedSubs[u] = new Set(Object.keys(tree[u]));
        });
        mcqSetupState.orderedUnits = units.slice();
    } else {
        Array.from(mcqSetupState.selectedUnits).forEach(function (u) {
            if (!tree[u]) {
                mcqSetupState.selectedUnits.delete(u);
                delete mcqSetupState.selectedSubs[u];
            }
        });
        Object.keys(mcqSetupState.selectedSubs).forEach(function (u) {
            if (!tree[u]) { delete mcqSetupState.selectedSubs[u]; return; }
            const validSubs = new Set(Object.keys(tree[u]));
            const current = mcqSetupState.selectedSubs[u];
            if (!current) return;
            Array.from(current).forEach(function (s) { if (!validSubs.has(s)) current.delete(s); });
        });
    }

    let html = '<div style="max-width:560px;margin:0 auto;">'
        + _mcqPoolBannerHtml()
        + '<div style="text-align:center;margin-bottom:22px;">'
        + '<h2 style="color:white;margin:0 0 4px 0;">📚 Select Main Topic</h2>'
        + '<p style="color:#a0a8b4;font-size:0.85em;margin:0;">'
        + currentCourse + ' ' + currentTerm + ' · ' + currentMcqData.length + ' questions · ' + units.length + ' units'
        + '</p></div><div id="mcq-unit-list">';

    units.forEach(function (u) {
        const subs = Object.keys(tree[u]);
        const qCount = subs.reduce(function (s, k) { return s + tree[u][k].length; }, 0);
        const checked = mcqSetupState.selectedUnits.has(u);
        const ratio = mcqSetupState.selectedSubs[u] ? mcqSetupState.selectedSubs[u].size / subs.length : 0;
        const cbState = (!checked || ratio === 0) ? 'unchecked' : (ratio === 1) ? 'checked' : 'partial';
        const safeU = _escInline(u);

        html += '<div class="mcq-unit-row" style="background:#1e2a3a;border:2px solid ' + (cbState === 'unchecked' ? '#2b3a55' : '#28a745') + ';border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;">'
            + '<input type="checkbox" class="mcq-unit-cb" data-unit="' + safeU + '" ' + (cbState === 'checked' ? 'checked' : '') + (cbState === 'partial' ? ' data-partial="1"' : '') + ' onclick="event.stopPropagation(); mcqMenuToggleUnit(\'' + safeU + '\', this.checked)" style="transform:scale(1.3);accent-color:#72efdd;cursor:pointer;flex-shrink:0;">'
            + '<div style="flex:1;" onclick="mcqMenuDrillUnit(\'' + safeU + '\')">'
            + '<div style="color:white;font-size:1em;font-weight:600;line-height:1.3;">' + u + '</div>'
            + '<div style="color:#a0a8b4;font-size:0.78em;margin-top:3px;">' + subs.length + ' sub-topics · ' + qCount + ' questions</div>'
            + '</div>'
            + '<div style="color:#72efdd;font-size:1.2em;font-weight:700;" onclick="mcqMenuDrillUnit(\'' + safeU + '\')">→</div>'
            + '</div>';
    });

    html += '</div>'
        + '<div style="display:flex;gap:8px;margin:18px 0;">'
        + '<button type="button" onclick="mcqMenuSelectAllUnits(true)" style="flex:1;background:#2b3a55;color:#72efdd;border:1px solid #3e506e;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;margin:0;">✓ All</button>'
        + '<button type="button" onclick="mcqMenuSelectAllUnits(false)" style="flex:1;background:#2b3a55;color:#a0a8b4;border:1px solid #3e506e;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;margin:0;">✗ None</button>'
        + '</div>'
        + '<div id="mcq-menu-summary" style="background:#0d1b2a;border:1px solid #3e506e;border-radius:8px;padding:12px;text-align:center;color:#a0a8b4;font-size:0.88em;margin-bottom:16px;"></div>'
        + '<button type="button" onclick="mcqMenuContinue()" style="width:100%;background:#28a745;color:white;border:none;padding:14px;border-radius:8px;font-weight:700;font-size:1em;cursor:pointer;margin:0 0 8px 0;">Continue →</button>'
        + '<button type="button" onclick="exitQuiz()" class="back-button" style="width:100%;margin:0;">⬅️ Back to Menu</button>'
        + '</div>';

    container.innerHTML = html;
    mcqMenuUpdateSummary(tree);
}

function mcqMenuToggleUnit(unit, checked) {
    const tree = buildMcqTopicIndex(currentMcqData);
    if (checked) {
        mcqSetupState.selectedUnits.add(unit);
        if (!mcqSetupState.selectedSubs[unit]) {
            mcqSetupState.selectedSubs[unit] = new Set(Object.keys(tree[unit] || {}));
        }
    } else {
        mcqSetupState.selectedUnits.delete(unit);
        delete mcqSetupState.selectedSubs[unit];
    }
    renderMcqMenu();
}

function mcqMenuSelectAllUnits(checked) {
    const tree = buildMcqTopicIndex(currentMcqData);
    if (checked) {
        Object.keys(tree).forEach(function (u) {
            mcqSetupState.selectedUnits.add(u);
            mcqSetupState.selectedSubs[u] = new Set(Object.keys(tree[u]));
        });
    } else {
        mcqSetupState.selectedUnits.clear();
        mcqSetupState.selectedSubs = {};
    }
    renderMcqMenu();
}

function mcqMenuUpdateSummary(tree) {
    const el = document.getElementById('mcq-menu-summary');
    if (!el) return;
    let subCount = 0;
    let qCount = 0;
    mcqSetupState.selectedUnits.forEach(function (u) {
        const subs = mcqSetupState.selectedSubs[u];
        if (!subs) return;
        subCount += subs.size;
        subs.forEach(function (s) { qCount += ((tree[u] && tree[u][s]) || []).length; });
    });
    if (mcqSetupState.selectedUnits.size === 0) {
        el.innerHTML = 'No units selected';
    } else {
        el.innerHTML = '<strong style="color:#72efdd;">' + mcqSetupState.selectedUnits.size + '</strong> units · '
            + '<strong style="color:#72efdd;">' + subCount + '</strong> sub-topics · '
            + '<strong style="color:#72efdd;">' + qCount + '</strong> questions';
    }
}

function mcqMenuDrillUnit(unit) {
    const tree = buildMcqTopicIndex(currentMcqData);
    const subs = Object.keys(tree[unit] || {}).sort(naturalSort);
    if (subs.length === 0) {
        showAppNotification("No sub-topics in this unit.", "info");
        return;
    }
    if (!mcqSetupState.selectedUnits.has(unit)) {
        mcqSetupState.selectedUnits.add(unit);
        mcqSetupState.selectedSubs[unit] = new Set(subs);
    }
    mcqSetupState.orderedUnits = [unit].concat(
        Array.from(mcqSetupState.selectedUnits).filter(function (u) { return u !== unit; })
    );
    mcqSetupState.subScreenIndex = 0;
    renderMcqSubTopicMenu();
}

function mcqMenuContinue() {
    if (mcqSetupState.selectedUnits.size === 0) {
        showAppNotification("⚠️ Select at least one unit", "warning");
        return;
    }
    mcqSetupState.orderedUnits = Array.from(mcqSetupState.selectedUnits).sort(naturalSort);
    mcqSetupState.subScreenIndex = 0;
    renderMcqSubTopicMenu();
}

// ────────────────────────────────────────────────────────────
// ── Paid wizard screen 2: sub-topics per unit ──────────────
// ────────────────────────────────────────────────────────────
function renderMcqSubTopicMenu() {
    const container = document.getElementById('quiz-form');
    container.innerHTML = '';
    document.getElementById('result').innerHTML = '';
    currentQuizType = 'mcqSubMenu';
    updateProgress(0, 0);

    const tree = buildMcqTopicIndex(currentMcqData);
    const unit = mcqSetupState.orderedUnits[mcqSetupState.subScreenIndex];
    if (!unit) { renderMcqSetupScreen(); return; }

    const subs = Object.keys(tree[unit] || {}).sort(naturalSort);
    const selectedSubs = mcqSetupState.selectedSubs[unit] || new Set();
    const totalInUnit  = subs.reduce(function (s, k) { return s + tree[unit][k].length; }, 0);
    const totalSteps   = mcqSetupState.orderedUnits.length;
    const safeU        = _escInline(unit);

    let html = '<div style="max-width:560px;margin:0 auto;">'
        + '<div style="text-align:center;margin-bottom:22px;">'
        + '<div style="color:#a0a8b4;font-size:0.8em;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Unit ' + (mcqSetupState.subScreenIndex + 1) + ' of ' + totalSteps + '</div>'
        + '<h2 style="color:white;margin:0 0 4px 0;">📖 ' + unit + '</h2>'
        + '<p style="color:#a0a8b4;font-size:0.85em;margin:0;">Choose sub-topics · ' + subs.length + ' available · ' + totalInUnit + ' questions</p>'
        + '</div><div id="mcq-sub-list">';

    subs.forEach(function (sub) {
        const qCount = tree[unit][sub].length;
        const checked = selectedSubs.has(sub);
        const safeS = _escInline(sub);
        html += '<div class="mcq-sub-row" style="background:#1e2a3a;border:2px solid ' + (checked ? '#28a745' : '#2b3a55') + ';border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:14px;cursor:pointer;">'
            + '<input type="checkbox" class="mcq-sub-cb" data-unit="' + safeU + '" data-sub="' + safeS + '" data-count="' + qCount + '" ' + (checked ? 'checked' : '') + ' onclick="event.stopPropagation(); mcqSubToggle(\'' + safeU + '\', \'' + safeS + '\', this.checked)" style="transform:scale(1.3);accent-color:#72efdd;cursor:pointer;flex-shrink:0;">'
            + '<div style="flex:1;" onclick="mcqSubToggle(\'' + safeU + '\', \'' + safeS + '\', !this.parentElement.querySelector(\'input\').checked)">'
            + '<div style="color:white;font-size:0.95em;font-weight:600;">' + sub + '</div>'
            + '<div style="color:#a0a8b4;font-size:0.75em;margin-top:2px;">' + qCount + ' questions</div>'
            + '</div></div>';
    });

    html += '</div>'
        + '<div style="display:flex;gap:8px;margin:18px 0;">'
        + '<button type="button" onclick="mcqSubSelectAll(\'' + safeU + '\', true)" style="flex:1;background:#2b3a55;color:#72efdd;border:1px solid #3e506e;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;margin:0;">✓ All</button>'
        + '<button type="button" onclick="mcqSubSelectAll(\'' + safeU + '\', false)" style="flex:1;background:#2b3a55;color:#a0a8b4;border:1px solid #3e506e;padding:10px;border-radius:8px;font-weight:600;cursor:pointer;margin:0;">✗ None</button>'
        + '</div>'
        + '<div id="mcq-sub-summary" style="background:#0d1b2a;border:1px solid #3e506e;border-radius:8px;padding:12px;text-align:center;color:#a0a8b4;font-size:0.88em;margin-bottom:16px;"></div>'
        + '<div style="display:flex;gap:8px;">'
        + '<button type="button" onclick="mcqSubBack()" style="flex:1;background:#2b3a55;color:white;border:1px solid #3e506e;padding:14px;border-radius:8px;font-weight:700;cursor:pointer;margin:0;">← Back</button>'
        + '<button type="button" onclick="mcqSubContinue()" style="flex:2;background:#28a745;color:white;border:none;padding:14px;border-radius:8px;font-weight:700;cursor:pointer;margin:0;">Continue →</button>'
        + '</div>'
        + '</div>';

    container.innerHTML = html;
    mcqSubUpdateSummary(unit);
}

function mcqSubToggle(unit, sub, checked) {
    if (!mcqSetupState.selectedSubs[unit]) mcqSetupState.selectedSubs[unit] = new Set();
    if (checked) mcqSetupState.selectedSubs[unit].add(sub);
    else mcqSetupState.selectedSubs[unit].delete(sub);
    document.querySelectorAll('.mcq-sub-row').forEach(function (row) {
        const cb = row.querySelector('input');
        if (!cb) return;
        row.style.border = cb.checked ? '2px solid #28a745' : '2px solid #2b3a55';
    });
    mcqSubUpdateSummary(unit);
}

function mcqSubSelectAll(unit, checked) {
    const tree = buildMcqTopicIndex(currentMcqData);
    if (checked) mcqSetupState.selectedSubs[unit] = new Set(Object.keys(tree[unit]));
    else mcqSetupState.selectedSubs[unit] = new Set();
    renderMcqSubTopicMenu();
}

function mcqSubUpdateSummary(unit) {
    const el = document.getElementById('mcq-sub-summary');
    if (!el) return;
    const tree = buildMcqTopicIndex(currentMcqData);
    const subs = mcqSetupState.selectedSubs[unit] || new Set();
    let qCount = 0;
    subs.forEach(function (s) { qCount += ((tree[unit] && tree[unit][s]) || []).length; });
    if (subs.size === 0) {
        el.innerHTML = 'No sub-topics selected in this unit';
    } else {
        el.innerHTML = '<strong style="color:#72efdd;">' + subs.size + '</strong> of '
            + Object.keys(tree[unit]).length + ' sub-topics · '
            + '<strong style="color:#72efdd;">' + qCount + '</strong> questions';
    }
}

function mcqSubBack() {
    if (mcqSetupState.subScreenIndex > 0) {
        mcqSetupState.subScreenIndex--;
        renderMcqSubTopicMenu();
    } else {
        renderMcqMenu();
    }
}

function mcqSubContinue() {
    const unit = mcqSetupState.orderedUnits[mcqSetupState.subScreenIndex];
    const subs = mcqSetupState.selectedSubs[unit];

    if (!subs || subs.size === 0) {
        const proceed = confirm('No sub-topics selected in ' + unit + '.\n\nSkip this unit?');
        if (!proceed) return;
        mcqSetupState.selectedUnits.delete(unit);
        const idx = mcqSetupState.orderedUnits.indexOf(unit);
        if (idx > -1) mcqSetupState.orderedUnits.splice(idx, 1);
        if (mcqSetupState.subScreenIndex >= mcqSetupState.orderedUnits.length) {
            renderMcqSetupScreen();
        } else {
            renderMcqSubTopicMenu();
        }
        return;
    }

    mcqSetupState.subScreenIndex++;
    if (mcqSetupState.subScreenIndex >= mcqSetupState.orderedUnits.length) {
        renderMcqSetupScreen();
    } else {
        renderMcqSubTopicMenu();
    }
}

// ────────────────────────────────────────────────────────────
// ── Paid wizard screen 3: count + shuffle options ──────────
// ────────────────────────────────────────────────────────────
function renderMcqSetupScreen() {
    const container = document.getElementById('quiz-form');
    container.innerHTML = '';
    document.getElementById('result').innerHTML = '';
    currentQuizType = 'mcqSetup';
    updateProgress(0, 0);

    const tree = buildMcqTopicIndex(currentMcqData);

    let poolSize = 0;
    mcqSetupState.selectedUnits.forEach(function (u) {
        const subs = mcqSetupState.selectedSubs[u];
        if (!subs) return;
        subs.forEach(function (s) { poolSize += ((tree[u] && tree[u][s]) || []).length; });
    });

    if (poolSize === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px 20px;">'
            + '<h3>⚠️ No questions selected</h3>'
            + '<p style="color:#a0a8b4;">Nothing to quiz on with the current selection.</p>'
            + '<button class="restart-button" onclick="renderMcqMenu()" style="margin-top:12px;">← Back to topics</button>'
            + '</div>';
        return;
    }

    if (mcqSetupState.count > poolSize) mcqSetupState.count = poolSize;
    if (mcqSetupState.count < 1) mcqSetupState.count = Math.min(10, poolSize);

    const presets = [5, 10, 20, 30, 50].filter(function (n) { return n <= poolSize; });

    let html = '<div style="max-width:560px;margin:0 auto;">'
        + '<div style="text-align:center;margin-bottom:22px;">'
        + '<h2 style="color:white;margin:0 0 4px 0;">⚙️ Quiz Setup</h2>'
        + '<p style="color:#a0a8b4;font-size:0.85em;margin:0;">' + mcqSetupState.selectedUnits.size + ' units · ' + poolSize + ' questions available</p>'
        + '</div>'
        + '<div style="background:#1e2a3a;border:1px solid #2b3a55;border-radius:10px;padding:16px;margin-bottom:16px;">'
        + '<div style="font-size:0.78em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:12px;">Number of Questions</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:12px;">'
        + presets.map(function (n) {
            return '<button type="button" onclick="mcqSetCount(' + n + ')" data-preset="' + n + '" style="flex:1;min-width:52px;background:' + (n === mcqSetupState.count ? '#28a745' : '#2b3a55') + ';color:white;border:none;padding:10px 8px;border-radius:8px;font-weight:700;cursor:pointer;margin:0;font-size:0.9em;">' + n + '</button>';
        }).join('')
        + '<button type="button" onclick="mcqSetCount(' + poolSize + ')" data-preset="' + poolSize + '" style="flex:1;min-width:52px;background:' + (poolSize === mcqSetupState.count ? '#28a745' : '#2b3a55') + ';color:' + (poolSize === mcqSetupState.count ? 'white' : '#ffc107') + ';border:none;padding:10px 8px;border-radius:8px;font-weight:700;cursor:pointer;margin:0;font-size:0.9em;">ALL</button>'
        + '</div>'
        + '<input type="number" id="mcq-count-input" value="' + mcqSetupState.count + '" min="1" max="' + poolSize + '" oninput="mcqOnCustomCount(this.value)" style="width:100%;padding:10px;border-radius:8px;border:1px solid #3e506e;background:#0d1b2a;color:white;box-sizing:border-box;text-align:center;font-size:0.95em;">'
        + '</div>'
        + '<div style="background:#1e2a3a;border:1px solid #2b3a55;border-radius:10px;padding:16px;margin-bottom:20px;">'
        + '<div style="font-size:0.78em;color:#a0a8b4;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Shuffling</div>'
        + '<label style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer;">'
        + '<span style="color:#e0e6ed;font-size:0.9em;">🔀 Shuffle question order</span>'
        + '<input type="checkbox" ' + (mcqSetupState.shuffleQs ? 'checked' : '') + ' onchange="mcqSetupState.shuffleQs = this.checked" style="transform:scale(1.2);accent-color:#72efdd;"></label>'
        + '<label style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid #2b3a55;cursor:pointer;">'
        + '<span style="color:#e0e6ed;font-size:0.9em;">🔀 Shuffle answer choices</span>'
        + '<input type="checkbox" ' + (mcqSetupState.shuffleOpts ? 'checked' : '') + ' onchange="mcqSetupState.shuffleOpts = this.checked" style="transform:scale(1.2);accent-color:#72efdd;"></label>'
        + '<label style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid #2b3a55;cursor:pointer;">'
        + '<span style="color:#e0e6ed;font-size:0.9em;">🌱 Keep questions grouped by sub-topic</span>'
        + '<input type="checkbox" ' + (mcqSetupState.groupByTopic ? 'checked' : '') + ' onchange="mcqSetupState.groupByTopic = this.checked" style="transform:scale(1.2);accent-color:#72efdd;"></label>'
        + '</div>'
        + '<div style="display:flex;gap:8px;">'
        + '<button type="button" onclick="mcqSubBack()" style="flex:1;background:#2b3a55;color:white;border:1px solid #3e506e;padding:14px;border-radius:8px;font-weight:700;cursor:pointer;margin:0;">⬅ Back</button>'
        + '<button type="button" onclick="startSelectedMcq()" style="flex:2;background:#28a745;color:white;border:none;padding:14px;border-radius:8px;font-weight:700;cursor:pointer;margin:0;">🚀 Start Quiz</button>'
        + '</div>'
        + '</div>';

    container.innerHTML = html;
}

function mcqSetCount(n) {
    mcqSetupState.count = n;
    const input = document.getElementById('mcq-count-input');
    if (input) input.value = n;
    document.querySelectorAll('#quiz-form button[data-preset]').forEach(function (b) {
        const isActive = parseInt(b.dataset.preset) === n;
        const isAll = b.textContent.trim() === 'ALL';
        b.style.background = isActive ? '#28a745' : '#2b3a55';
        b.style.color = isActive ? 'white' : (isAll ? '#ffc107' : 'white');
    });
}

function mcqOnCustomCount(value) {
    const n = parseInt(value);
    if (!isNaN(n) && n > 0) mcqSetupState.count = n;
    document.querySelectorAll('#quiz-form button[data-preset]').forEach(function (b) {
        b.style.background = '#2b3a55';
        b.style.color = b.textContent.trim() === 'ALL' ? '#ffc107' : 'white';
    });
}

// ────────────────────────────────────────────────────────────
// ── Pure question picker ───────────────────────────────────
// ────────────────────────────────────────────────────────────
function buildMcqQuiz(tree, state, opts) {
    const shuffleQs = opts.shuffleQs;
    const shuffleOpts = opts.shuffleOpts;
    const groupByTopic = opts.groupByTopic;

    let pool = [];
    state.selectedUnits.forEach(function (unit) {
        const subs = state.selectedSubs[unit];
        if (!subs) return;
        subs.forEach(function (sub) {
            const bucket = (tree[unit] && tree[unit][sub]) || [];
            pool.push.apply(pool, bucket);
        });
    });
    if (pool.length === 0) return [];

    if (groupByTopic) {
        const groups = {};
        const groupKeys = [];
        pool.forEach(function (q) {
            const k = (q.mainTopic || 'Ungrouped') + '::' + (q.topic || 'General');
            if (!groups[k]) { groups[k] = []; groupKeys.push(k); }
            groups[k].push(q);
        });
        const orderedGroups = groupKeys.map(function (k) { return groups[k]; });
        if (shuffleQs) orderedGroups.forEach(function (g) { shuffle(g); });

        const targetCount = Math.max(1, parseInt(state.count) || 10);
        pool = [];
        let i = 0;
        while (pool.length < targetCount) {
            let added = false;
            for (const g of orderedGroups) {
                if (i < g.length) {
                    pool.push(g[i]);
                    added = true;
                    if (pool.length >= targetCount) break;
                }
            }
            if (!added) break;
            i++;
        }
    } else if (shuffleQs) {
        shuffle(pool);
    }

    let count = parseInt(state.count) || 10;
    if (count > pool.length) count = pool.length;
    if (count < 1) count = 1;

    let picked = pool.slice(0, count);

    picked = picked.map(function (q) {
        return shuffleOpts ? shuffleQuestionOptions(q) : Object.assign({}, q);
    });

    return picked;
}

function startSelectedMcq() {
    const tree = buildMcqTopicIndex(currentMcqData);
    const opts = {
        shuffleQs:    mcqSetupState.shuffleQs,
        shuffleOpts:  mcqSetupState.shuffleOpts,
        groupByTopic: mcqSetupState.groupByTopic
    };

    let poolSize = 0;
    mcqSetupState.selectedUnits.forEach(function (u) {
        const subs = mcqSetupState.selectedSubs[u];
        if (!subs) return;
        subs.forEach(function (s) { poolSize += ((tree[u] && tree[u][s]) || []).length; });
    });

    const requested = parseInt(mcqSetupState.count) || 10;
    if (requested > poolSize) {
        showAppNotification('ℹ️ Only ' + poolSize + ' available. Using all.', "info", 2000);
    }

    const questions = buildMcqQuiz(tree, mcqSetupState, opts);
    if (questions.length === 0) {
        showAppNotification("⚠️ No questions match your selection", "warning");
        return;
    }

    currentQuizData      = questions;
    currentQuizType      = 'mcq';
    currentQuestionIndex = 0;
    currentScore         = 0;
    isSubmissionLocked   = false;

    logAnalyticsEvent('quiz_start',
        'MCQ · ' + mcqSetupState.selectedUnits.size + ' units · ' + questions.length + 'Q');

    document.getElementById("result").innerHTML = "";
    displayMcqQuestion();
}

// ────────────────────────────────────────────────────────────
// ── Short Answer entry (demo contract unchanged) ────────────
// ────────────────────────────────────────────────────────────
function renderShortAnswers() {
    if (!currentShortData || currentShortData.length === 0) {
        showAppNotification('No short answer questions for this term.', 'info', 2000);
        return;
    }
    if (!hasFullAccess) {
        if (blockDemo('shortAnswer')) return;
        startActualShortAnswer(10);
        return;
    }

    const totalAvailable = currentShortData.length;

    if (totalAvailable <= 5) {
        startActualShortAnswer(totalAvailable);
        return;
    }

    const container = document.getElementById("quiz-form");
    const steps = [5, 10, 20, 30, 40, 50, totalAvailable];
    const stepLabels = ['5', '10', '20', '30', '40', '50', 'ALL'];

    container.innerHTML = `
        <div style="background:#1e2a3a; padding:30px; border-radius:15px; border:2px solid #ffc107; text-align:center; max-width:450px; margin:20px auto;">
            <h2 style="color:white; margin-bottom:10px;">✍️ Premium Short Answer Setup</h2>
            <p style="color:#a0a8b4; margin-bottom:20px;">Choose your practice size</p>

            <div style="margin:30px 0;">
                <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:20px 0;">
                    ${steps.map((step, index) => `
                        <button onclick="selectShortAnswerStep(${step}, '${stepLabels[index]}')"
                            style="flex:1; min-width:45px; background:${step === 10 ? '#28a745' : '#2b3a55'};
                                   color:white; border:none; padding:12px 8px; border-radius:8px;
                                   font-weight:bold; cursor:pointer;">
                            ${stepLabels[index]}
                        </button>
                    `).join('')}
                </div>

                <div style="margin-top:25px; padding-top:20px; border-top:1px solid #3e506e;">
                    <p style="color:#a0a8b4; margin-bottom:10px;">Custom number:</p>
                    <div style="display:flex; gap:10px;">
                        <input type="number" id="custom-sa-count" min="1" max="${totalAvailable}" value="10"
                               style="flex:2; padding:12px; border-radius:8px; border:1px solid #3e506e;
                                      background:#0d1b2a; color:white;">
                        <button onclick="startCustomShortAnswer()"
                                style="flex:1; background:#007bff; color:white; border:none;
                                       padding:12px; border-radius:8px; font-weight:bold; cursor:pointer;">
                            Go
                        </button>
                    </div>
                </div>

                <div style="margin-top:20px; color:#ffc107; background:#0d1b2a; padding:10px; border-radius:6px;">
                    📚 ${totalAvailable} questions available
                </div>
            </div>

            <div style="margin-top:20px;">
                <button onclick="exitQuiz()" class="back-button" style="margin-top:0;">⬅️ Back</button>
            </div>
        </div>
    `;
}

function displayMcqQuestion() {
    isSubmissionLocked = false; 
    const container = document.getElementById("quiz-form");
    const q = currentQuizData[currentQuestionIndex];
    updateProgress(currentQuestionIndex + 1, currentQuizData.length);
    
    if (!q) return showFinalMcqScore();
    
    let html = `
        <div class="question-header"><h3>MCQ ${currentQuestionIndex + 1} / ${currentQuizData.length}</h3></div>
        <div class="question-box">${parseKaeriMarkdown(q.q)}<div class="options">
    `;
    
    if (q.options) {
        q.options.forEach((opt, i) => {
            html += `<label><input type="radio" name="mcq" value="${i}"/> ${String.fromCharCode(65 + i)}. ${parseKaeriMarkdown(opt)}</label>`;
        });
    }
    
    html += `</div><button id="mcq-submit-btn" onclick="checkMcqAnswer()">✅ Submit</button></div>`;
    container.innerHTML = html;
    
    renderMath();
    document.getElementById("result").innerHTML = "";
    _focusScreen();
    readCurrentQuestion();
}

function checkMcqAnswer() {
    if (isSubmissionLocked) return;
    const selected = document.querySelector('input[name="mcq"]:checked');
    if (!selected) return showAppNotification("Select an option!", "warning");

    isSubmissionLocked = true;
    const submitBtn = document.getElementById("mcq-submit-btn");
    if(submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Processing...";
        submitBtn.style.backgroundColor = "#6c757d"; 
    }
    document.querySelectorAll('input[name="mcq"]').forEach(input => input.disabled = true);

    const resultDiv = document.getElementById("result");
    resultDiv.innerHTML = "";
    
    const q = currentQuizData[currentQuestionIndex];
    const userAnswer = parseInt(selected.value);
    let feedbackText = "";
    
    if (userAnswer === q.correct) {
        currentScore++;
        resultDiv.innerHTML = "<p>✔️ Correct!</p>";
        feedbackText = "Correct!";
        try { recordMcqAnswer(q, true); } catch (e) {}
    } else {
        resultDiv.innerHTML = `<p>❌ Correct: ${String.fromCharCode(65 + q.correct)}. ${parseKaeriMarkdown(q.options[q.correct])}</p>`;
        feedbackText = `Wrong. The correct answer is option ${String.fromCharCode(65 + q.correct)}.`;
        try { recordMcqAnswer(q, false); } catch (e) {}
    }
    
    const explanationBox = `<div class="explanation-box">${parseKaeriMarkdown(q.explanation || '')}</div>`;
    resultDiv.innerHTML += explanationBox;
    feedbackText += ` Explanation: ${humanizeLaTeX(q.explanation || '')}`;
    
    currentQuestionIndex++;

    const isLastMcq = currentQuestionIndex >= currentQuizData.length;
    const nextBtn = document.createElement("button");
    nextBtn.innerText = isLastMcq ? "Finish Quiz" : "Next ➡️";
    nextBtn.onclick = isLastMcq
        ? () => { document.getElementById("result").innerHTML = ""; showFinalMcqScore(); }
        : displayMcqQuestion;
    resultDiv.appendChild(nextBtn);

    renderMath();
    readText(feedbackText); 
}

function showFinalMcqScore() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    updateProgress(currentQuizData.length, currentQuizData.length);
    const percent = Math.round((currentScore / currentQuizData.length) * 100);
    let comment = percent >= 90 ? "🎉 Excellent work!" : percent >= 70 ? "✅ Good job!" : percent >= 50 ? "⚠️ Fair attempt." : "❌ Keep practicing!";
    
    container.innerHTML = `<h2>Quiz Complete!</h2><p>Your Score: ${currentScore} / ${currentQuizData.length} (${percent}%)</p><p><em>${comment}</em></p>`;
    
    const restartBtn = document.createElement("button");
    restartBtn.innerText = "🔍 Try Again";
    restartBtn.className = "restart-button";
    restartBtn.style.marginRight = "10px";
    restartBtn.onclick = renderQuiz;
    container.appendChild(restartBtn);

    const challengeBtn = document.createElement("button");
    challengeBtn.innerHTML = "⚔️ Challenge a Friend";
    challengeBtn.className = "challenge-button";
    challengeBtn.onclick = () => challengeFriend(currentScore, currentQuizData.length, "MCQ");
    container.appendChild(challengeBtn);

    try {
        const poolN = getMcqWrongPool().length;
        if (poolN > 0) {
            const poolBtn = document.createElement("button");
            poolBtn.type = "button";
            poolBtn.innerText = "🔁 Practice " + poolN + " to fix";
            poolBtn.style.backgroundColor = "#6610f2";
            poolBtn.style.color = "white";
            poolBtn.style.marginLeft = "10px";
            poolBtn.onclick = startMcqWrongPoolPractice;
            container.appendChild(poolBtn);
        }
    } catch (e) {}

    const previewBtn = document.createElement("button");
    previewBtn.innerText = "👁️ Preview & Print";
    previewBtn.style.backgroundColor = "#007bff"; 
    previewBtn.style.color = "white";
    previewBtn.style.marginLeft = "10px";
    previewBtn.onclick = generatePrintPreview;
    container.appendChild(previewBtn);

    const switchDiv = document.createElement("div");
    switchDiv.style.cssText = "margin-top:30px; padding:18px; background:#0d1b2a; border-radius:12px; border:1px solid #3e506e; text-align:center;";
    switchDiv.innerHTML = `
        <p style="color:#a0a8b4; margin:0 0 12px 0; font-size:0.9em;">🔄 <strong style="color:#72efdd;">Switch Learning Mode</strong></p>
        <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center;">
            <button onclick="renderShortAnswers()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">✍️ Short Answer</button>
            <button onclick="renderEssaySimulation()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">📄 Essay Sim</button>
            <button onclick="renderFlashcardTopics()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">🃏 Flashcards</button>
        </div>
    `;
    if (_pruneSwitchPanel(switchDiv)) container.appendChild(switchDiv);

    recordProgressSession('mcq', currentScore, currentQuizData.length, `${currentCourse} ${currentTerm} MCQ`);
    logAnalyticsEvent('quiz_complete', `MCQ score: ${currentScore}/${currentQuizData.length} (${percent}%)`);
}

function displayShortAnswerQuestion() {
    isSubmissionLocked = false;
    const container = document.getElementById("quiz-form");
    const q = currentQuizData[currentQuestionIndex];
    updateProgress(currentQuestionIndex + 1, currentQuizData.length);
    if (!q) return showFinalShortAnswerScore();
    
    container.innerHTML = `<h3>Short Answer ${currentQuestionIndex + 1} / ${currentQuizData.length}</h3><div class="question-box">${parseKaeriMarkdown(q.q)}</div><textarea id="short-answer-input"></textarea><button id="sa-submit-btn" onclick="checkShortAnswer()">✅ Submit</button>`;
    
    renderMath();
    document.getElementById("result").innerHTML = "";
    _focusScreen();
    readCurrentQuestion();
}

function checkShortAnswer() {
    if (isSubmissionLocked) return;
    const inputEl = document.getElementById("short-answer-input");
    const ans = inputEl.value.trim().toLowerCase();
    
    if (!ans) return showAppNotification("Please type your answer!", "warning");
    isSubmissionLocked = true;

    const submitBtn = document.getElementById("sa-submit-btn");
    if(submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Checked ✓";
        submitBtn.style.backgroundColor = "#6c757d";
    }
    inputEl.disabled = true;

    const resultDiv = document.getElementById("result");
    resultDiv.innerHTML = "";
    
    const q = currentQuizData[currentQuestionIndex];
    const matched = q.keywords.some(k => ans.includes(k.toLowerCase()));
    let feedbackText = "";
    
    if (matched) {
        currentScore++;
        resultDiv.innerHTML = "<p>✔️ Correct!</p>";
        feedbackText = "Correct!";
    } else {
        resultDiv.innerHTML = `<p>❌ Keywords: ${q.keywords.join(', ')}</p>`;
        feedbackText = `Wrong. The required keywords are: ${q.keywords.join(', ')}.`;
    }
    
    const explanationBox = `<div class="explanation-box">${parseKaeriMarkdown(q.explanation || '')}</div>`;
    resultDiv.innerHTML += explanationBox;
    feedbackText += ` Explanation: ${humanizeLaTeX(q.explanation || '')}`;
    
    currentQuestionIndex++;

    const isLastSA = currentQuestionIndex >= currentQuizData.length;
    const nextBtn = document.createElement("button");
    nextBtn.innerText = isLastSA ? "Finish" : "Next ➡️";
    nextBtn.onclick = isLastSA
        ? () => { document.getElementById("result").innerHTML = ""; showFinalShortAnswerScore(); }
        : displayShortAnswerQuestion;
    resultDiv.appendChild(nextBtn);

    renderMath();
    readText(feedbackText); 
}

function showFinalShortAnswerScore() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    updateProgress(currentQuizData.length, currentQuizData.length);
    const percent = Math.round((currentScore / currentQuizData.length) * 100);
    let comment = percent >= 90 ? "🎉 Excellent work!" : percent >= 70 ? "✅ Good job!" : percent >= 50 ? "⚠️ Fair attempt." : "❌ Keep practicing!";
    
    container.innerHTML = `<h2>Quiz Complete!</h2><p>Your Score: ${currentScore} / ${currentQuizData.length} (${percent}%)</p><p><em>${comment}</em></p>`;
    
    const restartBtn = document.createElement("button");
    restartBtn.innerText = "🔁 Try Again";
    restartBtn.className = "restart-button";
    restartBtn.style.marginRight = "10px";
    restartBtn.onclick = renderShortAnswers;
    container.appendChild(restartBtn);

    const challengeBtn = document.createElement("button");
    challengeBtn.innerHTML = "⚔️ Challenge a Friend";
    challengeBtn.className = "challenge-button";
    challengeBtn.onclick = () => challengeFriend(currentScore, currentQuizData.length, "Short Answer");
    container.appendChild(challengeBtn);

    const previewBtn = document.createElement("button");
    previewBtn.innerText = "👁️ Preview & Print";
    previewBtn.style.backgroundColor = "#007bff"; 
    previewBtn.style.color = "white";
    previewBtn.style.marginLeft = "10px";
    previewBtn.onclick = generatePrintPreview;
    container.appendChild(previewBtn);

    const switchDiv = document.createElement("div");
    switchDiv.style.cssText = "margin-top:30px; padding:18px; background:#0d1b2a; border-radius:12px; border:1px solid #3e506e; text-align:center;";
    switchDiv.innerHTML = `
        <p style="color:#a0a8b4; margin:0 0 12px 0; font-size:0.9em;">🔄 <strong style="color:#72efdd;">Switch Learning Mode</strong></p>
        <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center;">
            <button onclick="renderQuiz()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">📝 MCQ</button>
            <button onclick="renderEssaySimulation()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">📄 Essay Sim</button>
            <button onclick="renderFlashcardTopics()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">🃏 Flashcards</button>
        </div>
    `;
    if (_pruneSwitchPanel(switchDiv)) container.appendChild(switchDiv);

    recordProgressSession('shortAnswer', currentScore, currentQuizData.length, `${currentCourse} ${currentTerm} Short Answer`);
    logAnalyticsEvent('quiz_complete', `Short Answer score: ${currentScore}/${currentQuizData.length} (${percent}%)`);
}

function renderEssaySimulation() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";

    if (currentEssayData.length === 0) {
        container.innerHTML = _emptyOrRetrying('essay', "<p>No essay simulations available for this term yet.</p>");
        updateProgress(0, 0);
        return;
    }

    // Setup screen: not a running quiz (keeps beforeunload / key handlers quiet)
    currentQuizType = 'essayMenu';
    currentQuizData = [];
    currentQuestionIndex = 0;
    currentEssay = null;
    updateProgress(0, 0);

    const header = document.createElement("h2");
    header.innerText = "Select Essay Topic";
    header.style.textAlign = "center"; 
    header.style.marginBottom = "25px";
    container.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'flashcard-topic-buttons'; 

    currentEssayData.forEach((essay, index) => {
        const btn = document.createElement("button");
        btn.textContent = essay.title; 
        btn.onclick = () => attemptStartEssay(index); 
        listDiv.appendChild(btn);
    });

    container.appendChild(listDiv);
}

function attemptStartEssay(index) {
    confirmStartEssay(index);
}

// Single, atomic charge → then run (picker tap and retry share this path).
function confirmStartEssay(index) {
    if (blockDemo('essay')) return;
    startSpecificEssay(index);
}

// Essay steps are MCQ items in a sequence: options shuffle per attempt via the MCQ shuffler
// (orderMatters honoured). Step order itself is never shuffled.
function shuffleEssayOptions(essay) {
    if (!essay || !Array.isArray(essay.steps)) return essay;
    return Object.assign({}, essay, {
        steps: essay.steps.map(function (step) {
            return shuffleQuestionOptions(step);
        })
    });
}

function startSpecificEssay(index) {
    currentQuizType = 'essay';
    currentEssay = shuffleEssayOptions(currentEssayData[index]);
    currentEssayIndex = index;
    currentStepIndex = 0;
    essayScore = 0;
    document.getElementById("result").innerHTML = "";
    showEssayStep(0);
    logAnalyticsEvent('essay_start', currentEssay.title);
}

function showEssayStep(index) {
    isSubmissionLocked = false;
    const container = document.getElementById("quiz-form");
    const essay = currentEssay;
    const step = essay.steps[index];
    updateProgress(index + 1, essay.steps.length);
    if (!step) return showFinalEssayScore();
    
    let html = `
        <div class="question-header"><h3>📄 ${essay.title} — Step ${index + 1} of ${essay.steps.length}</h3>${essay.topic ? `<p>Topic: ${essay.topic}</p>` : ''}</div>
        <div class="question-box"><p><strong>Q:</strong> ${parseKaeriMarkdown(step.q)}</p><div class="options">
    `;
    step.options.forEach((opt, i) => {
        html += `<label class="option"><input type="radio" name="step-option" value="${i}" /> <span>${String.fromCharCode(65 + i)}. ${parseKaeriMarkdown(opt)}</span></label>`;
    });
    
    html += `</div><button id="essay-submit-btn" onclick="checkEssayStep()">✅ Submit Step</button></div>`;
    container.innerHTML = html;
    
    renderMath();
    document.getElementById("result").innerHTML = "";
    _focusScreen();
    readCurrentQuestion();
}

function checkEssayStep() {
    if (isSubmissionLocked) return;
    const selectedOption = document.querySelector('input[name="step-option"]:checked');
    if (!selectedOption) return showAppNotification("Please select an option!", "warning");

    isSubmissionLocked = true;
    const submitBtn = document.getElementById("essay-submit-btn");
    if(submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Processing...";
        submitBtn.style.backgroundColor = "#6c757d";
    }
    document.querySelectorAll('input[name="step-option"]').forEach(input => input.disabled = true);

    const resultDiv = document.getElementById("result");
    resultDiv.innerHTML = "";
    
    const essay = currentEssay;
    const step = essay.steps[currentStepIndex];
    const userAnswer = parseInt(selectedOption.value);
    const correct = userAnswer === step.correct;
    let feedbackText = "";
    
    if (correct) {
        essayScore++;
        resultDiv.innerHTML = "<p>✔️ Correct!</p>";
        feedbackText = "Correct!";
    } else {
        resultDiv.innerHTML = `<p>❌ Correct: ${String.fromCharCode(65 + step.correct)}. ${parseKaeriMarkdown(step.options[step.correct])}</p>`;
        feedbackText = `Wrong. The correct option is ${String.fromCharCode(65 + step.correct)}.`;
    }
    
    const explanationBox = `<div class="explanation-box">${parseKaeriMarkdown(step.explanation || '')}</div>`;
    resultDiv.innerHTML += explanationBox;
    feedbackText += ` Explanation: ${humanizeLaTeX(step.explanation || '')}`;

    const isLastStep = currentStepIndex >= essay.steps.length - 1;
    const nextBtn = document.createElement("button");
    nextBtn.innerText = isLastStep ? "Finish" : "Next ➡️";
    nextBtn.onclick = () => {
        if (!isLastStep) {
            currentStepIndex++;
            showEssayStep(currentStepIndex);
        } else {
            document.getElementById("result").innerHTML = "";
            showFinalEssayScore();
        }
    };
    resultDiv.appendChild(nextBtn);

    renderMath();
    readText(feedbackText); 
}

function showFinalEssayScore() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    updateProgress(currentEssay.steps.length, currentEssay.steps.length);
    
    const percent = Math.round((essayScore / currentEssay.steps.length) * 100);
    let comment = percent >= 90 ? "🎉 Excellent process understanding!" : percent >= 70 ? "✅ Good step-by-step grasp!" : percent >= 50 ? "⚠️ Some steps need revision." : "❌ Keep improving!";
    
    container.innerHTML = `<h2>Simulation Complete!</h2><p>Your Score: ${essayScore} / ${currentEssay.steps.length} (${percent}%)</p><p><em>${comment}</em></p>`;
    
    const retryBtn = document.createElement("button");
    retryBtn.innerText = "🔁 Retry This Essay";
    retryBtn.className = "restart-button";
    retryBtn.style.marginRight = "10px";
    retryBtn.onclick = () => confirmStartEssay(currentEssayIndex);
    container.appendChild(retryBtn);

    const challengeBtn = document.createElement("button");
    challengeBtn.innerHTML = "⚔️ Challenge a Friend";
    challengeBtn.className = "challenge-button";
    challengeBtn.onclick = () => challengeFriend(essayScore, currentEssay.steps.length, "Essay Simulation");
    container.appendChild(challengeBtn);

    const previewBtn = document.createElement("button");
    previewBtn.innerText = "👁️ Preview & Print";
    previewBtn.style.backgroundColor = "#007bff"; 
    previewBtn.style.color = "white";
    previewBtn.style.marginLeft = "10px";
    previewBtn.onclick = generatePrintPreview;
    container.appendChild(previewBtn);

    const backBtn = document.createElement("button");
    backBtn.innerText = "⬅️ Back to Topics";
    backBtn.className = "back-button"; 
    backBtn.onclick = renderEssaySimulation;
    container.appendChild(backBtn);

    const switchDiv = document.createElement("div");
    switchDiv.style.cssText = "margin-top:30px; padding:18px; background:#0d1b2a; border-radius:12px; border:1px solid #3e506e; text-align:center;";
    switchDiv.innerHTML = `
        <p style="color:#a0a8b4; margin:0 0 12px 0; font-size:0.9em;">🔄 <strong style="color:#72efdd;">Switch Learning Mode</strong></p>
        <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center;">
            <button onclick="renderQuiz()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">📝 MCQ</button>
            <button onclick="renderShortAnswers()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">✍️ Short Answer</button>
            <button onclick="renderFlashcardTopics()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">🃏 Flashcards</button>
        </div>
    `;
    if (_pruneSwitchPanel(switchDiv)) container.appendChild(switchDiv);

    recordProgressSession('essay', essayScore, currentEssay.steps.length, currentEssay.title);
    logAnalyticsEvent('essay_complete', `${currentEssay.title} score: ${essayScore}/${currentEssay.steps.length} (${percent}%)`);
}


// ============================================================
// === 7. SRS ENGINE (SPACED REPETITION - SM-2 ALGORITHM) ===
// ============================================================

const SRS_KEY_PREFIX = "kaeri_srs_v1_";

// 1. Get SRS Data for a specific card
function getCardSRS(topic, cardIndex) {
    const key = `${SRS_KEY_PREFIX}${currentTermKey}`;
    const allData = JSON.parse(localStorage.getItem(key) || "{}");
    if (!allData[topic]) allData[topic] = {};
    return allData[topic][cardIndex] || { 
        interval: 0, repetition: 0, efactor: 2.5, dueDate: 0, isNew: true
    };
}

// 2. Save SRS Data
function saveCardSRS(topic, cardIndex, srsData) {
    const key = `${SRS_KEY_PREFIX}${currentTermKey}`;
    const allData = JSON.parse(localStorage.getItem(key) || "{}");
    if (!allData[topic]) allData[topic] = {};
    allData[topic][cardIndex] = srsData;
    localStorage.setItem(key, JSON.stringify(allData));
}

// 3. The Algorithm (Calculate next review date)
function calculateNextReview(topic, cardIndex, quality) {
    let card = getCardSRS(topic, cardIndex);
    
    if (quality < 3) {
        card.repetition = 0;
        card.interval = 1; 
    } else {
        if (card.repetition === 0) {
            switch(quality) {
                case 3: card.interval = 2; break; 
                case 4: card.interval = 4; break; 
                case 5: card.interval = 7; break; 
                default: card.interval = 1;
            }
        } else if (card.repetition === 1) {
            card.interval = (card.interval >= 6) ? Math.round(card.interval * card.efactor) : 6;
        } else {
            card.interval = Math.round(card.interval * card.efactor);
        }
        card.repetition += 1;
    }

    card.efactor = card.efactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (card.efactor < 1.3) card.efactor = 1.3;

    const now = new Date();
    card.dueDate = now.setDate(now.getDate() + card.interval);
    card.isNew = false;

    saveCardSRS(topic, cardIndex, card);
    return card;
}


// ============================================================
// === 7b. MCQ WRONG-ANSWER POOL (replaces MCQ SRS) ===
// ============================================================
// Flashcards keep SM-2 (Section 7). MCQs use an honest pool:
//   • a question enters "to fix" when answered wrong
//   • it leaves after MCQ_MASTERY_STREAK correct answers in a row
//   • answered right but not yet mastered (and never missed) = "building"
//   • never answered = "new"
// Right and wrong answers are both counted, so correct work shows up immediately.
// Records are small ({w,s,c,a,t}) and keyed by a hash of the question, per term:
//   w = times wrong, s = current right-in-a-row, c = times right, a = attempts, t = last seen

const MCQ_MASTERY_STREAK = 3;

function _mcqPoolKey() {
    return 'kaeri_pool_v1_' + (currentTermKey || 'global');
}

function _hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/** Stable id for a question (works for shuffled copies too). */
function _mcqItemId(q) {
    if (!q) return '';
    const base = (q.id != null && String(q.id) !== '')
        ? 'id:' + q.id
        : (q.mainTopic || '') + '#' + (q.topic || '') + '#' + String(q.q || q.question || '');
    return base ? _hashStr(base) : '';
}

function _loadMcqPool() {
    let store = null;
    try {
        const raw = localStorage.getItem(_mcqPoolKey());
        if (raw) store = JSON.parse(raw);
    } catch (e) { store = null; }
    if (store && typeof store === 'object' && !Array.isArray(store)) return store;

    // First run for this term: carry over the previous "missed questions" list, if any.
    store = {};
    try {
        const legacyKey = 'kaeri_mcq_wrong_' + (currentTermKey || 'global');
        const raw = localStorage.getItem(legacyKey);
        if (raw) {
            const legacy = JSON.parse(raw);
            if (Array.isArray(legacy)) {
                legacy.forEach(function (lq) {
                    const id = _mcqItemId(lq);
                    if (id) store[id] = { w: 1, s: 0, c: 0, a: 1, t: Date.now() };
                });
            }
            localStorage.removeItem(legacyKey);
            _saveMcqPool(store);
        }
    } catch (e) {}
    return store;
}

function _saveMcqPool(store) {
    try { localStorage.setItem(_mcqPoolKey(), JSON.stringify(store || {})); } catch (e) { /* quota */ }
}

/** Call once per answered MCQ. */
function recordMcqAnswer(q, wasCorrect) {
    const id = _mcqItemId(q);
    if (!id) return;
    const store = _loadMcqPool();
    const rec = store[id] || { w: 0, s: 0, c: 0, a: 0, t: 0 };
    const prevC = (rec.c != null) ? rec.c : (rec.s || 0);   // older records: streak is the best count we have
    rec.t = Date.now();
    rec.a = (rec.a || 0) + 1;
    if (wasCorrect) {
        rec.s = (rec.s || 0) + 1;
        rec.c = prevC + 1;
    } else {
        rec.w = (rec.w || 0) + 1;
        rec.s = 0;
        rec.c = prevC;
    }
    store[id] = rec;
    _saveMcqPool(store);
}

function _isToFix(rec) { return !!rec && (rec.w || 0) > 0 && (rec.s || 0) < MCQ_MASTERY_STREAK; }

/**
 * Honest numbers for the current term.
 * toFix + building + mastered + fresh = total questions.
 * right / wrong = answers recorded so far (so correct work is visible, not only mistakes).
 */
function computeMcqPoolCounts() {
    const store = _loadMcqPool();
    let toFix = 0, building = 0, mastered = 0, fresh = 0, right = 0, wrong = 0;
    (currentMcqData || []).forEach(function (q) {
        const rec = store[_mcqItemId(q)];
        if (!rec) { fresh++; return; }
        const w = rec.w || 0, s = rec.s || 0;
        const c = (rec.c != null) ? rec.c : s;
        right += c; wrong += w;
        if (s >= MCQ_MASTERY_STREAK) mastered++;
        else if (w > 0) toFix++;
        else if (c > 0) building++;
        else fresh++;
    });
    return { toFix: toFix, building: building, mastered: mastered, fresh: fresh, right: right, wrong: wrong, attempts: right + wrong };
}

/** Questions currently in the pool (array of question objects). */
function getMcqWrongPool() {
    const store = _loadMcqPool();
    return (currentMcqData || []).filter(function (q) { return _isToFix(store[_mcqItemId(q)]); });
}

/** Wipes the tracking for this term (called after the student confirms in the reset dialog). */
function clearMcqWrongPool() {
    try {
        localStorage.removeItem(_mcqPoolKey());
        localStorage.removeItem('kaeri_mcq_wrong_' + (currentTermKey || 'global'));
    } catch (e) {}
}

function startWrongPoolQuiz() {
    const pool = getMcqWrongPool();
    if (!pool.length) {
        showAppNotification('🎉 Nothing to fix. Try new questions!', 'success', 2500);
        return;
    }
    // Free users: a pool session uses a demo attempt, same as any other MCQ run.
    if (!hasFullAccess) {
        if (!canUseDemo('mcq')) {
            showAppNotification('Demo limit reached. Unlock Full Access!', 'warning');
            openPaymentModal();
            return;
        }
        consumeDemoAttempt('mcq');
    }
    const container = document.getElementById('quiz-form');
    if (container) container.innerHTML = '';
    const result = document.getElementById('result');
    if (result) result.innerHTML = '';

    currentQuizData = shuffle(pool.map(shuffleQuestionOptions));
    currentQuizType = 'mcq';
    currentQuestionIndex = 0;
    currentScore = 0;
    isSubmissionLocked = false;
    logAnalyticsEvent('quiz_start', 'MCQ POOL · ' + currentQuizData.length + 'Q');
    displayMcqQuestion();
}
function startMcqWrongPoolPractice() { startWrongPoolQuiz(); }

/** Banner shown at the top of the MCQ menus. */
function _mcqPoolBannerHtml() {
    if (!currentMcqData || currentMcqData.length === 0) return '';
    let c;
    try { c = computeMcqPoolCounts(); } catch (e) { return ''; }
    const num = function (n, color) { return '<strong style="color:' + color + ';">' + n + '</strong>'; };
    const allDone = c.toFix === 0 && c.building === 0 && c.fresh === 0;
    const pct = c.attempts > 0 ? Math.round((c.right / c.attempts) * 100) : 0;

    return '<div id="mcq-pool-banner" style="background:#1e2a3a;border:1px solid #2b3a55;border-radius:10px;padding:14px;margin-bottom:16px;">'
        + '<div style="text-align:center;color:#e0e6ed;font-size:0.95em;">'
        + (allDone
            ? '🏆 All ' + num(c.mastered, '#28a745') + ' questions mastered!'
            : '<div style="display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:center;">'
              + '<span>🎯 ' + num(c.toFix, '#ef4444') + ' to fix</span>'
              + '<span>📈 ' + num(c.building, '#ffc107') + ' building</span>'
              + '<span>✅ ' + num(c.mastered, '#28a745') + ' mastered</span>'
              + '<span>✨ ' + num(c.fresh, '#72efdd') + ' new</span>'
              + '</div>')
        + '</div>'
        + (c.attempts > 0
            ? '<div style="text-align:center;color:#a0a8b4;font-size:0.82em;margin-top:8px;">'
              + '✔ ' + num(c.right, '#28a745') + ' right · ✖ ' + num(c.wrong, '#ef4444') + ' wrong · ' + pct + '% accuracy</div>'
            : '')
        + ((c.toFix > 0 || c.building > 0)
            ? '<div style="text-align:center;color:#6c7a90;font-size:0.74em;margin-top:6px;">Get a question right ' + MCQ_MASTERY_STREAK + ' times in a row to master it.</div>'
            : '')
        + (c.toFix > 0
            ? '<button type="button" onclick="startWrongPoolQuiz()" style="width:100%;margin-top:10px;background:#dc3545;color:#fff;border:none;padding:12px;border-radius:8px;font-weight:700;cursor:pointer;">Practice ' + c.toFix + ' to fix</button>'
            : '')
        + (c.attempts > 0
            ? '<div style="text-align:center;margin-top:8px;"><button type="button" onclick="askResetPool()" style="background:none;border:none;color:#8892b0;font-size:0.78em;text-decoration:underline;cursor:pointer;padding:6px;">Reset tracking</button></div>'
            : '')
        + '</div>';
}

/** Re-draws the banner in place (after a reset). */
function refreshMcqPoolBanner() {
    const el = document.getElementById('mcq-pool-banner');
    if (!el) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = _mcqPoolBannerHtml();
    if (tmp.firstElementChild) el.replaceWith(tmp.firstElementChild); else el.remove();
}

// ---------- Reset tracking (in-app confirm, not a browser popup) ----------
function askResetPool() { openOverlay(document.getElementById('pool-reset-modal')); }
function closePoolResetModal() { closeOverlay(document.getElementById('pool-reset-modal')); }
function confirmResetPool() {
    closePoolResetModal();
    clearMcqWrongPool();
    showAppNotification('🎯 Question tracking reset.', 'info', 2000);
    refreshMcqPoolBanner();
}

/** One-time cleanup of the retired MCQ spaced-repetition data. */
function _cleanupRetiredMcqSrs() {
    try {
        if (localStorage.getItem('pool_migrated_v1')) return;
        Object.keys(localStorage)
            .filter(function (k) { return k.indexOf('kaeri_mcq_srs_v1_') === 0; })
            .forEach(function (k) { localStorage.removeItem(k); });
        localStorage.setItem('pool_migrated_v1', '1');
    } catch (e) {}
}


// ============================================================
// === 8. FLASHCARD ENGINE - HYBRID MASTER (LINEAR + SRS) ===
// ============================================================

// JS-string escape first, then HTML-attribute escape (value sits inside onclick="...").
function _escOnclickArg(topic) {
    return _escAttr(topic).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                          .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- TOPIC SELECTION & MODE CHOICE ---
// Two-level picker: Parent → Subtopic, mirroring the MCQ wizard's mainTopic → topic.
// Data stays flat ("Parent: Child"); grouping is display-only. The full string is the SRS key
// and is always passed unchanged to attemptStartFlashcard / getCardSRS.
function _groupFlashcardTopics(flat) {
    const groups = {};
    for (const full in flat) {
        if (!Object.prototype.hasOwnProperty.call(flat, full)) continue;
        const sep = full.indexOf(':');
        const parent = sep > -1 ? full.slice(0, sep).trim() : 'Other';
        const child  = sep > -1 ? full.slice(sep + 1).trim() : full;
        (groups[parent] = groups[parent] || []).push({
            full: full,            // SRS key — never touched
            child: child,          // display label
            cards: flat[full]
        });
    }
    return groups;
}

// Which parent group does a topic belong to? ("Microscopy: Darkfield" → "Microscopy")
function _topicParent(topic) {
    const sep = String(topic || '').indexOf(':');
    return sep > -1 ? String(topic).slice(0, sep).trim() : 'Other';
}

function _topicDueCount(topic, cards) {
    const now = Date.now();
    let due = 0;
    (cards || currentFlashcardTopics[topic] || []).forEach(function (_, i) {
        const srs = getCardSRS(topic, i);
        if (srs.isNew || srs.dueDate <= now) due++;
    });
    return due;
}

function renderFlashcardTopics() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    currentQuizType = 'flashcard';
    updateProgress(0, 0);

    if (Object.keys(currentFlashcardTopics).length === 0) {
        container.innerHTML = _emptyOrRetrying('flashcard', "<p>No flashcards available for this term.</p>");
        return;
    }

    const groups = _groupFlashcardTopics(currentFlashcardTopics);
    const parentNames = Object.keys(groups);   // authored order

    // Only one parent → skip the parent screen
    if (parentNames.length === 1) {
        renderFlashcardSubtopics(parentNames[0]);
        return;
    }

    const header = document.createElement("h2");
    header.innerText = "Choose a Topic";
    header.style.textAlign = "center";
    header.style.marginBottom = "25px";
    container.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'flashcard-topic-buttons';

    parentNames.forEach(function (parent) {
        const subs = groups[parent];
        const due = subs.reduce(function (n, x) { return n + _topicDueCount(x.full, x.cards); }, 0);
        const cardCount = subs.reduce(function (n, x) { return n + x.cards.length; }, 0);

        const btn = document.createElement("button");
        btn.innerHTML =
            '<div style="font-size:1.1em; font-weight:700;">' + escapeHtml(parent) + '</div>' +
            '<div style="font-size:0.8em; opacity:0.8; margin-top:4px;">' +
            subs.length + ' deck' + (subs.length === 1 ? '' : 's') + ' · ' +
            cardCount + ' cards · ' + due + ' due</div>';
        btn.onclick = function () { renderFlashcardSubtopics(parent); };
        listDiv.appendChild(btn);
    });
    container.appendChild(listDiv);
}

function renderFlashcardSubtopics(parent) {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    currentQuizType = 'flashcard';
    updateProgress(0, 0);

    const groups = _groupFlashcardTopics(currentFlashcardTopics);
    const subs = groups[parent] || [];
    if (!subs.length) { renderFlashcardTopics(); return; }
    const multiParent = Object.keys(groups).length > 1;

    if (multiParent) {
        const back = document.createElement("button");
        back.className = "back-button";
        back.textContent = "⬅ All topics";
        back.style.marginBottom = "15px";
        back.onclick = function () { renderFlashcardTopics(); };
        container.appendChild(back);
    }

    const header = document.createElement("h2");
    header.innerText = (parent === 'Other') ? "Select Flashcard Topic" : parent;
    header.style.textAlign = "center";
    header.style.marginBottom = "25px";
    container.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'flashcard-topic-buttons';

    subs.forEach(function (sub) {
        const due = _topicDueCount(sub.full, sub.cards);
        const btn = document.createElement("button");
        btn.innerHTML =
            '<div style="font-weight:700;">' + escapeHtml(sub.child) + '</div>' +
            '<div style="font-size:0.8em; opacity:0.8; margin-top:4px;">' +
            sub.cards.length + ' cards · ' + due + ' due</div>';
        btn.onclick = function () { attemptStartFlashcard(sub.full); };   // SRS key preserved
        listDiv.appendChild(btn);
    });
    container.appendChild(listDiv);
}

function attemptStartFlashcard(topic) {
    if (blockDemo('flashcard')) return;
    showFlashcardModeSelection(topic);
}

function showFlashcardModeSelection(topic) {
    const container = document.getElementById("quiz-form");
    const safeCancelTopic = _escOnclickArg(topic);   // Cancel returns to this topic's subtopic list
    const totalCards = currentFlashcardTopics[topic].length;
    
    // Calculate SRS Due Count
    const now = Date.now();
    let dueCount = 0;
    currentFlashcardTopics[topic].forEach((card, index) => {
        const srs = getCardSRS(topic, index);
        if (srs.isNew || srs.dueDate <= now) dueCount++;
    });

    // Render Choice Menu
    container.innerHTML = `
        <div style="text-align: center; animation: fadeIn 0.3s;">
            <h2 style="margin-bottom: 10px; color: white;">🗂️ ${escapeHtml(topic)}</h2>
            <p style="color: #a0a8b4; margin-bottom: 25px;">Choose your study method:</p>

            <div style="display: flex; flex-direction: column; gap: 15px; max-width: 450px; margin: 0 auto;">
                
                <!-- OPTION 1: LINEAR (Review All) -->
                <button onclick="startFlashcards('${_escOnclickArg(topic)}', 'linear')" 
                    style="background: #1e2a3a; border: 2px solid #72efdd; padding: 20px; border-radius: 12px; text-align: left; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <span style="font-size: 2em;">📖</span>
                        <div>
                            <div style="font-size: 1.2em; color: white; font-weight: bold;">Standard Review</div>
                            <div style="font-size: 0.9em; color: #a0a8b4; margin-top: 5px;">Review all <strong>${totalCards}</strong> cards in order. Perfect for cramming before a test.</div>
                        </div>
                    </div>
                </button>

                <!-- OPTION 2: SRS (Smart) -->
                <button onclick="startFlashcards('${_escOnclickArg(topic)}', 'srs')" 
                    style="background: #1e2a3a; border: 2px solid #ffc107; padding: 20px; border-radius: 12px; text-align: left; cursor: pointer; transition: 0.2s; box-shadow: 0 4px 6px rgba(0,0,0,0.3);">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <span style="font-size: 2em;">🧠</span>
                        <div style="flex: 1;">
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-size: 1.2em; color: white; font-weight: bold;">Smart SRS Mode</span>
                                <span style="background: ${dueCount > 0 ? '#ffc107' : '#28a745'}; color: #000; padding: 3px 10px; border-radius: 20px; font-size: 0.8em; font-weight: bold;">${dueCount} Due</span>
                            </div>
                            <div style="font-size: 0.9em; color: #a0a8b4; margin-top: 5px;">Algorithm-based. Focus only on what you are about to forget.</div>
                        </div>
                    </div>
                </button>

            </div>
            
            <button class="back-button" style="margin-top: 30px; background: transparent; color: #888; border: 1px solid #3e506e; padding: 10px 20px; border-radius: 20px;" onclick="renderFlashcardSubtopics(_topicParent('${safeCancelTopic}'))">Cancel</button>
        </div>
    `;
}

// --- INITIALIZATION LOGIC ---
function startFlashcards(topic, mode) {
    currentFlashcardTopic = topic;
    currentFlashcardMode = mode; // Store mode
    currentCardIndex = 0;
    isCardFront = true;
    
    const allCards = currentFlashcardTopics[topic];

    if (mode === 'srs') {
        // --- SRS PATH: Filter & Sort ---
        srsQueue = [];
        const now = Date.now();
        allCards.forEach((card, originalIndex) => {
            const srs = getCardSRS(topic, originalIndex);
            if (srs.isNew || srs.dueDate <= now) {
                srsQueue.push({
                    ...card,
                    originalIndex: originalIndex,
                    srsData: srs
                });
            }
        });

        // If no cards due
        if (srsQueue.length === 0) {
            const container = document.getElementById("quiz-form");
            container.innerHTML = `
            <div style="text-align: center; animation: fadeIn 0.5s;">
                <h2 style="font-size: 3em; margin-bottom: 10px;">🎉</h2>
                <h2 style="color: #28a745;">You're Caught Up!</h2>
                <p style="color: #a0a8b4; max-width: 400px; margin: 10px auto;">You have no cards due for review right now in SRS mode.</p>
                <div style="margin-top: 20px; display: flex; flex-direction: column; gap: 10px; align-items: center;">
                    <button class="restart-button" onclick="startFlashcards('${_escOnclickArg(topic)}', 'linear')">📖 Switch to Standard Review</button>
                    <button class="back-button" onclick="renderFlashcardTopics()">⬅ Back to Topics</button>
                </div>
            </div>`;
            return;
        }

        srsQueue.sort((a, b) => a.srsData.dueDate - b.srsData.dueDate);
        currentFlashcards = srsQueue;

    } else {
        // --- LINEAR PATH: Load All ---
        currentFlashcards = allCards.map((card, index) => ({
            ...card,
            originalIndex: index
        }));
    }

    displayFlashcard();
    logAnalyticsEvent('flashcard_start', `${topic} (${mode} mode)`);
}

// --- DISPLAY ENGINE (HYBRID UI + SMART LAYOUT) ---
function displayFlashcard() {
    const container = document.getElementById("quiz-form");
    
    // Check completion
    if (currentCardIndex >= currentFlashcards.length) {
        return showFlashcardCompletion();
    }

    const cardObj = currentFlashcards[currentCardIndex]; 
    updateProgress(currentCardIndex + 1, currentFlashcards.length);
    
    // === SMART LAYOUT ANALYZER (STEM & SCROLL FIX) ===
    function getLayoutClass(text) {
        // 1. Detect Block Math ($$ ... $$) - Needs space & horizontal scroll
        const hasBlockMath = /\$\$|\\\[/.test(text);
        
        // 2. Detect SPECIFIC Chemistry & Physics Signals
        const hasScience = /(\\ce\{|\\pu\{|\\vec\{|\\int|\\sum|\\frac\{|\\sqrt\{)/.test(text);
    
        // 3. Detect Lists (Bullet points)
        const hasList = /^- /m.test(text) || /<ul>|<ol>|<li>/.test(parseKaeriMarkdown(text))
                     || /^\s*\|.*\|\s*$/m.test(text);   // pipe table
    
        // 4. Detect Text Length (lowered to 60 for mobile safety)
        const isLong = text.length > 60;
    
        // 5. Detect Newlines (3 or more lines)
        const hasBreaks = (text.match(/\n/g) || []).length > 2;
    
        // IF ANY of these are true, force Top Alignment
        if (hasBlockMath || hasScience || hasList || isLong || hasBreaks) {
            return "layout-detailed";
        }
        
        // Otherwise, center it nicely
        return "layout-center";
    }

    const frontLayout = getLayoutClass(cardObj.front);
    const backLayout = getLayoutClass(cardObj.back);
    const modeLabel = currentFlashcardMode === 'srs' ? "🧠 SRS Study" : "📖 Standard Review";

    // RENDER CARD HTML
    let html = `
        <h3 style="color: #a0a8b4; font-size: 0.9em; letter-spacing: 1px; text-transform: uppercase;">
            ${modeLabel}: ${escapeHtml(currentFlashcardTopic)} <span style="color: white;">(${currentCardIndex + 1} / ${currentFlashcards.length})</span>
        </h3>
        
        <div class="flashcard-wrapper">
            <div class="flashcard ${isCardFront ? '' : 'back-active'}" onclick="flipCard()">
                
                <!-- FRONT FACE -->
                <div class="card-face card-front ${frontLayout}">
                    ${parseKaeriMarkdown(cardObj.front)}
                    <div style="margin-top:20px; font-size:0.75em; color:#8892b0; font-style:italic; opacity:0.8;">(Tap to flip)</div>
                </div>

                <!-- BACK FACE -->
                <div class="card-face card-back ${backLayout}">
                    ${parseKaeriMarkdown(cardObj.back)}
                </div>

            </div>
        </div>
    `;

    // --- CONTROLS SECTION (THE HYBRID PART) ---
    html += `<div class="flashcard-nav-buttons" style="margin-top: 25px;">`;

    if (currentFlashcardMode === 'linear') {
        // === LINEAR CONTROLS (Prev / Flip / Next) ===
        const isLast = currentCardIndex === currentFlashcards.length - 1;
        html += `
            <button onclick="prevFlashcard()" ${currentCardIndex === 0 ? 'disabled' : ''} 
                style="background: #3e506e; border-radius: 8px; font-weight: bold;">⬅️ Prev</button>
            
            <button onclick="flipCard()" 
                style="background: #007bff; flex: 2; border-radius: 8px; font-weight: bold; box-shadow: 0 4px 0 #0056b3;">🔄 Flip Card</button>
            
            <button onclick="nextFlashcard()" 
                style="background: ${isLast ? '#28a745' : '#3e506e'}; border-radius: 8px; font-weight: bold;">
                ${isLast ? 'Finish 🏁' : 'Next ➡️'}
            </button>
        `;
    } else {
        // === SRS CONTROLS (Show / Rate) ===
        if (isCardFront) {
            html += `<button onclick="flipCard()" style="width:100%; background:#007bff; padding: 15px; border-radius: 8px; font-weight: bold; color:white; box-shadow: 0 4px 0 #0056b3;">🔄 Show Answer</button>`;
        } else {
            html += `
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:10px; width:100%;">
                    <button onclick="rateCard(0)" style="background:#dc3545; color: white; font-size:0.8em; padding:12px 2px; border-radius:8px;">❌ Again<br><small style="opacity:0.8">1d</small></button>
                    <button onclick="rateCard(3)" style="background:#ffc107; color: #333; font-size:0.8em; padding:12px 2px; border-radius:8px;">😬 Hard<br><small style="opacity:0.8">2d</small></button>
                    <button onclick="rateCard(4)" style="background:#28a745; color: white; font-size:0.8em; padding:12px 2px; border-radius:8px;">✅ Good<br><small style="opacity:0.8">4d</small></button>
                    <button onclick="rateCard(5)" style="background:#17a2b8; color: white; font-size:0.8em; padding:12px 2px; border-radius:8px;">🚀 Easy<br><small style="opacity:0.8">7d</small></button>
                </div>
            `;
        }
    }
    
    html += `</div>`;
    html += `<button class="back-to-topics-button" style="margin-top: 20px; background: transparent; color: #888;" onclick="renderFlashcardTopics()">⬅️ Back to Topics</button>`;

    container.innerHTML = html;
    
    renderMath(); // KaTeX
    _focusScreen();
    readFlashcard(); // Smart TTS
}

// --- NAVIGATION HELPERS ---
function flipCard() { 
    isCardFront = !isCardFront; 
    displayFlashcard(); 
}

function prevFlashcard() { 
    if (currentFlashcardMode !== 'linear') return; // Safety
    if (currentCardIndex > 0) { 
        currentCardIndex--; 
        isCardFront = true; 
        displayFlashcard(); 
    } 
}

function nextFlashcard() { 
    if (currentFlashcardMode !== 'linear') return; // Safety
    if (currentCardIndex < currentFlashcards.length - 1) { 
        currentCardIndex++; 
        isCardFront = true; 
        displayFlashcard(); 
    } else { 
        showFlashcardCompletion(); 
    } 
}

function rateCard(quality) {
    if (currentFlashcardMode !== 'srs') return; // Safety
    const cardObj = currentFlashcards[currentCardIndex];
    // Calculate new date
    const result = calculateNextReview(currentFlashcardTopic, cardObj.originalIndex, quality);
    
    // Feedback Toast
    const days = Math.round(result.interval);
    const msg = days === 1 ? "Review tomorrow" : `Review in ${days} days`;
    showAppNotification(`📅 ${msg}`, "info", 1500);
    
    currentCardIndex++;
    isCardFront = true;
    displayFlashcard();
}

function showFlashcardCompletion() {
    const container = document.getElementById("quiz-form");
    const msg = currentFlashcardMode === 'srs' 
        ? "You have reviewed all due cards for today." 
        : "You have reviewed all cards in this topic.";

    container.innerHTML = `
        <div style="text-align: center; animation: fadeIn 0.5s;">
            <h2>Session Complete!</h2>
            <p>${msg}</p>
        </div>
    `;
    updateProgress(currentFlashcards.length, currentFlashcards.length);

    // Dynamic buttons based on mode
    const restartBtn = document.createElement("button");
    restartBtn.innerText = "🔁 Review Again";
    restartBtn.className = "restart-button";
    restartBtn.style.marginRight = "10px";
    restartBtn.onclick = () => attemptStartFlashcard(currentFlashcardTopic); // Go back to choice
    container.appendChild(restartBtn);

    const challengeBtn = document.createElement("button");
    challengeBtn.innerHTML = "⚔️ Challenge a Friend";
    challengeBtn.className = "challenge-button";
    challengeBtn.onclick = () => challengeFriend(currentFlashcards.length, 0, "Flashcards");
    container.appendChild(challengeBtn);

    const previewBtn = document.createElement("button");
    previewBtn.innerText = "👁️ Preview & Print";
    previewBtn.style.backgroundColor = "#007bff"; 
    previewBtn.style.color = "white";
    previewBtn.style.marginLeft = "10px";
    previewBtn.onclick = generatePrintPreview;
    container.appendChild(previewBtn);

    const backBtn = document.createElement("button");
    backBtn.innerText = "⬅️ Back to Topics";
    backBtn.className = "back-button";
    backBtn.onclick = renderFlashcardTopics;
    container.appendChild(backBtn);

    // ── CHANGE 2: Switch learning modality panel ──
    const switchDiv = document.createElement("div");
    switchDiv.style.cssText = "margin-top:30px; padding:18px; background:#0d1b2a; border-radius:12px; border:1px solid #3e506e; text-align:center;";
    switchDiv.innerHTML = `
        <p style="color:#a0a8b4; margin:0 0 12px 0; font-size:0.9em;">🔄 <strong style="color:#72efdd;">Switch Learning Mode</strong></p>
        <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center;">
            <button onclick="renderQuiz()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">📝 MCQ</button>
            <button onclick="renderShortAnswers()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">✍️ Short Answer</button>
            <button onclick="renderEssaySimulation()" style="background:#2b3a55; color:white; border:1px solid #3e506e; padding:8px 14px; border-radius:8px; cursor:pointer; font-size:0.85em;">📄 Essay Sim</button>
        </div>
    `;
    if (_pruneSwitchPanel(switchDiv)) container.appendChild(switchDiv);

    recordProgressSession('flashcard', currentFlashcards.length, currentFlashcards.length, `${currentFlashcardTopic} Flashcards`);
    logAnalyticsEvent('flashcard_complete', `${currentFlashcardTopic} (${currentFlashcardMode} mode)`);
}

// ============================================================
// === 9. SMART FEATURES & PRINT ===
// ============================================================

function challengeFriend(score, total, modeName) {
    const link = "https://kaerikalmar.github.io/KaeriEdTech";
    let message = "";
    
    if (modeName === "Flashcards") {
        message = `I mastered the ${score} Flashcard Deck on Kaeri EdTech! I Challenge you to beat me! 👇\n${link}`;
    } else {
        const percent = Math.round((score / total) * 100);
        message = `I scored ${percent}% (${score}/${total}) in ${currentCourse} ${currentTerm} (${modeName})! Challenge you to beat my score! 👇\n${link}`;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
}

// ── BRAND CONSTANTS (unchanged) ─────────────────────────────────────────
const COURSE_IDENTITY = {
    'CS110': { accent: '#00bcd4', name: 'Introduction to Computing' },
    'MA110': { accent: '#42a5f5', name: 'Mathematics' },
    'PH110': { accent: '#ab47bc', name: 'Physics' },
    'CH110': { accent: '#ef5350', name: 'Chemistry' },
    'BI110': { accent: '#7cb342', name: 'Biology' },
    'BI111': { accent: '#7cb342', name: 'Biology' },
    'LA111': { accent: '#ffa726', name: 'Communication Skills' },
    'MT221': { accent: '#26a69a', name: 'Mineral Processing' },
};

const SECTION_PALETTE = [
    { bg: '#f1f8e9', acc: '#7cb342' },
    { bg: '#e0f7fa', acc: '#00bcd4' },
    { bg: '#ffebee', acc: '#ef5350' },
    { bg: '#e3f2fd', acc: '#42a5f5' },
    { bg: '#f3e5f5', acc: '#ab47bc' },
    { bg: '#fff3e0', acc: '#ffa726' },
    { bg: '#e0f2f1', acc: '#26a69a' },
    { bg: '#fce4ec', acc: '#ec407a' },
    { bg: '#f9fbe7', acc: '#c0ca33' },
];

const SESSION_LABELS = {
    mcq:         { title: 'Multiple Choice',    icon: '📋' },
    shortAnswer: { title: 'Short Answer',       icon: '✍️'  },
    essay:       { title: 'Essay Simulation',   icon: '📄' },
    flashcard:   { title: 'Flashcard Glossary', icon: '🃏' },
};

function _courseIdentity(course) {
    return COURSE_IDENTITY[course] || { accent: '#111435', name: course };
}
function _termLabel(term) {
    return term ? 'Term ' + term.replace('T', '') : '';
}

function _buildSectionsFromSession() {
    const type = currentQuizType;
    const sections = [];

    if (type === 'mcq' || type === 'shortAnswer') {
        const groups = {}, order = [];
        currentQuizData.forEach((q) => {
            const topic = q.topic || q.section || 'General';
            if (!groups[topic]) { groups[topic] = []; order.push(topic); }
            groups[topic].push(q);
        });
        order.forEach((topic, i) => {
            sections.push({
                num:   i + 1,
                name:  topic,
                pal:   SECTION_PALETTE[i % SECTION_PALETTE.length],
                items: groups[topic],
            });
        });
    } else if (type === 'essay' && currentEssay) {
        sections.push({
            num:   1,
            name:  currentEssay.title,
            pal:   SECTION_PALETTE[0],
            items: currentEssay.steps,
        });
    } else if (type === 'flashcard') {
        // Flashcards are Main topic → Subtopic ("Parent: Child"). The kit prints the whole subtopic
        // deck in authored order (not just the SRS-due queue) and labels both levels.
        const full   = currentFlashcardTopic || '';
        const sep    = full.indexOf(':');
        const parent = sep > -1 ? full.slice(0, sep).trim() : '';
        const child  = sep > -1 ? full.slice(sep + 1).trim() : full;
        const deck   = (currentFlashcardTopics && currentFlashcardTopics[full]) || currentFlashcards || [];
        sections.push({
            num:    1,
            parent: parent,                       // Main topic ('' when the topic has no "Parent:" prefix)
            name:   child,                        // Subtopic
            pal:    SECTION_PALETTE[3],
            items:  deck.map(function (c) { return { front: c.front, back: c.back }; }),   // drop SRS fields
        });
    }
    return sections;
}

// "Main topic › Subtopic" label used on kit cards (plain subtopic when there is no main topic)
function _kitSectionLabel(sec) {
    return sec.parent ? sec.parent + ' › ' + sec.name : sec.name;
}

function _itemCardHTML(item, sectionName, type, idx, pal) {
    const acc = pal.acc;
    let labelText = '', qHTML = '', aHTML = '', eHTML = '';

    function md(t) { return t ? parseKaeriMarkdown(t) : ''; }

    if (type === 'mcq') {
        labelText = 'Q' + (idx + 1);
        qHTML = md(item.q);

        // Full options list — highlight correct choice for revision-kit self-test
        let optionsHTML = '<div style="margin:8px 0 10px 0;">';
        (item.options || []).forEach(function (opt, i) {
            const letter    = String.fromCharCode(65 + i);
            const isCorrect = (i === item.correct);
            if (isCorrect) {
                optionsHTML += '<div style="padding:5px 10px;margin:3px 0;'
                    + 'background:#e8f5e9;border-left:4px solid #28a745;'
                    + 'border-radius:0 4px 4px 0;font-weight:700;color:#1e3a2f;">'
                    + letter + '. ' + md(opt) + ' <span style="color:#28a745;">✓</span>'
                    + '</div>';
            } else {
                optionsHTML += '<div style="padding:5px 10px;margin:3px 0;color:#444;">'
                    + letter + '. ' + md(opt)
                    + '</div>';
            }
        });
        optionsHTML += '</div>';

        qHTML += optionsHTML;
        aHTML = '<strong>Answer:</strong> ' + String.fromCharCode(65 + item.correct);
        eHTML = md(item.explanation || 'No additional explanation.');
    } else if (type === 'shortAnswer') {
        labelText = 'Q' + (idx + 1);
        qHTML = md(item.q);
        aHTML = '<strong>Keywords:</strong> ' + (item.keywords || []).join(', ');
        eHTML = md(item.explanation || 'No additional explanation.');
    } else if (type === 'essay') {
        labelText = 'Step ' + (idx + 1);
        qHTML = md(item.q);

        // Same layout as MCQ: all options, correct one highlighted
        let optionsHTML = '<div style="margin:8px 0 10px 0;">';
        (item.options || []).forEach(function (opt, i) {
            const letter    = String.fromCharCode(65 + i);
            const isCorrect = (i === item.correct);
            if (isCorrect) {
                optionsHTML += '<div style="padding:5px 10px;margin:3px 0;'
                    + 'background:#e8f5e9;border-left:4px solid #28a745;'
                    + 'border-radius:0 4px 4px 0;font-weight:700;color:#1e3a2f;">'
                    + letter + '. ' + md(opt) + ' <span style="color:#28a745;">✓</span>'
                    + '</div>';
            } else {
                optionsHTML += '<div style="padding:5px 10px;margin:3px 0;color:#444;">'
                    + letter + '. ' + md(opt)
                    + '</div>';
            }
        });
        optionsHTML += '</div>';

        qHTML += optionsHTML;
        aHTML = '<strong>Answer:</strong> ' + String.fromCharCode(65 + item.correct);
        eHTML = md(item.explanation || 'No additional explanation.');
    } else if (type === 'flashcard') {
        labelText = 'Card ' + (idx + 1);
        qHTML = md(item.front);
        aHTML = md(item.back);
        eHTML = '';
    }

    return `
    <div style="border:1px solid #ddd;border-left:5px solid ${acc};border-radius:6px;background:#fff;
                padding:13px 15px;box-shadow:0 2px 5px rgba(0,0,0,0.05);
                page-break-inside:avoid;break-inside:avoid;margin-bottom:0;">
        <div style="font-size:10px;font-weight:800;color:${acc};letter-spacing:0.5px;margin-bottom:3px;text-transform:uppercase;">${labelText}</div>
        <div style="font-size:9px;font-weight:600;color:${acc};text-transform:uppercase;letter-spacing:0.3px;margin-bottom:5px;">${sectionName}</div>
        <div style="font-size:13px;font-weight:700;color:#111435;margin-bottom:9px;line-height:1.4;">${qHTML}</div>
        <div style="font-size:12px;font-weight:500;color:#1e3a2f;background:#f0faf4;padding:6px 10px;border-radius:4px;margin-bottom:6px;">${aHTML}</div>
        ${eHTML ? `<div style="background:#f9f9f9;padding:6px 10px;font-size:11px;color:#333;line-height:1.45;border-left:4px solid ${acc};border-radius:0 4px 4px 0;">
            <span style="font-weight:800;color:${acc};text-transform:uppercase;font-size:10px;margin-right:4px;">EXPLANATION</span>${eHTML}</div>` : ''}
    </div>`;
}

// ── IN-APP PREVIEW (unchanged) ─────────────────────────────────────────────
function generatePrintPreview() {
    const sections = _buildSectionsFromSession();
    const date     = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
    const sessInfo = SESSION_LABELS[currentQuizType] || { title: currentQuizType, icon: '📄' };
    const identity = _courseIdentity(currentCourse);
    const termLbl  = _termLabel(currentTerm);

    let totalItems = 0;
    sections.forEach(s => { totalItems += s.items.length; });

    let previewHTML = `
    <div style="font-family:Arial,sans-serif;color:#1a1a1a;font-size:10pt;">
        <div style="border-bottom:3px solid #111435;padding-bottom:10px;margin-bottom:18px;">
            <div style="margin-bottom:8px;">${_brandLogoImg(40, 8)}</div>
            <div style="font-size:9px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">
                ${currentCourse} · ${identity.name} · ${termLbl}
            </div>
            <h2 style="font-size:16pt;margin:0 0 4px 0;color:#111435;">${sessInfo.icon} ${sessInfo.title}</h2>
            <div style="font-size:8pt;color:#555;">Generated: ${date} &nbsp;|&nbsp; ${totalItems} items across ${sections.length} section${sections.length !== 1 ? 's' : ''}</div>
            <div style="font-size:7.5pt;color:#888;margin-top:3px;border-top:1px solid #eee;padding-top:3px;">
                Kaeri EdTech Study Systems &nbsp;|&nbsp; 📞 096-100-5406 &nbsp;|&nbsp; 096-431-2504
            </div>
        </div>`;

    sections.forEach(s => {
        previewHTML += `
        <div style="background:${s.pal.bg};color:${s.pal.acc};padding:7px 12px;
                    border-left:5px solid ${s.pal.acc};font-weight:700;font-size:11px;
                    margin-bottom:8px;border-radius:3px;">
            ${s.parent ? `<div style="font-size:9px;font-weight:700;letter-spacing:0.5px;opacity:0.85;margin-bottom:2px;">MAIN TOPIC · ${s.parent.toUpperCase()}</div>` : ''}SECTION ${s.num} · ${s.name.toUpperCase()}
        </div>`;
        s.items.forEach((item, idx) => {
            previewHTML += `<div style="margin-bottom:8px;">${_itemCardHTML(item, _kitSectionLabel(s), currentQuizType, idx, s.pal)}</div>`;
        });
    });

    previewHTML += `
        <div style="margin-top:18px;padding-top:10px;border-top:1px solid #ddd;text-align:center;font-size:7.5pt;color:#888;">
            Study smarter with Kaeri EdTech &mdash; 📞 096-100-5406 &nbsp;|&nbsp; 096-431-2504
        </div>
    </div>`;

    printContentData = {
        sections,
        date,
        course:      currentCourse,
        term:        currentTerm,
        sessionType: currentQuizType,
    };

    const previewContent = document.getElementById('print-preview-content');
    if (previewContent) {
        previewContent.innerHTML = previewHTML;
        if (typeof renderMath === 'function') renderMath('print-preview-content');
    }

    document.getElementById('print-preview-modal').classList.add('show');
    document.body.style.overflow = 'hidden';
}

// ── PROCEED TO PRINT (with access guard, analytics, modal behaviour) ──
function proceedToPrint() {
    // Free users: close preview, notify, open payment modal, log attempt
    if (!hasFullAccess) {
        closePrintPreview();
        showAppNotification("🔒 Unlock Full Access To Print The Revision Kits", "warning", 5000);
        openPaymentModal();
        logAnalyticsEvent('print_attempt_blocked', `${currentCourse} ${currentTerm} - ${currentQuizType}`);
        return;
    }

    // Paid users: proceed
    if (!printContentData) return;
    closePrintPreview();

    const { sections, date, course, term, sessionType } = printContentData;
    const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);
    
    // Log successful print generation
    logAnalyticsEvent('print_pdf_generated', `${course} ${term} | ${sessionType} | ${totalItems} items`);

    const fullHTML = _buildFullPrintDocument(course, term, sessionType, sections, date);

    const printWin = window.open('', '_blank');
    if (!printWin) {
        showAppNotification('⚠️ Pop-up blocked. Allow pop-ups for this site, then tap Print again.', 'warning', 5000);
        const blob = new Blob([fullHTML], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
    }

    printWin.document.open();
    printWin.document.write(fullHTML);
    printWin.document.close();
}

function closePrintPreview() {
    const modal = document.getElementById('print-preview-modal');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = 'auto';
}

// ── FULL BRANDED A4 PRINT DOCUMENT (GENERIC DESIGN + ALL IMPROVEMENTS) ──
function _buildFullPrintDocument(course, term, sessionType, sections, date) {
    const identity  = _courseIdentity(course);
    const termLabel = _termLabel(term);
    const sessInfo  = SESSION_LABELS[sessionType] || { title: sessionType, icon: '📄' };
    
    // ✅ QR code points to Kaeri EdTech revision platform
// ✅ Updated URL + vertical-line-style QR rendering attempt
const platformUrl = 'https://kaerikalmar.github.io/KaeriEdTech';
const qrUrl = 'https://quickchart.io/qr?text=' + encodeURIComponent(platformUrl) + '&dark=111435&size=300&margin=2';

    let totalItems = 0;
    sections.forEach(s => { totalItems += s.items.length; });

    // Build TOC rows
    let tocRows = '';
    sections.forEach(s => {
        const typePrefix = sessionType === 'flashcard' ? 'Card' : sessionType === 'essay' ? 'Step' : 'Q';
        tocRows += `
        <div style="display:flex;align-items:center;padding:11px 18px;border-radius:4px;
                    font-size:12px;font-weight:500;background:${s.pal.bg};margin-bottom:6px;
                    page-break-inside:avoid;break-inside:avoid;">
            <span style="font-weight:800;color:${s.pal.acc};margin-right:18px;min-width:22px;">${String(s.num).padStart(2, '0')}</span>
            <span style="flex-grow:1;color:#222;">${s.parent ? `<span style="display:block;font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:${s.pal.acc};margin-bottom:2px;">${s.parent}</span>` : ''}${s.name}</span>
            <span style="color:#666;margin-right:14px;font-size:10px;">${typePrefix}1 – ${typePrefix}${s.items.length}</span>
            <span style="font-weight:700;color:${s.pal.acc};">${s.items.length} items</span>
        </div>`;
    });

    const sectionsJSON = JSON.stringify(sections);
    const currentYear = new Date().getFullYear();

    // Cover: Main topic / Subtopic (flashcard kits)
    const kitParents = sections.map(s => s.parent).filter((p, i, a) => p && a.indexOf(p) === i);
    const coverTopicHTML = kitParents.length ? `
        <div style="margin-top:22px;max-width:78%;border-left:4px solid var(--yellow);padding-left:14px;">
            <div style="font-size:10px;font-weight:800;color:var(--yellow);letter-spacing:1.5px;">MAIN TOPIC</div>
            <div style="font-size:17px;font-weight:700;color:white;margin:2px 0 10px 0;line-height:1.3;">${kitParents.join(' · ')}</div>
            <div style="font-size:10px;font-weight:800;color:var(--yellow);letter-spacing:1.5px;">SUBTOPIC${sections.length !== 1 ? 'S' : ''}</div>
            <div style="font-size:14px;font-weight:500;color:#ddd;margin-top:2px;line-height:1.4;">${sections.map(s => s.name).join(' · ')}</div>
        </div>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kaeri EdTech · ${course} ${termLabel} · ${sessInfo.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<!-- KaTeX CSS + JS -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/mhchem.min.js"></script>
<style>
    :root { --primary:#111435; --yellow:#fccb00; }
    *, *::before, *::after { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body { margin:0; padding:0; background:#e6e6e6; font-family:'Inter',Arial,sans-serif; }
    @page { size:A4; margin:0; }
    .sheet { width:210mm; height:297mm; background:white; margin:20px auto; position:relative; overflow:hidden; page-break-after:always; box-shadow:0 0 15px rgba(0,0,0,0.25); }
    @media print { body { background:none; } .sheet { margin:0; box-shadow:none; } }
    .pg-header { position:absolute; top:13mm; left:14mm; right:14mm; height:14mm; border-bottom:2px solid var(--primary); display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:5px; color:var(--primary); }
    .pg-footer { position:absolute; bottom:13mm; left:14mm; right:14mm; height:10mm; border-top:1px solid #ccc; display:flex; justify-content:space-between; align-items:center; font-size:9px; color:#888; padding-top:4px; }
    .pg-content { position:absolute; top:32mm; bottom:27mm; left:14mm; right:14mm; overflow:hidden; display:flex; flex-direction:column; }
    :root { --brand-logo: url('${_brandLogoURI()}'); }
    .brand-mark { display:inline-block; flex:none; background-image:var(--brand-logo); background-size:contain; background-repeat:no-repeat; background-position:center; }
    .brand-mark.hd { width:9mm; height:9mm; border-radius:2mm; }
    .brand-mark.cv { width:22mm; height:22mm; border-radius:4mm; }
    .brand-mark.bk { width:30mm; height:30mm; border-radius:5mm; }
    .brand { display:inline-flex; align-items:center; gap:7px; font-weight:800; font-size:13px; letter-spacing:0.5px; text-transform:uppercase; color:var(--primary); }
    .meta { font-size:9px; font-weight:600; color:#666; text-transform:uppercase; }
    .pg-num { font-weight:700; color:var(--primary); }
    .sheet.cover { background:var(--primary); color:white; display:flex; flex-direction:column; justify-content:center; padding:18mm; }
    .cover-graphics { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
    .diag { position:absolute; top:-50%; right:-20%; width:150%; height:150%; background:linear-gradient(135deg,transparent 45%,rgba(252,203,0,0.13) 45%,rgba(252,203,0,0.13) 55%,transparent 55%); transform:rotate(25deg); }
    .circ { position:absolute; bottom:-150px; left:-150px; width:400px; height:400px; border-radius:50%; background:rgba(26,32,85,0.75); }
    .cover-inner { position:relative; z-index:2; height:100%; display:flex; flex-direction:column; justify-content:center; }
    .stats-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:36px 0; max-width:72%; }
    .stat-num { font-size:40px; font-weight:800; color:var(--yellow); display:block; line-height:1; }
    .stat-lbl { font-size:10px; text-transform:uppercase; color:#ddd; letter-spacing:1px; }
    .cover-rule { border-top:1px solid var(--yellow); padding-top:18px; margin-top:auto; }
    .sec-title { font-size:13px; font-weight:800; color:var(--primary); border-bottom:3px solid var(--yellow); padding-bottom:8px; margin-bottom:14px; }
    #kaeri-loading { position:fixed; inset:0; background:rgba(17,20,53,0.92); display:flex; flex-direction:column; align-items:center; justify-content:center; z-index:9999; color:white; font-family:'Inter',Arial,sans-serif; gap:18px; }
    .kaeri-spinner { width:48px; height:48px; border:4px solid rgba(252,203,0,0.2); border-top-color:#fccb00; border-radius:50%; animation:spin 0.8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    #kaeri-loading p { font-size:14px; color:#fccb00; font-weight:600; margin:0; }
    .how-to-box { background:#e8eaf6; border-left:5px solid #1a237e; padding:12px 16px; border-radius:0 8px 8px 0; margin:15px 0; }
    .how-to-step { display:flex; gap:10px; margin-bottom:7px; }
    .step-num { width:20px; height:20px; border-radius:50%; background:#1a237e; color:white; font-size:10px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .toc-item { display:flex; align-items:center; padding:10px 16px; border-radius:5px; font-size:12px; font-weight:500; margin-bottom:5px; background:#f4f4fa; }
    .toc-num { font-weight:800; margin-right:16px; width:22px; }
    .q-card { border:1px solid #c0c0e0; padding:12px 14px; border-radius:7px; background:white; margin-bottom:10px; box-shadow:0 2px 5px rgba(0,0,0,0.05); }
    .q-head { font-size:10.5px; font-weight:800; margin-bottom:4px; }
    .q-text { font-size:14px; font-weight:700; color:var(--primary); margin-bottom:8px; line-height:1.4; }
    .ans { font-size:12px; font-weight:500; background:#f0faf4; padding:7px 11px; border-radius:6px; margin-bottom:7px; border-left:4px solid var(--acc); }
    .expl { background:#f4f4fa; padding:6px 10px; font-size:11px; border-left:3px solid var(--acc); border-radius:0 5px 5px 0; }
    .topic-banner { background:var(--bg); color:var(--acc); padding:8px 13px; border-left:6px solid var(--acc); font-weight:700; margin-bottom:12px; }
    .kaeri-table-wrap { margin:8px 0 10px; border:1px solid #c0c0e0; border-radius:6px; overflow:hidden; }
    .kaeri-table { border-collapse:collapse; width:100%; font-size:inherit; line-height:1.4; }
    .kaeri-table th { background:var(--bg,#e8eaf6); color:var(--acc,#1a237e); font-weight:800; font-size:0.92em; padding:5px 8px; border-bottom:2px solid var(--acc,#1a237e); vertical-align:bottom; }
    .kaeri-table td { padding:5px 8px; border-bottom:1px solid #e1e1f0; vertical-align:top; font-weight:500; color:#333; }
    .kaeri-table tbody tr:nth-child(even) td { background:#f7f7fc; }
    .kaeri-table tbody tr:last-child td { border-bottom:none; }
    .kaeri-table tr { break-inside:avoid; page-break-inside:avoid; }
    .katex-display { overflow-x: auto; overflow-y: hidden; padding-bottom: 5px; }
</style>
</head>
<body>

<div id="kaeri-loading">
    <div class="kaeri-spinner"></div>
    <p>Building your revision kit…</p>
    <small>Print dialog will open automatically</small>
</div>

<!-- FRONT COVER -->
<div class="sheet cover">
    <div class="cover-graphics"><div class="diag"></div><div class="circ"></div></div>
    <div class="cover-inner">
        <div style="color:var(--yellow);font-weight:700;font-size:11px;letter-spacing:2px;margin-bottom:18px;">
            ${course} · ${identity.name.toUpperCase()}
        </div>
        <h1 style="font-size:46px;font-weight:800;line-height:1.1;margin:0 0 16px 0;">
            ${termLabel}<br>${sessInfo.icon} ${sessInfo.title}
        </h1>
        <p style="font-size:16px;font-weight:300;color:#ddd;line-height:1.5;margin:0;">
            Complete Study Kit &mdash; ${totalItems} Items
        </p>
        ${coverTopicHTML}
        <div class="stats-grid">
            <div><span class="stat-num">${totalItems}</span><span class="stat-lbl">ITEMS</span></div>
            <div><span class="stat-num">${sections.length}</span><span class="stat-lbl">SECTIONS</span></div>
            <div><span class="stat-num" style="font-size:22px;">${course}</span><span class="stat-lbl">COURSE</span></div>
            <div><span class="stat-num">A4</span><span class="stat-lbl">FORMAT</span></div>
        </div>
        <div class="cover-rule">
            <div style="margin-bottom:10px;"><i class="brand-mark cv"></i></div>
            <h3 style="color:var(--yellow);margin:0;">KAERI EDTECH</h3>
            <p style="font-size:10px;opacity:0.75;margin-top:4px;">${identity.name} · ${termLabel} · ${date}</p>
        </div>
    </div>
</div>

<!-- TABLE OF CONTENTS -->
<div class="sheet">
    <div class="pg-header"><span class="brand"><i class="brand-mark hd"></i>KAERI EDTECH</span><span class="meta">${course} · ${termLabel}</span></div>
    <div class="pg-footer"><span>© ${currentYear} Kaeri EdTech</span><span class="pg-num">Page 2</span></div>
    <div class="pg-content">
        <div class="sec-title">Table of Contents &mdash; ${sections.length} Section${sections.length !== 1 ? 's' : ''}</div>
        ${tocRows}
        <div class="how-to-box">
            <div class="how-to-step"><div class="step-num">1</div><div><strong>Study the Question.</strong> Read each as a learning objective.</div></div>
            <div class="how-to-step"><div class="step-num">2</div><div><strong>Memorize the Answer.</strong> These are the direct facts for the exam.</div></div>
            <div class="how-to-step"><div class="step-num">3</div><div><strong>Internalize the Explanation.</strong> This is the standalone teaching.</div></div>
        </div>
    </div>
</div>

<div id="dynamic-content"></div>

<!-- BACK COVER (with QR code pointing to REVISION PLATFORM) -->
<div class="sheet cover" style="justify-content:flex-start;">
    <div class="cover-graphics"><div class="diag" style="background:linear-gradient(135deg,transparent 45%,rgba(252,203,0,0.08) 45%,rgba(252,203,0,0.08) 55%,transparent 55%);"></div></div>
    <div class="cover-inner" style="justify-content:space-between;">
        <div>
            <div style="margin-bottom:14px;"><i class="brand-mark bk"></i></div>
            <h1 style="color:white;font-size:44px;margin-bottom:8px;">KAERI EDTECH</h1>
            <p style="color:#ddd;font-weight:300;font-size:16px;">Empowering Learners Through Smart Educational Technology</p>
        </div>
        <div style="background:rgba(255,255,255,0.05);border-left:5px solid var(--yellow);padding:22px;border-radius:8px;">
            <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap;">
                <div style="flex:1;">
                    <div style="font-size:10px;font-weight:800;color:var(--yellow);letter-spacing:1px;margin-bottom:8px;">CALL / WHATSAPP</div>
                    <div style="font-size:22px;font-weight:800;color:white;margin-bottom:3px;">096-100-5406</div>
                    <div style="font-size:22px;font-weight:800;color:white;margin-bottom:18px;">096-431-2504</div>
                    <div style="font-size:10px;font-weight:800;color:var(--yellow);letter-spacing:1px;margin-bottom:4px;">ACCESS OUR REVISION PLATFORM</div>
                    <div style="font-size:11px;color:#aaa;">Scan to access the official Kaeri EdTech revision site for ${course} resources, past papers, and more.</div>
                </div>
                <img src="${qrUrl}" width="110" height="110" style="border:2px solid white;border-radius:8px;">
            </div>
        </div>
        <div style="font-size:10px;color:#aaa;line-height:1.7;border-top:1px solid #333;padding-top:16px;">
            <strong>Document:</strong> ${course} · ${identity.name} · ${termLabel} · ${sessInfo.title}<br>
            <strong>Generated:</strong> ${date} &nbsp;&nbsp;
            <strong>© ${currentYear} Kaeri EdTech. All rights reserved.</strong>
        </div>
    </div>
</div>

<script>
(function() {
    'use strict';
    const sectionsData = ${sectionsJSON};
    const sessionType = '${sessionType}';
    const courseName = '${course}';
    const termLabel = '${termLabel}';
    const sessTitle = '${sessInfo.title}';

    // Markdown parser — the exact functions from the main engine (tables included), embedded verbatim
    ${[kaeriConvertTables, _kaeriInline, parseKaeriMarkdown].map(function (f) { return f.toString(); }).join(String.fromCharCode(10))}

    // Pagination setup
    const MM = 3.7795275591;
    const PAGE_H = 297 * MM;
    const TOP = 32 * MM;
    const BOT = 27 * MM;
    const CONT_H = PAGE_H - TOP - BOT - 22;
    const CONT_W = (210 - 28) * MM;
    const GAP = 10;

    const root = document.getElementById('dynamic-content');
    const sb = document.createElement('div');
    sb.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:' + CONT_W + 'px;visibility:hidden;pointer-events:none;font-family:Inter,Arial,sans-serif;';
    document.body.appendChild(sb);

    let pageCount = 2; // cover=1, TOC=2
    function newPage() {
        pageCount++;
        const sheet = document.createElement('div');
        sheet.className = 'sheet';
        sheet.innerHTML = '<div class="pg-header"><span class="brand"><i class="brand-mark hd"></i>KAERI EDTECH</span><span class="meta">' + courseName + ' · ' + termLabel + ' · ' + sessTitle + '</span></div>' +
                          '<div class="pg-footer"><span>© ${currentYear} Kaeri EdTech. All rights reserved.</span><span class="pg-num">Page ' + pageCount + '</span></div>' +
                          '<div class="pg-content" id="pg-' + pageCount + '"></div>';
        root.appendChild(sheet);
        return { el: sheet.querySelector('#pg-' + pageCount), used: 0 };
    }

    function measure(el) {
        sb.innerHTML = '';
        const clone = el.cloneNode(true);
        clone.style.width = '100%';
        sb.appendChild(clone);
        return clone.offsetHeight + 5;
    }

    function place(el, state, gap = GAP) {
        const h = measure(el);
        const g = state.used > 0 ? gap : 0;
        if (state.used + h + g > CONT_H) state = newPage();
        if (state.used > 0) {
            const spacer = document.createElement('div');
            spacer.style.height = gap + 'px';
            state.el.appendChild(spacer);
        }
        state.el.appendChild(el);
        state.used += h + (state.used > 0 ? gap : 0);
        return state;
    }

    function createCard(item, secName, idx, pal) {
        const card = document.createElement('div');
        card.className = 'q-card';
        card.style.setProperty('--acc', pal.acc);
        card.style.setProperty('--bg', pal.bg);

        let qText = '', ansHtml = '', explHtml = '';
        if (sessionType === 'mcq') {
            qText = parseKaeriMarkdown(item.q || '');
            var opts = item.options || [];
            var optsHtml = '<div style="margin:8px 0 10px 0;">';
            for (var i = 0; i < opts.length; i++) {
                var letter = String.fromCharCode(65 + i);
                var isCorrect = (i === item.correct);
                if (isCorrect) {
                    optsHtml += '<div style="padding:5px 10px;margin:3px 0;background:#e8f5e9;border-left:4px solid #28a745;border-radius:0 4px 4px 0;font-weight:700;color:#1e3a2f;">'
                        + letter + '. ' + parseKaeriMarkdown(opts[i])
                        + ' <span style="color:#28a745;">✓</span></div>';
                } else {
                    optsHtml += '<div style="padding:5px 10px;margin:3px 0;color:#444;">'
                        + letter + '. ' + parseKaeriMarkdown(opts[i]) + '</div>';
                }
            }
            optsHtml += '</div>';
            qText += optsHtml;
            ansHtml = '<strong>Answer:</strong> ' + String.fromCharCode(65 + item.correct);
            explHtml = parseKaeriMarkdown(item.explanation || 'No additional explanation.');
        } else if (sessionType === 'shortAnswer') {
            qText = parseKaeriMarkdown(item.q || '');
            ansHtml = '<strong>Keywords:</strong> ' + (item.keywords || []).join(', ');
            explHtml = parseKaeriMarkdown(item.explanation || 'No additional explanation.');
        } else if (sessionType === 'essay') {
            qText = parseKaeriMarkdown(item.q || '');
            var eOpts = item.options || [];
            var eOptsHtml = '<div style="margin:8px 0 10px 0;">';
            for (var j = 0; j < eOpts.length; j++) {
                var eLetter = String.fromCharCode(65 + j);
                var eIsCorrect = (j === item.correct);
                if (eIsCorrect) {
                    eOptsHtml += '<div style="padding:5px 10px;margin:3px 0;background:#e8f5e9;border-left:4px solid #28a745;border-radius:0 4px 4px 0;font-weight:700;color:#1e3a2f;">'
                        + eLetter + '. ' + parseKaeriMarkdown(eOpts[j])
                        + ' <span style="color:#28a745;">✓</span></div>';
                } else {
                    eOptsHtml += '<div style="padding:5px 10px;margin:3px 0;color:#444;">'
                        + eLetter + '. ' + parseKaeriMarkdown(eOpts[j]) + '</div>';
                }
            }
            eOptsHtml += '</div>';
            qText += eOptsHtml;
            ansHtml = '<strong>Answer:</strong> ' + String.fromCharCode(65 + item.correct);
            explHtml = parseKaeriMarkdown(item.explanation || 'No additional explanation.');
        } else { // flashcard
            qText = parseKaeriMarkdown(item.front || '');
            ansHtml = parseKaeriMarkdown(item.back || '');
            explHtml = '';
        }

        card.innerHTML = \`
            <div class="q-head" style="color:\${pal.acc}">\${secName} · Item \${idx+1}</div>
            <div class="q-text">\${qText}</div>
            <div class="ans" style="border-left-color:\${pal.acc}">\${ansHtml}</div>
            \${explHtml ? '<div class="expl" style="border-left-color:\${pal.acc}"><span class="expl-label" style="color:\${pal.acc}">📖 Explanation</span> ' + explHtml + '</div>' : ''}
        \`;
        return card;
    }

    function build() {
        let state = newPage();
        for (let sec of sectionsData) {
            const banner = document.createElement('div');
            banner.className = 'topic-banner';
            banner.style.backgroundColor = sec.pal.bg;
            banner.style.color = sec.pal.acc;
            banner.style.borderLeftColor = sec.pal.acc;
            banner.innerHTML = (sec.parent ? '<div style="font-size:9px;font-weight:700;letter-spacing:0.5px;opacity:0.85;margin-bottom:2px;">MAIN TOPIC · ' + sec.parent.toUpperCase() + '</div>' : '')
                             + '<div class="banner-text">SECTION ' + sec.num + ': ' + sec.name.toUpperCase() + '</div>';
            state = place(banner, state, 0);
            sec.items.forEach((item, idx) => {
                const card = createCard(item, sec.parent ? sec.parent + ' › ' + sec.name : sec.name, idx, sec.pal);
                state = place(card, state, 10);
            });
        }
    }

    function renderMathAndPrint() {
        if (typeof renderMathInElement !== 'undefined') {
            renderMathInElement(document.body, {
                delimiters: [
                    {left: '$$', right: '$$', display: true},
                    {left: '$', right: '$', display: false},
                    {left: '\\\\(', right: '\\\\)', display: false},
                    {left: '\\\\[', right: '\\\\]', display: true}
                ],
                throwOnError: false
            });
        }
        setTimeout(() => {
            const loading = document.getElementById('kaeri-loading');
            if (loading) loading.style.display = 'none';
            if (sb.parentNode) sb.parentNode.removeChild(sb);
            requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
        }, 200);
    }

    let timeoutId = setTimeout(() => {
        console.warn('Font loading timeout – forcing print');
        renderMathAndPrint();
    }, 3000);

    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            clearTimeout(timeoutId);
            build();
            renderMathAndPrint();
        }).catch(err => {
            console.warn(err);
            clearTimeout(timeoutId);
            build();
            renderMathAndPrint();
        });
    } else {
        window.addEventListener('load', () => {
            clearTimeout(timeoutId);
            build();
            renderMathAndPrint();
        });
    }
})();
</script>
</body>
</html>`;
}

    // ============================================================
// === 10. UTILITIES ===
// === v1.1 PATCH: + _escAttr (JS-string escape) + shuffleQuestionOptions (orderMatters) ===
// === v1.6 PATCH: + naturalSort for correct numeric unit/sub-topic ordering ===
// ============================================================

function filterDataByCourseAndTerm(data, course, term) {
    if (!Array.isArray(data)) return [];
    return data.filter(item => item.course === course && item.term === term);
}

function filterFlashcardsByCourseAndTerm(all, course, term) {
    const filtered = {};
    for (const topic in all) {
        if (all.hasOwnProperty(topic)) {
            const cards = all[topic].filter(card => card.course === course && card.term === term);
            if (cards.length > 0) filtered[topic] = cards;
        }
    }
    return filtered;
}

function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

// Escape for JS-string context (inline onclick attributes).
// Distinct from escapeHtml() which is for HTML-entity context.
function _escAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Natural sort helper: Fixes the "Unit 10" appearing before "Unit 6" issue.
// Compares strings numerically so 2 comes before 10.
function naturalSort(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Shuffle a question's answer options, honouring the question's authorial intent.
//   orderMatters === 'sequential'               → keep options in author order
//   orderMatters === 'all-of-the-above'         → shuffle distractors, keep last option last
//   orderMatters === 'both-a-and-b'             → same as above
//   (default)                                    → shuffle all, remap `correct`
function shuffleQuestionOptions(q) {
    if (!Array.isArray(q.options) || q.options.length < 2) return Object.assign({}, q);
    if (q.orderMatters === 'sequential') return Object.assign({}, q);

    if (q.orderMatters === 'all-of-the-above' || q.orderMatters === 'both-a-and-b') {
        const distractors = q.options.slice(0, -1);
        const last        = q.options[q.options.length - 1];
        shuffle(distractors);
        const newOptions  = distractors.concat([last]);
        return Object.assign({}, q, {
            options: newOptions,
            correct: newOptions.indexOf(q.options[q.correct])
        });
    }

    const order = q.options.map(function (_, i) { return i; });
    shuffle(order);
    return Object.assign({}, q, {
        options: order.map(function (i) { return q.options[i]; }),
        correct: order.indexOf(q.correct)
    });
}
// ============================================================
// === 11. TEXT-TO-SPEECH (SMART HUMAN ENGINE) ===
// === v1.5: fixed math reading order, chunked speech (no 15s cut-off),
// ===       voice + speed settings, pause/resume, replay, support checks ===
// ============================================================

const ttsSupported = (typeof window !== 'undefined')
    && ('speechSynthesis' in window)
    && (typeof SpeechSynthesisUtterance !== 'undefined');

// Word commands use (?![A-Za-z]) so "\int" is never caught by "\in", "\to" by "\top", etc.
const ttsMap = [
    // Greek letters / symbols
    { r: /\\infty(?![A-Za-z])/g, s: " infinity " },
    { r: /\\alpha(?![A-Za-z])/g, s: "alpha" }, { r: /\\beta(?![A-Za-z])/g, s: "beta" }, { r: /\\gamma(?![A-Za-z])/g, s: "gamma" },
    { r: /\\theta(?![A-Za-z])/g, s: "theta" }, { r: /\\lambda(?![A-Za-z])/g, s: "lambda" }, { r: /\\pi(?![A-Za-z])/g, s: "pi" },
    { r: /\\Delta(?![A-Za-z])/g, s: "Delta" }, { r: /\\delta(?![A-Za-z])/g, s: "delta" }, { r: /\\mu(?![A-Za-z])/g, s: "mew" },
    { r: /\\sigma(?![A-Za-z])/g, s: "sigma" }, { r: /\\omega(?![A-Za-z])/g, s: "omega" }, { r: /\\Omega(?![A-Za-z])/g, s: "Omega" },
    // Logic / sets  (\int MUST come before \in)
    { r: /\\therefore(?![A-Za-z])/g, s: "therefore" }, { r: /\\exists(?![A-Za-z])/g, s: "there exists" },
    { r: /\\forall(?![A-Za-z])/g, s: "for all" },
    { r: /\\int(?![A-Za-z])/g, s: "the integral of" },
    { r: /\\in(?![A-Za-z])/g, s: "is an element of" },
    { r: /\\cup(?![A-Za-z])/g, s: "union" }, { r: /\\cap(?![A-Za-z])/g, s: "intersection" },
    // Functions / calculus
    { r: /\\sin(?![A-Za-z])/g, s: "sine" }, { r: /\\cos(?![A-Za-z])/g, s: "cosine" }, { r: /\\tan(?![A-Za-z])/g, s: "tangent" },
    { r: /\\ln(?![A-Za-z])/g, s: "natural log" }, { r: /\\log(?![A-Za-z])/g, s: "log" },
    { r: /\\sum(?![A-Za-z])/g, s: "the sum of" },
    { r: /dy\/dx/g, s: "d y d x" }, { r: /\\lim(?![A-Za-z])/g, s: "the limit" },
    { r: /\\rightarrow(?![A-Za-z])/g, s: "approaches" }, { r: /\\to(?![A-Za-z])/g, s: "approaches" },
    { r: /\\Rightarrow(?![A-Za-z])/g, s: "implies" }, { r: /\\leftrightarrow(?![A-Za-z])/g, s: "if and only if" },
    // Fractions / powers / roots
    { r: /\\frac\{1\}\{2\}/g, s: "one half" },
    { r: /\\frac\{(.+?)\}\{(.+?)\}/g, s: "$1 over $2" },
    { r: /\^2(?![0-9])/g, s: " squared" }, { r: /\^3(?![0-9])/g, s: " cubed" },
    { r: /\^\{(.+?)\}/g, s: " to the power of $1" },
    { r: /\\sqrt\{(.+?)\}/g, s: "the square root of $1" },
    { r: /\\vec\{(.+?)\}/g, s: "vector $1" },
    // Comparisons / operators
    { r: /\\approx(?![A-Za-z])/g, s: "is approximately" }, { r: /\\neq(?![A-Za-z])/g, s: "is not equal to" },
    { r: /\\leq?(?![A-Za-z])/g, s: "less than or equal to" }, { r: /\\geq?(?![A-Za-z])/g, s: "greater than or equal to" },
    { r: /\\times(?![A-Za-z])/g, s: "times" }, { r: /\\div(?![A-Za-z])/g, s: "divided by" }, { r: /\\cdot(?![A-Za-z])/g, s: "dot" },
    { r: /\\pm(?![A-Za-z])/g, s: "plus or minus" }, { r: /\\circ(?![A-Za-z])/g, s: " degrees" },
    // Chemistry / text wrappers
    { r: /\\ce\{(.+?)\}/g, s: "$1" }, { r: /->/g, s: " yields " },
    { r: /\\text\{(.+?)\}/g, s: "$1" }, { r: /\\mathrm\{(.+?)\}/g, s: "$1" },
    // Markdown clean-up
    { r: /\*\*/g, s: "" }, { r: /__/g, s: "" }, { r: /^#+\s*/gm, s: "" }, { r: /^>\s?/gm, s: "" },
    // Subscripts (after "__" is removed)
    { r: /_\{(.+?)\}/g, s: " sub $1" }, { r: /_([A-Za-z0-9])/g, s: " sub $1" },
    // Plain-text maths symbols
    { r: /\s>\s/g, s: " is greater than " }, { r: /\s<\s/g, s: " is less than " },
    { r: /≤/g, s: " less than or equal to " }, { r: /≥/g, s: " greater than or equal to " },
    { r: /≠/g, s: " is not equal to " }, { r: /≈/g, s: " is approximately " },
    { r: /×/g, s: " times " }, { r: /÷/g, s: " divided by " }, { r: /→/g, s: " yields " },
    { r: /±/g, s: " plus or minus " }, { r: /√/g, s: " square root of " }, { r: /∞/g, s: " infinity " },
    { r: /°C/g, s: " degrees Celsius" }, { r: /°/g, s: " degrees" }, { r: /%/g, s: " percent" },
    // Whatever LaTeX is left
    { r: /\$\$/g, s: "" }, { r: /\$/g, s: "" }, { r: /\\/g, s: "" }
];

function humanizeLaTeX(text) {
    let cleanText = kaeriConvertTables(String(text == null ? '' : text), null, true)   // tables → spoken rows

        // Paragraph/line breaks become real newlines first, so markdown headings ("## Title") are still
        // recognised by the clean-up rules in ttsMap. They turn into spoken pauses further below.
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|h[1-6])\s*>/gi, '\n')
        .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')          // Other HTML tags
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    ttsMap.forEach(map => { cleanText = cleanText.replace(map.r, map.s); });
    return cleanText
        // Each break (single or repeated) becomes ONE full stop, unless the line already ends in punctuation.
        // A paragraph break (blank line / double <br>, e.g. after a heading) also adds a hidden \u00b6 marker
        // that _speakNext turns into a longer pause. The marker is stripped before anything is spoken.
        .replace(/([.!?\u2026:;,])?[ \t]*\n\s*/g, function (m, p) {
            if ((m.match(/\n/g) || []).length >= 2) return (p && /[.!?\u2026]/.test(p) ? p : '.') + '\u00b6 ';
            return p ? p + ' ' : '. ';
        })
        // Never leave doubled sentence punctuation behind (". .", "?.", etc.)
        .replace(/([.!?\u2026])(?:\s*[.!?\u2026])+/g, '$1')
        .replace(/\s+/g, ' ').trim();
}

// ---------- Reader state ----------
let ttsRate = (function () {
    const v = parseFloat(localStorage.getItem('kaeri_tts_rate'));
    return (isFinite(v) && v >= 0.5 && v <= 2) ? v : 1;
})();
let ttsVoiceURI = localStorage.getItem('kaeri_tts_voice') || '';
let ttsVoices = [];
let ttsSession = 0;          // bumped on every stop so stale callbacks do nothing
let ttsQueue = [];           // chunks still to speak
let ttsCurrentChunk = '';
let ttsSpeaking = false;
let ttsPaused = false;
let ttsLastText = '';
let ttsOnFinish = null;      // one-shot callback: fires when the queue empties naturally (used by the document reader)
let utterance = null;

function _loadVoices() {
    if (!ttsSupported) return;
    try { ttsVoices = window.speechSynthesis.getVoices() || []; } catch (e) { ttsVoices = []; }
}
if (ttsSupported) {
    _loadVoices();
    try {
        window.speechSynthesis.addEventListener('voiceschanged', function () {
            _loadVoices();
            _fillTtsVoiceList();
        });
    } catch (e) {}
} else {
    document.documentElement.classList.add('no-tts');
}

/** Saved voice, else the best English voice on the device (Zambian > South African > British > US > any English). */
function ttsPickVoice() {
    if (!ttsVoices.length) return null;
    if (ttsVoiceURI) {
        const saved = ttsVoices.find(v => v.voiceURI === ttsVoiceURI);
        if (saved) return saved;
    }
    const norm = v => String(v.lang || '').replace('_', '-').toLowerCase();
    const order = ['en-zm', 'en-za', 'en-gb', 'en-us'];
    for (let i = 0; i < order.length; i++) {
        const hit = ttsVoices.find(v => norm(v) === order[i]);
        if (hit) return hit;
    }
    return ttsVoices.find(v => /^en/.test(norm(v))) || null;
}

/** Break text into short, natural chunks. Chrome silently stops utterances that run past ~15 seconds. */
function splitForSpeech(text) {
    const MAX = 200;
    const pieces = String(text).match(/[^.!?…]+[.!?…]*\s*/g) || [String(text)];
    const chunks = [];
    let cur = '';
    const push = s => { s = s.trim(); if (s) chunks.push(s); };
    pieces.forEach(p => {
        if (p.length > MAX) {
            push(cur); cur = '';
            let rest = p;
            while (rest.length > MAX) {
                let cut = rest.lastIndexOf(',', MAX);
                if (cut < 60) cut = rest.lastIndexOf(' ', MAX);
                if (cut < 20) cut = MAX;
                push(rest.slice(0, cut + 1));
                rest = rest.slice(cut + 1);
            }
            cur = rest;
        } else if ((cur + p).length > MAX) {
            push(cur); cur = p;
        } else {
            cur += p;
        }
    });
    push(cur);
    return chunks;
}

function _speakNext(session) {
    if (session !== ttsSession) return;
    if (!ttsQueue.length) {
        ttsSpeaking = false; ttsCurrentChunk = ''; utterance = null;
        const _fin = ttsOnFinish; ttsOnFinish = null;
        _syncStripTts();
        if (typeof _fin === 'function') { try { _fin(); } catch (e) {} }
        return;
    }

    // Queue chunks can hold several sentences. Speak one sentence at a time so the pause
    // after each full stop / question mark actually happens; the rest go back to the queue front.
    let chunk = ttsQueue.shift();
    const parts = chunk.match(/.+?(?:[.!?\u2026]+\u00b6?(?=\s|$)|$)/g);
    if (parts && parts.length > 1) {
        const sentences = parts.map(function (x) { return x.trim(); }).filter(Boolean);
        if (sentences.length > 1) {
            chunk = sentences.shift();
            ttsQueue = sentences.concat(ttsQueue);
        }
    }
    // \u00b6 = paragraph/heading boundary marker from humanizeLaTeX: remember it, never speak it
    const paraBreak = chunk.indexOf('\u00b6') !== -1;
    chunk = chunk.replace(/\u00b6/g, '').trim();
    if (!chunk) { _speakNext(session); return; }
    ttsCurrentChunk = chunk;

    const u = new SpeechSynthesisUtterance(chunk);
    const v = ttsPickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-GB'; }

    // --- AUTO-ADJUSTING RHYTHM & TONE ---
    let rateMultiplier = 1.0;
    let pitchMultiplier = 1.0;

    // 1. Math-heavy? Only real operators / spoken-math words count, never plain numbers, hyphens or "and/or".
    const isMath = /\d\s*[=+*^\u00d7\u00f7]\s*[\d(A-Za-z]|[A-Za-z)]\s*=\s*[\d(A-Za-z-]|\d\s+-\s+\d|\d\/\d|\b(squared|cubed|square root|to the power of|the integral of|the sum of)\b|\bsub [A-Za-z0-9]\b|\\(frac|sqrt|times|div)/.test(chunk);
    if (isMath) {
        rateMultiplier = 0.8;    // 20% slower
        pitchMultiplier = 0.95;  // slightly deeper
    }

    // 2. Question (ends in ?)
    if (/\?\s*$/.test(chunk)) {
        rateMultiplier *= 0.95;
        pitchMultiplier = 1.05;
    }

    // 3. ALL-CAPS emphasis
    if (/\b[A-Z]{4,}\b/.test(chunk)) {
        pitchMultiplier = 1.1;
        rateMultiplier *= 0.9;
    }

    u.rate = Math.min(10, Math.max(0.1, ttsRate * rateMultiplier));
    u.pitch = pitchMultiplier;

    // --- NATURAL PAUSING (one advance per utterance, even if both onend and onerror fire) ---
    let advanced = false;
    function advance(pauseTime) {
        if (advanced) return;
        advanced = true;
        ttsCurrentChunk = '';   // finished: pausing during the gap must not replay this chunk
        if (!ttsQueue.length) { _speakNext(session); return; }   // nothing left: finish straight away
        setTimeout(function () { _speakNext(session); }, pauseTime);
    }

    u.onend = function () {
        if (session !== ttsSession) return;
        const lastChar = chunk.trim().slice(-1);
        let pauseTime = 100;
        if (isMath) {
            pauseTime = 700;     // let the maths sink in
        } else if (/[.!?\u2026]/.test(lastChar)) {
            pauseTime = 500;     // full-stop breathing room
        } else if (/[,;:]/.test(lastChar)) {
            pauseTime = 250;     // quick breath
        }
        if (paraBreak) pauseTime = Math.max(pauseTime, 900);   // heading -> body, paragraph -> paragraph
        advance(pauseTime);
    };
    u.onerror = function (e) {
        if (e && (e.error === 'canceled' || e.error === 'interrupted')) return;
        if (session !== ttsSession) return;
        advance(100);
    };

    utterance = u;
    ttsSpeaking = true;
    _syncStripTts();
    try { window.speechSynthesis.speak(u); } catch (e) { ttsSpeaking = false; _syncStripTts(); }
}

function stopReading() {
    ttsSession++;
    ttsQueue = [];
    ttsCurrentChunk = '';
    ttsSpeaking = false;
    ttsPaused = false;
    utterance = null;
    ttsOnFinish = null;
    if (ttsSupported) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    _syncStripTts();
    if (typeof _docReaderOnStop === 'function') _docReaderOnStop();
}

/** Speak text. opts.force = speak even if the reader is switched off (explicit Replay / Test taps). */
function readText(text, opts) {
    opts = opts || {};
    if (!ttsSupported) return;
    if (!ttsEnabled && !opts.force) return;
    const clean = humanizeLaTeX(text);
    if (!clean) return;
    stopReading();
    ttsLastText = clean;
    ttsQueue = splitForSpeech(clean);
    const session = ttsSession;
    // Small gap after cancel(): some Android builds drop speech started in the same tick.
    setTimeout(function () { _speakNext(session); }, 60);
}

/** Pause/resume that works on every browser (Android's native pause() is unreliable): stop, remember, continue later. */
function toggleReadPause() {
    if (!ttsSupported) return;
    if (ttsPaused) {
        ttsPaused = false;
        const resume = ttsQueue.slice();
        ttsSession++;
        ttsQueue = resume;
        const session = ttsSession;
        _syncStripTts();
        _speakNext(session);
        return;
    }
    if (ttsSpeaking) {
        const remaining = [ttsCurrentChunk].concat(ttsQueue).filter(Boolean);
        ttsSession++;
        try { window.speechSynthesis.cancel(); } catch (e) {}
        ttsQueue = remaining;
        ttsSpeaking = false;
        ttsPaused = true;
        _syncStripTts();
        return;
    }
    replayReading();
}

function updateTtsButtonText() {
    const ttsButton = document.getElementById('tts-toggle-button');
    if (ttsButton) ttsButton.textContent = ttsEnabled ? '🔊 Turn Reader Off' : '🔇 Turn Reader On';
}

function toggleTTS() {
    if (!ttsSupported) {
        showAppNotification("🔇 This browser can't read aloud. Try Chrome or Safari.", "warning", 3500);
        return;
    }
    ttsEnabled = !ttsEnabled;
    localStorage.setItem("ttsEnabled", ttsEnabled);
    stopReading();
    updateTtsButtonText();
    showAppNotification(ttsEnabled ? "🔊 Reader is now ON." : "🔇 Reader is now OFF.");
    logAnalyticsEvent('tts_toggle', ttsEnabled ? 'ON' : 'OFF');
    // Speaking right after the tap also unlocks audio on iPhones.
    if (ttsEnabled) readText('Reader is on.', { force: true });
}

/** The text for whatever is on screen right now (question, essay step or flashcard). '' if nothing. */
function buildCurrentReadText() {
    let textToRead = "";
    if ((currentQuizType === 'mcq' || currentQuizType === 'shortAnswer') && currentQuizData && currentQuizData[currentQuestionIndex]) {
        const qData = currentQuizData[currentQuestionIndex];
        textToRead += "Question " + (currentQuestionIndex + 1) + ". " + humanizeLaTeX(qData.q) + ". ";
        if (qData.options) {
            textToRead += "Here are the options. ";
            qData.options.forEach((opt, i) => {
                // "Option A: text." keeps the letter attached to its answer and ends every option on a full stop (500ms gap)
                textToRead += "Option " + String.fromCharCode(65 + i) + ": " + humanizeLaTeX(opt) + ". ";
            });
        }
    } else if (currentQuizType === 'essay' && currentEssay && currentEssay.steps && currentEssay.steps[currentStepIndex]) {
        const step = currentEssay.steps[currentStepIndex];
        textToRead += "Step " + (currentStepIndex + 1) + ". " + humanizeLaTeX(step.q) + ". ";
        (step.options || []).forEach((opt, i) => {
            textToRead += "Option " + String.fromCharCode(65 + i) + ": " + humanizeLaTeX(opt) + ". ";
        });
    } else if (currentQuizType === 'flashcard' && currentFlashcards && currentFlashcards[currentCardIndex]) {
        const card = currentFlashcards[currentCardIndex];
        textToRead = isCardFront ? "Front: " + humanizeLaTeX(card.front) : "Back: " + humanizeLaTeX(card.back);
    }
    return textToRead;
}

function readCurrentQuestion() {
    if (!ttsEnabled) return;
    const t = buildCurrentReadText();
    if (t) readText(t);
}

function readFlashcard() {
    if (!ttsEnabled) return;
    const card = currentFlashcards[currentCardIndex];
    if (!card) return;
    readText(isCardFront ? "Front: " + humanizeLaTeX(card.front) : "Back: " + humanizeLaTeX(card.back));
}

/** 🔁 Replay: re-reads the current question/card, even when the reader is switched off. */
function replayReading() {
    if (!ttsSupported) {
        showAppNotification("🔇 This browser can't read aloud. Try Chrome or Safari.", "warning", 3500);
        return;
    }
    const t = buildCurrentReadText() || ttsLastText;
    if (!t) { showAppNotification('Nothing to read yet. Open a question first.', 'info', 2200); return; }
    readText(t, { force: true });
}

// ---------- Reader settings (voice + speed) ----------
function _fillTtsVoiceList() {
    const sel = document.getElementById('tts-voice');
    if (!sel) return;
    sel.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = 'Automatic (best English voice)';
    sel.appendChild(auto);
    const norm = v => String(v.lang || '').replace('_', '-');
    const english = ttsVoices.filter(v => /^en/i.test(norm(v)));
    (english.length ? english : ttsVoices).forEach(v => {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = v.name + ' (' + norm(v) + ')';
        sel.appendChild(o);
    });
    sel.value = ttsVoiceURI && Array.prototype.some.call(sel.options, o => o.value === ttsVoiceURI) ? ttsVoiceURI : '';
}

function _syncTtsSettings() {
    const r = document.getElementById('tts-rate');
    if (r) r.value = ttsRate;
    const l = document.getElementById('tts-rate-label');
    if (l) l.textContent = ttsRate.toFixed(1).replace(/\.0$/, '') + '×';
    const on = document.getElementById('tts-on');
    if (on) on.checked = !!ttsEnabled;
}

function openTtsSettings() {
    if (!ttsSupported) {
        showAppNotification("🔇 This browser can't read aloud. Try Chrome or Safari.", "warning", 3500);
        return;
    }
    _loadVoices();
    _fillTtsVoiceList();
    _syncTtsSettings();
    openOverlay(document.getElementById('tts-modal'));
}

function closeTtsSettings() {
    closeOverlay(document.getElementById('tts-modal'));
    stopReading();
}

function setTtsRate(v) {
    const n = parseFloat(v);
    if (!isFinite(n)) return;
    ttsRate = Math.min(2, Math.max(0.5, n));
    localStorage.setItem('kaeri_tts_rate', String(ttsRate));
    _syncTtsSettings();
}

function setTtsVoice(uri) {
    ttsVoiceURI = uri || '';
    localStorage.setItem('kaeri_tts_voice', ttsVoiceURI);
}

function testTtsVoice() {
    readText('Hello! This is how the reader will sound while you study.', { force: true });
}

// Never keep talking after the student leaves the tab or page.
document.addEventListener('visibilitychange', function () { if (document.hidden) stopReading(); });
window.addEventListener('pagehide', function () { stopReading(); });


// ============================================================
// === 12. GLOBAL EVENT HANDLERS & STUDENT BOARD ===
// === v1.1 PATCH: + beforeunload guard; keyboard "next" prefers shell bar ===
// === v1.2 PATCH: + call hideUnavailableTerms() at boot ===
// ============================================================

function renderStudentBoard() {
    const board = document.getElementById('student-board');
    const annContainer = document.getElementById('board-announcements');
    const motContainer = document.getElementById('board-motivation');
    
    if (!board || !annContainer || !motContainer) return;

    const today = new Date();
    let validAnnouncements = (typeof announcements !== 'undefined' ? announcements : []).filter(item => {
        return item.active && (!item.expiry || new Date(item.expiry) >= today);
    });
    let validMotivation = typeof motivation !== 'undefined' ? motivation : [];

    const hasNews = validAnnouncements.length > 0;
    const hasQuote = validMotivation.length > 0;

    if (!hasNews && !hasQuote) {
        board.style.display = 'none';
        return;
    }

    board.style.display = 'grid';
    board.classList.remove('layout-full-width');

    if (hasNews) {
        const item = validAnnouncements[0];
        annContainer.style.display = 'flex';
        annContainer.className = `board-section type-${item.type || 'info'}`;
        
        let icon = '📢';
        if (item.type === 'warning') icon = '⚠️';
        if (item.type === 'critical') icon = '🔴';
        if (item.type === 'success') icon = '🎉';

        annContainer.innerHTML = `
            <div class="board-announcement-title">
                <span>${icon}</span> ${item.title}
            </div>
            <div class="board-announcement-body">${parseKaeriMarkdown(item.body)}</div>
        `;
    } else {
        annContainer.style.display = 'none';
    }

    if (hasQuote) {
        const randomQuote = validMotivation[Math.floor(Math.random() * validMotivation.length)];
        motContainer.style.display = 'flex';
        motContainer.className = 'board-section board-motivation-box';
        motContainer.innerHTML = `
            <div class="quote-wrapper">
                <span class="quote-icon">💡</span>
                <span class="quote-content">"${randomQuote}"</span>
            </div>
        `;
    } else {
        motContainer.style.display = 'none';
    }

    if ((hasNews && !hasQuote) || (!hasNews && hasQuote)) {
        board.classList.add('layout-full-width');
    }
}

// ── KEYBOARD SHORTCUTS ──────────────────────────────────────
//  Global        U ............ unlock (free users)      Esc ........ close modal, else back one screen
//  MCQ / Essay   1-4 / A-D .... pick option              ↑ ↓ ← → .... move selection
//                Enter ........ submit, then Next        Space / N .. Next
//  Short answer  Enter ........ submit (Shift+Enter = new line)
//  Pickers       1-9 .......... open the Nth button in a topic list
//                A / N ........ All / None  (MCQ pickers only)
//                Enter ........ Continue / Start  (MCQ pickers only)
//                Backspace / B  Back one level  (Flashcard pickers)
//  Flashcards    Mode screen: 1 = Standard, 2 = SRS
//                Session: Space / Enter = flip, ← → (standard), 1-4 rate (SRS, answer shown)
function _isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return true;
    if (tag === 'INPUT') {
        const type = (t.getAttribute('type') || 'text').toLowerCase();
        return !['radio', 'checkbox', 'button', 'submit', 'reset'].includes(type);
    }
    return false;
}

// Click the active "Next" button (shell action bar first, then the result area)
function _clickNextButton() {
    const shellBtns = document.querySelectorAll(".shell-actions button");
    const nextBtn = shellBtns.length
        ? shellBtns[shellBtns.length - 1]
        : document.querySelector("#result button");
    if (nextBtn) nextBtn.click();
}

// Is any modal / overlay currently open? (Escape should close it, not navigate)
function _anyModalOpen() {
    const pay   = document.getElementById('payment-modal');
    const print = document.getElementById('print-preview-modal');
    const doc   = document.getElementById('smart-doc-viewer');
    return !!(
        (pay   && pay.classList.contains('show'))   ||
        (print && print.classList.contains('show')) ||
        (doc   && doc.style.display && doc.style.display !== 'none') ||
        document.querySelector('.r-modal.show')     ||
        (typeof overlayStack !== 'undefined' && overlayStack.length > 0)
    );
}

// Escape = one step back on the current screen (exitQuiz still confirms mid-quiz)
function _handleEscapeBack(e) {
    if (!currentQuizType) return;
    const qf = document.getElementById('quiz-form');
    if (!qf || !qf.childNodes.length) return;          // nothing on screen → nothing to leave

    switch (currentQuizType) {
        case 'mcq': case 'shortAnswer': case 'essay':
        case 'mcqMenu': case 'essayMenu': case 'dashboard': case 'documents': case 'videos':
            e.preventDefault(); exitQuiz(); return;
        case 'mcqDemoUnit':
            e.preventDefault(); exitQuiz(); return;
        case 'mcqDemoSub':
            e.preventDefault();
            if (Object.keys(buildMcqTopicIndex(currentMcqData)).length > 1) renderDemoUnitPicker();
            else exitQuiz();
            return;
        case 'mcqSubMenu': case 'mcqSetup':
            e.preventDefault(); mcqSubBack(); return;
        case 'flashcard': {
            e.preventDefault();
            if (qf.querySelector('.flashcard') || qf.querySelector('.back-to-topics-button')) { exitQuiz(); return; }
            const back = qf.querySelector('.back-button');   // mode screen (Cancel) or "All topics"
            if (back) back.click(); else exitQuiz();         // top-level picker → leave
            return;
        }
    }
}

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;   // never hijack browser shortcuts

    const typing = _isTypingTarget(e.target);

    if (e.key === "Escape") {
        const maxed = document.querySelector('.kv-wrap.kv-max');
        if (maxed) { const fb = maxed.querySelector('[data-k="fs"]'); if (fb) fb.click(); return; }
        const modalWasOpen = _anyModalOpen();
        closePaymentModal();
        closePrintPreview();
        closeDocViewer();
        if (!modalWasOpen) _handleEscapeBack(e);
        return;
    }

    // Short answer: Enter submits even from inside the textarea; once answered, Enter moves on
    if (currentQuizType === "shortAnswer" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (e.repeat) return;
        if (isSubmissionLocked) {
            if (!document.getElementById('final-anchor')) _clickNextButton();
        } else {
            checkShortAnswer();
        }
        return;
    }

    // Enter submits the modal inputs that have a submit button next to them
    if (e.key === "Enter" && !e.shiftKey && e.target && e.target.id) {
        const submitters = {
            'access-code-input': verifyCodeFromModal,
            'checkEmail':        checkHistory,
            'referral-email':    submitAmbassadorReferral
        };
        const fn = submitters[e.target.id];
        if (fn) { e.preventDefault(); if (!e.repeat) fn(); return; }
    }

    // Everything below must not fire while the student is typing in a field
    if (typing) return;

    if ((e.key === 'u' || e.key === 'U') && currentCourse && !hasFullAccess) {
        e.preventDefault();
        openPaymentModal();
        return;
    }

    if (!currentQuizType) return;

    // --- SHORT ANSWER (after submit): Space / N → Next, like MCQ ---
    if (currentQuizType === "shortAnswer") {
        if (isSubmissionLocked && (e.key === " " || e.key === "n" || e.key === "N")
            && !document.getElementById('final-anchor')) {
            e.preventDefault();
            if (!e.repeat) _clickNextButton();
        }
        return;
    }

    // --- MCQ / ESSAY ---
    if (currentQuizType === "mcq" || currentQuizType === "essay") {
        const options = document.querySelectorAll('input[type="radio"]:not(:disabled)');   // locked after submit
        const selected = document.querySelector('input[type="radio"]:not(:disabled):checked');
        let index = Array.from(options).indexOf(selected);

        const goNext = _clickNextButton;

        switch (e.key) {
            case "ArrowDown": case "ArrowRight":
                if (options.length) { e.preventDefault(); index = (index + 1) % options.length; options[index].checked = true; } break;
            case "ArrowUp": case "ArrowLeft":
                if (options.length) { e.preventDefault(); index = (index - 1 + options.length) % options.length; options[index].checked = true; } break;
            case "1": case "a": case "A": if (options[0]) options[0].checked = true; break;
            case "2": case "b": case "B": if (options[1]) options[1].checked = true; break;
            case "3": case "c": case "C": if (options[2]) options[2].checked = true; break;
            case "4": case "d": case "D": if (options[3]) options[3].checked = true; break;
            case "Enter":
                e.preventDefault();
                if (options.length) {                       // question still open → submit
                    if (currentQuizType === "mcq") checkMcqAnswer();
                    if (currentQuizType === "essay") checkEssayStep();
                } else {                                    // already answered → Next
                    goNext();
                }
                break;
            case " ": case "n": case "N":
                e.preventDefault();
                goNext();
                break;
        }
        return;
    }

    // --- FLASHCARDS (session, mode screen, pickers) ---
    if (currentQuizType === "flashcard") {
        const inSession = !!document.querySelector('#quiz-form .flashcard');
        if (inSession) {
            if (e.key === " " || e.key === "Enter") {
                e.preventDefault();                                   // stop scrolling / button double-fire
                if (isCardFront) flipCard();
                else if (currentFlashcardMode === 'linear') flipCard(); // flip back in linear
            }
            if (currentFlashcardMode === 'linear') {
                if (e.key === "ArrowLeft") prevFlashcard();
                if (e.key === "ArrowRight") nextFlashcard();
            } else if (!isCardFront) {
                if (e.key === "1") rateCard(0);
                if (e.key === "2") rateCard(3);
                if (e.key === "3") rateCard(4);
                if (e.key === "4") rateCard(5);
            }
            return;
        }
        // Pickers and mode screen: Backspace / B → one level back (Cancel / All topics)
        if (e.key === "Backspace" || e.key === "b" || e.key === "B") {
            const backBtn = document.querySelector('#quiz-form .back-button');
            if (backBtn) { e.preventDefault(); if (!e.repeat) backBtn.click(); }
            return;
        }
        // Mode-selection screen: 1 = Standard, 2 = SRS
        const modeBtns = document.querySelectorAll('#quiz-form button[onclick^="startFlashcards("]');
        if (modeBtns.length) {
            if (e.repeat) return;
            if (e.key === "1" && modeBtns[0]) modeBtns[0].click();
            if (e.key === "2" && modeBtns[1]) modeBtns[1].click();
            return;
        }
    }

    // --- MCQ DEMO / PAID SCREENS ---------------------------------
    // 1-9 pick/toggle the Nth row · A = all · N = none · Enter = continue/start
    if (currentQuizType === "mcqDemoUnit" || currentQuizType === "mcqDemoSub"
        || currentQuizType === "mcqMenu"  || currentQuizType === "mcqSubMenu"
        || currentQuizType === "mcqSetup") {
        if (e.repeat) return;
        const rowSel = {
            mcqDemoUnit: '.demo-mcq-unit-row',
            mcqDemoSub:  '.demo-mcq-sub-row',
            mcqMenu:     '.mcq-unit-row',
            mcqSubMenu:  '.mcq-sub-row'
        }[currentQuizType];

        if (rowSel && /^[1-9]$/.test(e.key)) {
            const row = document.querySelectorAll(rowSel)[parseInt(e.key, 10) - 1];
            if (row) {
                e.preventDefault();
                const cb = row.querySelector('input[type=checkbox]');
                if (cb) cb.click(); else row.click();
            }
            return;
        }
        const k = e.key.toLowerCase();
        if (currentQuizType === "mcqDemoSub") {
            if (k === 'a') { e.preventDefault(); demoSelectAllSubs(true);  return; }
            if (k === 'n') { e.preventDefault(); demoSelectAllSubs(false); return; }
            if (e.key === "Enter") {
                const btn = document.getElementById('demo-mcq-start');
                if (btn && !btn.disabled) { e.preventDefault(); startDemoSubTopicMcq(); }
                return;
            }
        } else if (currentQuizType === "mcqMenu") {
            if (k === 'a') { e.preventDefault(); mcqMenuSelectAllUnits(true);  return; }
            if (k === 'n') { e.preventDefault(); mcqMenuSelectAllUnits(false); return; }
            if (e.key === "Enter") { e.preventDefault(); mcqMenuContinue(); return; }
        } else if (currentQuizType === "mcqSubMenu") {
            const unit = mcqSetupState.orderedUnits[mcqSetupState.subScreenIndex];
            if (k === 'a') { e.preventDefault(); mcqSubSelectAll(unit, true);  return; }
            if (k === 'n') { e.preventDefault(); mcqSubSelectAll(unit, false); return; }
            if (e.key === "Enter") { e.preventDefault(); mcqSubContinue(); return; }
        } else if (currentQuizType === "mcqSetup") {
            if (e.key === "Enter") { e.preventDefault(); startSelectedMcq(); return; }
        }
        return;
    }

    // --- TOPIC / ESSAY PICKERS: 1-9 opens the Nth entry ---
    if (/^[1-9]$/.test(e.key) && !e.repeat) {   // held key must not chain Parent → Subtopic → start
        const pickerBtns = document.querySelectorAll('#quiz-form .flashcard-topic-buttons > button');
        const btn = pickerBtns[parseInt(e.key, 10) - 1];
        if (btn) btn.click();
    }
});

// Guard against accidental refresh while a quiz is in progress.
// Scoped to MCQ / SA / Essay (flashcards don't hold unsaved progress).
window.addEventListener('beforeunload', function (e) {
    let active = false;
    if (currentQuizType === 'mcq' || currentQuizType === 'shortAnswer') {
        active = currentQuizData.length > 0
              && currentQuestionIndex < currentQuizData.length;
    } else if (currentQuizType === 'essay') {
        // Essay advances via currentStepIndex; the final score screen carries #final-anchor.
        active = !!currentEssay && !document.getElementById('final-anchor');
    }
    if (active) {
        e.preventDefault();
        e.returnValue = '';
    }
});

document.addEventListener('DOMContentLoaded', function() {
    // Disable term buttons whose dataset file isn't yet in the manifest.
    hideUnavailableTerms();

    const closeBtn = document.querySelector('.close-print-preview');
    if(closeBtn) closeBtn.addEventListener('click', closePrintPreview);
    
    const modal = document.getElementById('print-preview-modal');
    if(modal) modal.addEventListener('click', function(e) {
        if (e.target === this) closePrintPreview();
    });
    
    const paymentModal = document.getElementById('payment-modal');
    if(paymentModal) paymentModal.addEventListener('click', function(e) {
        if (e.target === this) closePaymentModal();
    });
    
    setTimeout(renderStudentBoard, 100);

    // ============================================================
    // --- NEW: PAYMENT FORM EVENT BINDINGS & GLOBAL EXPORTS ---
    // ============================================================

    // 1. Bind Submit button
    const payBtn = document.getElementById('paySubmitBtn');
    if (payBtn) payBtn.addEventListener('click', handleSubmit);

    // 2. Bind File input change
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.addEventListener('change', function() { handleFile(this); });

    // 3. Bind Course & Term dropdowns
    const courseSelect = document.getElementById('courseSelect');
    const termSelect = document.getElementById('termSelect');
    if (courseSelect) courseSelect.addEventListener('change', updateTerms);
    if (termSelect) termSelect.addEventListener('change', updatePrice);

    // 4. Expose new functions globally so inline onclick attributes work
    window.switchPayTab = switchPayTab;
    window.checkHistory = checkHistory;
    window.copyCode = copyCode;
    window.handleSubmit = handleSubmit;
    window.handleFile = handleFile;
    window.loadCourses = loadCourses;
    window.showAlert = showAlert;
    window.openPaymentModal = openPaymentModal;
    window.closePaymentModal = closePaymentModal;
    window.lipilaCourseChanged = lipilaCourseChanged;
    window.lipilaTermChanged = lipilaTermChanged;

    // 5. CRITICAL: Expose the existing verifyCodeFromModal() so the "Activate Code" button works
    window.verifyCodeFromModal = verifyCodeFromModal;
});

// ============================================================
// === 13. ADDITIONAL CSS FOR PROFESSIONAL VIEWER & SKELETON ===
// ============================================================
(function addStyles() {
    const style = document.createElement('style');
    style.innerHTML = `
        .viewer-loader {
            position: absolute;
            top: 50px; /* below header */
            left: 0;
            width: 100%;
            height: calc(100% - 100px); /* accounting for header + footer */
            background: #1a1a2e;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 10;
        }

        .viewer-skeleton-box {
            width: 80%;
            height: 60%;
            background: linear-gradient(90deg, #2b3a55 25%, #3e506e 50%, #2b3a55 75%);
            background-size: 200% 100%;
            animation: shimmer 1.5s infinite;
            border-radius: 8px;
        }

        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .skeleton {
            height: 180px;
            background: linear-gradient(90deg, #2b3a55 25%, #3e506e 50%, #2b3a55 75%);
            background-size: 200% 100%;
            animation: shimmer 1.5s infinite;
            border-radius: 10px;
        }

        /* ── Print modal preview item styles ── */
        .print-item {
            margin-bottom: 14px;
            padding: 12px 14px;
            border: 1px solid #dde3ea;
            border-left: 5px solid #1a73e8;
            border-radius: 5px;
            background: #ffffff;
            page-break-inside: avoid;
        }
        .print-item.essay  { border-left-color: #e67e00; }
        .print-item.sa     { border-left-color: #b5830f; }
        .print-item.flash  { border-left-color: #6f42c1; }
        .item-label {
            font-size: 0.72em; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.8px;
            color: #1a73e8; margin-bottom: 5px;
        }
        .print-item.essay .item-label { color: #e67e00; }
        .print-item.sa    .item-label { color: #b5830f; }
        .print-item.flash .item-label { color: #6f42c1; }
        .item-q   { font-size: 0.95em; color: #1a1a1a; line-height: 1.5; margin-bottom: 6px; }
        .item-ans { font-size: 0.9em; color: #145a32; background: #eafaf1; padding: 5px 8px; border-radius: 3px; margin-bottom: 5px; font-weight: 600; }
        .item-exp { font-size: 0.87em; color: #444; background: #f7f8fa; padding: 5px 8px; border-radius: 3px; line-height: 1.45; }

        /* ── Fallback: hide app UI if user presses Ctrl+P directly ── */
        @media print {
            body > *:not(#printable-summary) { display: none !important; }
            #printable-summary { display: block !important; }
        }
    `;
    document.head.appendChild(style);
})();

// ============================================================
// === REORGANISATION LAYER (navigation, quiz strip, referral) ===
// === v1.1 PATCH: + URL routing + deep-link restore + backToMenu wrapper ===
// ============================================================

// ---------- URL routing (course + term in query string) ----------
// Sets up deep-linking: ?course=CS110&term=T1 restores the course on load,
// and the browser back button works without needing a UI back handler.
let _suppressNextNavigate = false;

function buildURL(route) {
    const p = new URLSearchParams();
    if (route.course) p.set('course', route.course);
    if (route.term)   p.set('term', route.term);
    const qs = p.toString();
    return qs ? location.pathname + '?' + qs : location.pathname;
}

function parseURL() {
    const p = new URLSearchParams(location.search);
    return {
        course: p.get('course'),
        term:   p.get('term')
    };
}

function navigate(route, opts) {
    opts = opts || {};
    if (_suppressNextNavigate) { _suppressNextNavigate = false; return; }
    const next = Object.assign({}, route);
    try {
        if (opts.replace) history.replaceState(next, '', buildURL(next));
        else             history.pushState(next, '', buildURL(next));
    } catch (e) {}
}

function applyRoute(route) {
    // Topmost overlay absorbs Escape/Back first.
    if (typeof overlayStack !== 'undefined' && overlayStack.length > 0) {
        closeOverlay(overlayStack[overlayStack.length - 1].el);
        return;
    }

    if (!route.course || !route.term) {
        if (getViewedScope().course || currentCourse) { _suppressNextNavigate = true; backToMenu(); }
        return;
    }

    const key = (route.course + '_' + route.term).toUpperCase();
    const viewed = getViewedScope();
    const viewedKey = (viewed.course && viewed.term) ? viewed.course + '_' + viewed.term : '';
    if (key !== viewedKey) {
        _suppressNextNavigate = true;
        loadCourse(route.course, route.term);
    }
}

window.addEventListener('popstate', function (e) {
    const route = e.state || parseURL();
    applyRoute(route);
});

// Wrap backToMenu so every exit clears the MCQ wizard state.
// (loadCourse already suppresses an extra history push via _suppressNextNavigate.)
(function () {
    const orig = window.backToMenu;
    if (typeof orig !== 'function') return;
    window.backToMenu = function () {
        try { resetMcqWizardState(); } catch (e) {}
        const out = orig.apply(this, arguments);
        try { navigate({}); } catch (e) {}
        return out;
    };
})();

// ---------- Welcome <-> Courses ----------
function _reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function collapseAllTerms() {
    document.querySelectorAll('.term-buttons').forEach(s => {
        s.style.display = 'none';
        if (s.previousElementSibling) s.previousElementSibling.classList.remove('active');
    });
}

function _swapViews(outEl, inEl, instant) {
    if (!outEl || !inEl) return;
    outEl.style.transition = '';
    inEl.style.transition = '';
    if (instant || _reducedMotion()) {
        outEl.style.display = 'none';
        inEl.style.display = 'block';
        outEl.style.opacity = '';
        inEl.style.opacity = '';
    } else {
        outEl.style.transition = 'opacity 0.25s ease';
        outEl.style.opacity = '0';
        setTimeout(() => {
            outEl.style.display = 'none';
            outEl.style.opacity = '';
            inEl.style.opacity = '0';
            inEl.style.display = inEl.dataset.display || 'block';
            inEl.style.transition = 'opacity 0.35s ease';
            requestAnimationFrame(() => { inEl.style.opacity = '1'; });
        }, 250);
    }
    window.scrollTo(0, 0);
}

function showCourses(instant) {
    _swapViews(document.getElementById('welcome-view'), document.getElementById('courses-view'), instant);
}

function hideCourses() {
    collapseAllTerms();
    _swapViews(document.getElementById('courses-view'), document.getElementById('welcome-view'), false);
}

// ---------- Quiz strip ----------
let _stripState = { current: 0, total: 0 };

// Focus mode: whenever a mode screen is open (anything inside #quiz-form / #result),
// the course shell is hidden by CSS (body.in-mode) and the top strip is the navigation.
function _syncFocusMode() {
    const qf = document.getElementById('quiz-form');
    const rs = document.getElementById('result');
    const inCourse = !!document.body.getAttribute('data-course');
    const open = inCourse && ((qf && qf.childNodes.length > 0) || (rs && rs.childNodes.length > 0));
    const was = document.body.classList.contains('in-mode');
    document.body.classList.toggle('in-mode', !!open);
    document.body.classList.toggle('final-screen', !!open && !!document.getElementById('final-anchor'));
    if (!!open !== was) window.scrollTo(0, 0);
    // Setup / list / dashboard screens (no running quiz): strip shows the course + term
    if (open && !document.body.classList.contains('quiz-running')) {
        const c = document.getElementById('qs-count');
        const f = document.getElementById('qs-fill');
        const t = String(currentTerm || '').replace('T', '');
        if (c) c.textContent = `${currentCourse || ''} · Term ${t}`;
        if (f) f.style.width = '0%';
        _syncStripTts();
    }
}
(function () {
    const mo = new MutationObserver(_syncFocusMode);
    ['quiz-form', 'result'].forEach(id => {
        const el = document.getElementById(id);
        if (el) mo.observe(el, { childList: true });
    });
})();

function _syncStripTts() {
    const b = document.getElementById('qs-tts');
    if (b) b.textContent = ttsEnabled ? '🔊' : '🔇';
    const p = document.getElementById('qs-pause');
    if (p) p.textContent = ttsPaused ? '▶️' : '⏸';
    document.body.classList.toggle('tts-active', !!(ttsSpeaking || ttsPaused));
    const on = document.getElementById('tts-on');
    if (on) on.checked = !!ttsEnabled;
}

function _syncQuizStrip(current, total, percent) {
    _stripState = { current, total };
    const running = total > 0 && !!document.body.getAttribute('data-course');
    document.body.classList.toggle('quiz-running', running);
    if (!running) { _syncFocusMode(); return; }
    _syncFocusMode();
    const prefix = { mcq: 'Q', shortAnswer: 'S', essay: 'E', flashcard: 'C' }[currentQuizType] || 'Q';
    const c = document.getElementById('qs-count');
    const f = document.getElementById('qs-fill');
    if (c) c.textContent = `${prefix} ${current} / ${total}`;
    if (f) f.style.width = `${percent}%`;
    _syncStripTts();
}

function _leaveQuiz() {
    stopReading();
    document.getElementById('quiz-form').innerHTML = '';
    document.getElementById('result').innerHTML = '';
    updateProgress(0, 0);
    window.scrollTo(0, 0);
}

function exitQuiz() {
    const inProgress = _stripState.total > 0 && _stripState.current < _stripState.total && currentQuizType !== 'dashboard';
    if (inProgress) {
        const m = document.getElementById('exit-modal');
        if (m) { m.classList.add('show'); return; }
    }
    _leaveQuiz();
}
function closeExitModal() {
    const m = document.getElementById('exit-modal');
    if (m) m.classList.remove('show');
}
function confirmExitQuiz() {
    closeExitModal();
    _leaveQuiz();
}

// Keep the strip's TTS icon in sync with the existing reader toggle
(function () {
    const orig = window.updateTtsButtonText;
    if (typeof orig === 'function') {
        window.updateTtsButtonText = function () { orig.apply(this, arguments); _syncStripTts(); };
    }
})();

// Setup screens always start from "no quiz running" (hides the strip), then run the original
['renderQuiz', 'renderShortAnswers', 'renderEssaySimulation', 'renderFlashcardTopics', 'renderFlashcardSubtopics'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { updateProgress(0, 0); const out = orig.apply(this, arguments); _focusScreen(); return out; };
});

// Soft ambassador pitch on completion screens
function _addSoftPitch() {
    const r = document.getElementById('result');
    const host = (r && r.children.length) ? r : document.getElementById('quiz-form');
    if (!host || host.querySelector('.soft-pitch')) return;
    const d = document.createElement('div');
    d.className = 'soft-pitch';
    d.innerHTML = `Enjoying the quiz? <a href="${AMBASSADOR_PORTAL_URL}" target="_blank" rel="noopener">🚀 Become an Ambassador →</a>`;
    host.appendChild(d);
}
['showFinalMcqScore', 'showFinalShortAnswerScore', 'showFinalEssayScore', 'showFlashcardCompletion'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { const out = orig.apply(this, arguments); setTimeout(_addSoftPitch, 0); return out; };
});

// ---------- Progress dashboard: empty state ----------
(function () {
    const orig = window.renderProgressDashboard;
    if (typeof orig !== 'function') return;
    window.renderProgressDashboard = function () {
        const out = orig.apply(this, arguments);
        try {
            const d = _loadProgress();
            if (currentTermKey && (!d.sessions || d.sessions.length === 0)) {
                document.getElementById('quiz-form').innerHTML = `
                    <div class="empty-progress">
                        <div style="font-size:2.6rem;">📊</div>
                        <h3 style="margin:8px 0;">No Progress Yet</h3>
                        <p style="color:#a0a8b4; margin:0;">Finish a quiz or review some flashcards and your stats will show up here.</p>
                        <div class="ep-actions">
                            ${_modeAvailability().renderQuiz ? '<button type="button" onclick="renderQuiz()" style="background:#007bff;color:#fff;border:none;padding:12px 18px;border-radius:8px;">Start MCQ Quiz</button>' : ''}
                            ${_modeAvailability().renderFlashcardTopics ? '<button type="button" onclick="renderFlashcardTopics()" style="background:#6f42c1;color:#fff;border:none;padding:12px 18px;border-radius:8px;">Study Flashcards</button>' : ''}
                        </div>
                        <button type="button" onclick="exitQuiz()" class="back-button">⬅️ Back to Course</button>
                    </div>`;
            }
        } catch (e) { /* keep the original dashboard */ }
        return out;
    };
})();

// ============================================================
// === FOCUS SCROLLER (auto-scroll into focus) ===
// ============================================================
function _stripOffset() {
    const st = document.getElementById('quiz-strip');
    const h = st && st.offsetHeight ? st.offsetHeight : 44;
    return h + 8;
}
function _scrollBehavior() { return _reducedMotion() ? 'auto' : 'smooth'; }

// Put the top of `el` just under the top strip
function _scrollToTop(el) {
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.pageYOffset - _stripOffset();
    window.scrollTo({ top: Math.max(0, y), behavior: _scrollBehavior() });
}

// Scroll the minimum needed so `el` (feedback + Next button) is on screen
function _ensureVisible(el) {
    if (!el || !el.childNodes.length) return;
    const top = _stripOffset(), vh = window.innerHeight, pad = 16;
    const r = el.getBoundingClientRect();
    let dy = 0;
    if (r.height > vh - top - pad) dy = r.top - top;            // taller than screen: start at its top
    else if (r.bottom > vh - pad) dy = r.bottom - (vh - pad);   // bring the Next/Finish button into view
    else if (r.top < top) dy = r.top - top;
    if (Math.abs(dy) > 2) window.scrollBy({ top: dy, behavior: _scrollBehavior() });
}

// New screen (setup, question, card, list): align it under the strip
function _focusScreen() {
    _syncFocusMode();
    const qf = document.getElementById('quiz-form');
    if (!qf || !qf.childNodes.length) return;
    mountScreen(qf);
    const delta = qf.getBoundingClientRect().top - _stripOffset();
    if (Math.abs(delta) > 6) _scrollToTop(qf);
}

// After answering: bring the verdict, explanation and Next button into focus
(function () {
    const rs = document.getElementById('result');
    if (!rs) return;
    new MutationObserver(() => {
        if (!rs.childNodes.length || document.getElementById('final-anchor')) return;
        requestAnimationFrame(() => _ensureVisible(rs));
        setTimeout(() => { if (rs.childNodes.length) _ensureVisible(rs); }, 350); // after KaTeX/images settle
    }).observe(rs, { childList: true });
})();

// Final screen: show only the score card, fixed, and scroll the score into focus
function _enterFinalScreen() {
    const qf = document.getElementById('quiz-form');
    const rs = document.getElementById('result');
    if (!qf) return;
    if (rs) rs.innerHTML = '';
    if (!document.getElementById('final-anchor')) {
        const a = document.createElement('span');
        a.id = 'final-anchor';
        a.setAttribute('aria-hidden', 'true');
        qf.insertBefore(a, qf.firstChild);
    }
    _syncFocusMode();
    const c = document.getElementById('qs-count');
    const f = document.getElementById('qs-fill');
    if (c) c.textContent = '🏁 Results';
    if (f) f.style.width = '100%';
    _scrollToTop(qf);
    setTimeout(() => { if (document.getElementById('final-anchor')) _scrollToTop(qf); }, 300);
}
['showFinalMcqScore', 'showFinalShortAnswerScore', 'showFinalEssayScore', 'showFlashcardCompletion'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { const out = orig.apply(this, arguments); _enterFinalScreen(); return out; };
});

// Other screens that replace the content in place: align them too
['showFlashcardModeSelection', 'renderProgressDashboard'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () { const out = orig.apply(this, arguments); _focusScreen(); return out; };
});

// ---------- Reset modal ----------
function closeResetModal() {
    const m = document.getElementById('reset-modal');
    if (m) m.classList.remove('show');
}
function confirmResetProgress() {
    closeResetModal();
    try { localStorage.removeItem(_progressKey()); } catch (e) {}
    showAppNotification('\u{1F5D1}\uFE0F Progress reset.', 'info', 2000);
    setTimeout(renderProgressDashboard, 300);
}

// ---------- Draggable WhatsApp (position saved; double-click or long-press resets) ----------
function initDraggableWhatsApp() {
    const el = document.getElementById('draggable-wa');
    if (!el) return;
    const KEY = 'wa_position_v1';
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, pressTimer = null, longPressed = false;

    const clamp = (x, y) => ({
        x: Math.min(Math.max(8, x), window.innerWidth - el.offsetWidth - 8),
        y: Math.min(Math.max(8, y), window.innerHeight - el.offsetHeight - 8)
    });
    const place = (x, y) => {
        const p = clamp(x, y);
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
        el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const reset = () => {
        el.style.left = el.style.top = el.style.right = el.style.bottom = '';
        try { localStorage.removeItem(KEY); } catch (e) {}
    };

    try {
        const s = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (s && isFinite(s.x) && isFinite(s.y)) place(s.x, s.y);
    } catch (e) {}
    window.addEventListener('resize', () => { if (el.style.left) place(parseFloat(el.style.left), parseFloat(el.style.top)); });

    el.addEventListener('pointerdown', e => {
        dragging = true; moved = false; longPressed = false;
        sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        pressTimer = setTimeout(() => {
            if (!moved) { longPressed = true; reset(); showAppNotification('WhatsApp button reset to default position.', 'info', 2000); }
        }, 700);
    });
    el.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) < 8) return;
        moved = true; clearTimeout(pressTimer);
        place(ox + dx, oy + dy);
    });
    el.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false; clearTimeout(pressTimer);
        if (moved) {
            const r = el.getBoundingClientRect();
            try { localStorage.setItem(KEY, JSON.stringify({ x: r.left, y: r.top })); } catch (e) {}
        }
    });
    el.addEventListener('pointercancel', () => { dragging = false; clearTimeout(pressTimer); });
    el.addEventListener('click', e => { if (moved || longPressed) { e.preventDefault(); moved = false; longPressed = false; } });
    el.addEventListener('dblclick', e => { e.preventDefault(); reset(); });
}

// ---------- Ambassador referral capture (?ref=) ----------
let _pendingRef = null;
const _REF_FLAG = 'kaeri_amb_tracked';

function _validRef(r) { return typeof r === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r); }

function checkForReferral() {
    if (!AMBASSADOR_API_URL) return;
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (!_validRef(ref)) return;
    try { if (localStorage.getItem(_REF_FLAG) === ref) return; } catch (e) {}
    _pendingRef = ref;
    const m = document.getElementById('referral-modal');
    if (m) m.classList.add('show');
}

function _closeReferral(markDone) {
    const m = document.getElementById('referral-modal');
    if (m) m.classList.remove('show');
    if (markDone && _pendingRef) { try { localStorage.setItem(_REF_FLAG, _pendingRef); } catch (e) {} }
}

function skipAmbassadorTracking() { _closeReferral(true); }

function submitAmbassadorReferral() {
    const input = document.getElementById('referral-email');
    const err = document.getElementById('referral-error');
    const btn = document.getElementById('referral-submit');
    const email = (input.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Please enter a valid email address.'; return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Sending...';

    let fp = localStorage.getItem('device_fp');
    if (!fp) { fp = navigator.userAgent + '_' + Math.random().toString(36).substring(7); localStorage.setItem('device_fp', fp); }

    fetch(AMBASSADOR_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'logReferral', ref: _pendingRef, visitorEmail: email, ip: '', deviceFingerprint: fp })
    })
    .then(res => res.text())
    .then(t => {
        let data = null;
        try { data = JSON.parse(t); } catch (e) { throw new Error('bad-response'); }
        if (data && data.success === false) throw new Error(data.message || 'failed');
        _closeReferral(true);
        showAppNotification('✅ Thanks! Your friend has been credited.', 'success', 3000);
    })
    .catch(() => {
        err.textContent = 'Could not send right now. Check your connection and try again.';
    })
    .finally(() => { btn.disabled = false; btn.textContent = 'Continue'; });
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', function () {
    // Live prices/durations from PAY-AMB (non-blocking if offline)
    try {
        loadSystemConfig().catch(function (err) {
            console.warn('[config] live prices unavailable:', err && err.message);
            refreshPriceUI();
        });
        startConfigSync();
    } catch (e) {}
    try { _cleanupRetiredMcqSrs(); } catch (e) {}
    initDraggableWhatsApp();
    document.querySelectorAll('[data-amb-link]').forEach(a => { a.href = AMBASSADOR_PORTAL_URL; });
    checkForReferral();

    // Deep link: ?view=courses (unknown values fall back to Welcome)
    const view = new URLSearchParams(window.location.search).get('view');
    if (view === 'courses') showCourses(true);

    // Deep link: ?course=X&term=Y restores the course directly
    const initialRoute = parseURL();
    if (initialRoute.course && initialRoute.term) {
        setTimeout(function () {
            const key = initialRoute.course + '_' + initialRoute.term;
            _suppressNextNavigate = true; // URL already reflects the route
            loadCourse(initialRoute.course, initialRoute.term);
        }, 200);
    }

    // Escape / backdrop close for the custom modals
    function _closeCustomModal(m) {
        if (m.id === 'reset-modal') closeResetModal();
        else if (m.id === 'exit-modal') closeExitModal();
        else if (m.id === 'referral-modal') skipAmbassadorTracking();
        else if (m.id === 'tts-modal') closeTtsSettings();
        else if (m.id === 'pool-reset-modal') closePoolResetModal();
    }
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.r-modal.show').forEach(_closeCustomModal);
    });
    document.querySelectorAll('.r-modal').forEach(m => m.addEventListener('click', e => {
        if (e.target === m) _closeCustomModal(m);
    }));

    // body.modal-open: lock scroll + hide floating WhatsApp whenever ANY modal is open
    function syncModalOpen() {
        const doc = document.getElementById('smart-doc-viewer');
        const open = ['payment-modal', 'print-preview-modal'].some(id => {
            const el = document.getElementById(id); return el && el.classList.contains('show');
        }) || !!document.querySelector('.r-modal.show')
          || !!(doc && doc.style.display && doc.style.display !== 'none');
        document.body.classList.toggle('modal-open', open);
    }
    const mo = new MutationObserver(syncModalOpen);
    ['payment-modal', 'print-preview-modal'].forEach(id => {
        const el = document.getElementById(id);
        if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    document.querySelectorAll('.r-modal').forEach(el => mo.observe(el, { attributes: true, attributeFilter: ['class'] }));

    // Initial sync — catches the rare case where the browser restores
    // a page from back-forward cache with a modal already open.
    syncModalOpen();

    // the document viewer is injected on demand
    const _inject = window.injectDocViewerHTML;
    if (typeof _inject === 'function') {
        window.injectDocViewerHTML = function () {
            const out = _inject.apply(this, arguments);
            const dv = document.getElementById('smart-doc-viewer');
            if (dv) mo.observe(dv, { attributes: true, attributeFilter: ['style'] });
            return out;
        };
    }
});

// ---------- Brand logo: one source (--brand-logo in index.html) ----------
function _brandLogoURI() {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--brand-logo') || '';
        const m = v.match(/url\(\s*['"]?(data:[^'")]+)['"]?\s*\)/);
        return m ? m[1] : '';
    } catch (e) { return ''; }
}
function _brandLogoImg(px, radius) {
    const u = _brandLogoURI();
    return u ? `<img src="${u}" alt="Kaeri EdTech" style="width:${px}px;height:${px}px;border-radius:${radius}px;object-fit:contain;display:block;">` : '';
}
(function () {
    function applyFavicon() {
        const u = _brandLogoURI();
        if (!u) return;
        let l = document.querySelector('link[rel="icon"]');
        if (!l) {
            l = document.createElement('link');
            l.rel = 'icon';
            document.head.appendChild(l);
        }
        if (l.href !== u) l.href = u;
    }
    applyFavicon();
    // Retry on window load in case the stylesheet resolved after this
    // script parsed. Cheap insurance, runs once.
    window.addEventListener('load', applyFavicon);
})(); ; 