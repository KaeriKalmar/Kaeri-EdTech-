// ============================================================
// === KAERI EDTECH QUIZ ENGINE - HYBRID MASTER (v11.9 MERGED) ===
// === Server-Side Access + Local Content + Doc Delivery + KaTeX + Smart TTS + Markdown ===
// === Enhanced with Silent Revalidation, Expiry Display, and Analytics ===
// === NEW: Professional Revision Kit Generator (Branded Covers + Session Metadata) ===
// === ADDITIVE SAFE UPDATES: Subscription guide idempotency + extra plan info helper ===
// ============================================================

// --- CONFIGURATION & STATE ---

// 1. BASE B URL (Handles Auth, Analytics, Payment, Session)
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwBKr4ZAc6m_rehmEywaJhbbiN7G9sWbmvtE544lNZOWgD7e906JxW7Bz4ZuA59sSPfvg/exec";

// 2. BASE A URL (Handles Document Library Fetching ONLY)
const DOCS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxhbrFtkTCj-6ZmnY0xmGjwxIq8YoP3mHEghVbEb4ZnVn_sKoCL_VI3CdsjEjibnGIFbQ/exec";

const PAYMENT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz2g3G6nxVlUW3afcHFpvKY360Qd-XoAKkJ7Jz20pznebDrpBHGKjgkhgC4DMXijnN_/exec";

let ttsEnabled = false;
let printContentData = null;
let hasFullAccess = false;
let currentPrice = 15;
let isSubmissionLocked = false; 

// --- User session data (for silent revalidation & analytics) ---
let userEmail = '';
let userCode = '';
let deviceFP = '';

// --- DATA CONTAINERS ---
let allMcqData = [], allShortData = [], allEssayData = [], allFlashcards = {};
let currentMcqData = [], currentShortData = [], currentEssayData = [], currentFlashcardTopics = {};

// --- SESSION CONTEXT ---
let currentCourse = null, currentTerm = null, currentTermKey = null;
let currentQuizType = null, currentQuestionIndex = 0, currentScore = 0, currentQuizData = [];
let currentEssay = null, currentStepIndex = 0, essayScore = 0;

// Flashcard Specific Contexts
let currentFlashcardTopic = null, currentFlashcards = [], currentCardIndex = 0, isCardFront = true;
let currentFlashcardMode = 'linear'; // 'linear' or 'srs'
let srsQueue = []; 

// Silent revalidation timer
let revalidationInterval = null;

// ============================================================
// === 0. UNIVERSAL PARSER (Markdown -> HTML) ===
// ============================================================

function parseKaeriMarkdown(text) {
    if (!text) return "";
    let t = text;

    // 1. Headers (# H1, ## H2)
    t = t.replace(/^## (.*$)/gim, "<h3 style='margin:10px 0; color:#72efdd;'>$1</h3>");
    t = t.replace(/^# (.*$)/gim, "<h2 style='margin:15px 0; color:#fff;'>$1</h2>");

    // 2. Blockquotes (> text)
    t = t.replace(/^> (.*$)/gim, "<blockquote style='border-left:4px solid #72efdd; margin:10px 0; padding-left:15px; color:#a0a8b4; font-style:italic;'>$1</blockquote>");

    // 3. Bullet Lists (- item)
    t = t.replace(/^- (.*$)/gim, "<li style='margin-left:20px;'>$1</li>");

    // 4. Bold (**text**)
    t = t.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // 5. Underline (__text__)
    t = t.replace(/__(.*?)__/g, "<u>$1</u>");

    // 6. Italic (*text*) - careful regex to avoid breaking Math symbols
    t = t.replace(/(?<!\\)\*([^\s].*?)(?<!\\)\*/g, "<em>$1</em>");

    // 7. Line Breaks (Convert newlines to HTML breaks)
    t = t.replace(/\n/g, "<br>");

    return t;
}

// ============================================================
// === 1. INITIALIZATION & DATA LOADING ===
// ============================================================

function loadGlobalData() {
    if (typeof mcqData !== 'undefined') allMcqData = mcqData; 
    else if (typeof mcqDa !== 'undefined') allMcqData = mcqDa; 
    else allMcqData = [];
    
    allShortData = typeof shortData !== 'undefined' ? shortData : [];
    allEssayData = typeof essayData !== 'undefined' ? essayData : [];
    allFlashcards = typeof flashcards !== 'undefined' ? flashcards : {};
}

async function initializeCourseLogic() {
    loadGlobalData();
    
    // Initialize TTS
    ttsEnabled = localStorage.getItem("ttsEnabled") === "true";
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
    }

    // Context Setup
    const body = document.body;
    currentCourse = body.getAttribute('data-course');
    currentTerm = body.getAttribute('data-term');
    currentTermKey = `${currentCourse}_${currentTerm}`;

    // Filter Data
    currentMcqData = filterDataByCourseAndTerm(allMcqData, currentCourse, currentTerm);
    currentShortData = filterDataByCourseAndTerm(allShortData, currentCourse, currentTerm);
    currentEssayData = filterDataByCourseAndTerm(allEssayData, currentCourse, currentTerm);
    currentFlashcardTopics = filterFlashcardsByCourseAndTerm(allFlashcards, currentCourse, currentTerm);

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
                <p style="color:#72efdd; margin-top:20px; font-size:0.9em;">Loading Preview...</p>
            </div>

            <!-- The Iframe -->
            <iframe id="doc-frame" style="flex:1; width:100%; border:none; background:white;" allow="autoplay; fullscreen" allowfullscreen></iframe>
            
            <div style="text-align:center; color:#888; font-size:0.75em; padding:5px; background:#0d1b2a; border-top:1px solid #3e506e;">
                Protected Content - Kaeri EdTech
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', viewerHTML);
}

function openDocumentViewer(fileId, title) {
    if (!fileId || fileId === 'undefined') {
        showAppNotification("⚠️ Document link unavailable", "error");
        return;
    }
    
    const viewer = document.getElementById('smart-doc-viewer');
    const iframe = document.getElementById('doc-frame');
    const titleEl = document.getElementById('viewer-title');
    const loader = document.getElementById('doc-loader-overlay');
    
    if (!viewer || !iframe) {
        injectDocViewerHTML();
        setTimeout(() => openDocumentViewer(fileId, title), 50);
        return;
    }
    
    // Reset state
    titleEl.textContent = title || "Document";
    iframe.src = ""; // Clear previous to prevent ghosting
    loader.style.display = 'flex'; // Show shimmer
    viewer.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    
    // Load new document
    iframe.src = `https://drive.google.com/file/d/${fileId}/preview`;
    iframe.onload = function() {
        // Small buffer to ensure rendering has started
        setTimeout(() => {
            loader.style.display = 'none';
        }, 500);
    };

    // Use Base B's analytics, but triggered by Base A's viewer
    logAnalyticsEvent('document_view', `Viewed: ${title}`);
}

function closeDocViewer() {
    const viewer = document.getElementById('smart-doc-viewer');
    if (viewer) {
        viewer.style.display = 'none';
        const iframe = document.getElementById('doc-frame');
        if (iframe) iframe.src = "";
        document.body.style.overflow = 'auto';
    }
}

// ============================================================
// === NEW: Document Access Control & Quiz Starter Helpers ===
// ============================================================

// Document access bouncer - controls who can open documents
function attemptOpenDoc(fileId, title) {
    if (hasFullAccess) {
        // Paid user: open normally
        openDocumentViewer(fileId, title);
    } else {
        // Free user: show message and payment modal
        showAppNotification("⚠️ Documents are only accessible in Full Access mode.", "warning", 2500);
        setTimeout(() => {
            openPaymentModal();
        }, 1000);
    }
}

// MCQ starter - initializes quiz with specified number of questions
function startActualMcq(limit) {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    
    let q = shuffle([...currentMcqData]).slice(0, limit);
    currentQuizData = q;
    currentQuizType = 'mcq';
    currentQuestionIndex = 0;
    currentScore = 0;
    
    if (q.length === 0) {
        container.innerHTML = "<p>No questions available.</p>";
        updateProgress(0, 0);
        return;
    }
    displayMcqQuestion();
    logAnalyticsEvent('quiz_start', `MCQ (${limit} questions)`);
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

// Step selector for MCQ preset buttons
function selectQuizStep(step, label) {
    const totalAvailable = currentMcqData.length;
    const finalCount = (step > totalAvailable) ? totalAvailable : step;
    showAppNotification(`🎯 Starting ${finalCount} question quiz`, "success", 1500);
    setTimeout(() => startActualMcq(finalCount), 500);
}

// Step selector for Short Answer preset buttons
function selectShortAnswerStep(step, label) {
    const totalAvailable = currentShortData.length;
    const finalCount = (step > totalAvailable) ? totalAvailable : step;
    showAppNotification(`🎯 Starting ${finalCount} question practice`, "success", 1500);
    setTimeout(() => startActualShortAnswer(finalCount), 500);
}

// Custom number handler for MCQ
function startCustomQuiz() {
    const input = document.getElementById('custom-q-count');
    if (!input) return;
    
    let requestedCount = parseInt(input.value);
    const totalAvailable = currentMcqData.length;
    
    if (isNaN(requestedCount) || requestedCount < 1) {
        showAppNotification("⚠️ Please enter a valid number", "warning");
        return;
    }
    
    if (requestedCount > totalAvailable) {
        showAppNotification(`ℹ️ Only ${totalAvailable} available. Using all.`, "info", 2000);
        requestedCount = totalAvailable;
    }
    
    startActualMcq(requestedCount);
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

async function renderDocuments() {
    // IMPORTANT: Uses DOCS_SCRIPT_URL (Base A) to fetch data
    // blockDemo check removed - everyone sees the list!
    
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
        const payload = JSON.stringify({
            action: 'GET_STUDENT_DOCS',
            payload: { course: currentCourse, term: currentTerm }
        });

        // FETCHING FROM BASE A URL
        const response = await fetch(DOCS_SCRIPT_URL, {
            method: 'POST',
            redirect: "follow",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: payload
        });
        
        const data = await response.json();
        const documents = data.documents || (data.data && data.data.documents) || [];
        const success = data.success || false;
        
        if (!success || documents.length === 0) {
            container.innerHTML = `<div style="text-align:center; padding:30px;"><h3>📂 Library Empty</h3><p>No active documents found.</p><button class="restart-button" onclick="backToMenu()">Back to Menu</button></div>`;
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
            
            // Dynamic styling based on access
            const lockIcon = hasFullAccess ? "👁️ Open" : "🔒 Locked";
            const lockColor = hasFullAccess ? "#28a745" : "#dc3545";
            const cardOpacity = hasFullAccess ? "1" : "0.75";
            
            html += `
            <div class="doc-card" onclick="attemptOpenDoc('${doc.fileId}', '${doc.title.replace(/'/g, "\\'")}')" 
                 style="background:#2b3a55; padding:15px; border-radius:10px; border-left:5px solid ${lockColor}; 
                        cursor:pointer; transition:0.3s; box-shadow: 0 4px 8px rgba(0,0,0,0.2); opacity: ${cardOpacity};">
                <div style="font-size:0.7em; text-transform:uppercase; color:${lockColor}; font-weight:bold; letter-spacing:1px; margin-bottom:5px;">${doc.topic || 'General'}</div>
                <div style="font-size:1.1em; font-weight:bold; color:white; margin-bottom:8px; line-height:1.3;">${doc.title}</div>
                <div style="font-size:0.85em; color:#a0a8b4; margin-bottom:10px;">${shortDesc}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid #3e506e; padding-top:10px;">
                    <span style="background:#0d1b2a; padding:2px 8px; border-radius:4px; font-size:0.7em; color:#fff;">${doc.type || 'FILE'} • ${doc.size || 'Unknown'}</span>
                    <span style="color:${lockColor}; font-size:0.9em; font-weight:bold;">${lockIcon}</span>
                </div>
            </div>`;
        });

        html += `</div>`;
        html += `<div style="text-align:center; margin-top:20px;"><button class="restart-button" onclick="backToMenu()">⬅ Back to Menu</button></div>`;
        container.innerHTML = html;

    } catch (e) {
        container.innerHTML = `<div style="text-align:center; padding:20px; color:#dc3545;"><h3>⚠️ Connection Error</h3><p>Could not load library.</p><button class="restart-button" onclick="renderDocuments()">Try Again</button></div>`;
    }
}

// ============================================================
// === 4. SECURITY & AUTHENTICATION (BASE B) ===
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
                action: 'validate_access_code',   // Correct action for backend
                code: userCodeInput,
                email: userEmailInput,
                device_fp: deviceFP,              // Backend expects device_fp
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
// === NEW: Silent Revalidation & Session Status (BASE B) ===
// ============================================================

async function silentRevalidation() {
    if (!hasFullAccess || !userEmail || !userCode) return;
    
    try {
        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
                action: 'silent_revalidation',
                email: userEmail,
                code: userCode,
                session_token: localStorage.getItem(`token_${currentTermKey}`) || ''
            })
        });
        const result = await response.json();
        if (!result.success) {
            // Session invalid – log out
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
                action: 'check_session_status',
                email: userEmail,
                code: userCode
            })
        });
        const result = await response.json();
        if (result.success) {
            const data = result.data;
            // Update banner with expiry date
            if (data.expiry_date) {
                const expiryDate = new Date(data.expiry_date);
                updateModeBanner(`✅ FULL ACCESS (expires ${expiryDate.toLocaleDateString()})`);
                
                // Show notification with days remaining
                if (data.days_remaining !== null) {
                    const days = data.days_remaining;
                    if (days > 0) {
                        showAppNotification(`ℹ️ Your license expires in ${days} day(s).`, 'info', 5000);
                    } else if (days === 0) {
                        showAppNotification(`⚠️ Your license expires today!`, 'warning', 7000);
                    }
                }
            }
        } else {
            // Session invalid
            handleSessionExpired(result.message);
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
    enableDemoUI();
    showAppNotification(`⏳ ${message || 'Session expired. Please log in again.'}`, 'warning');
}

function startSilentRevalidation() {
    if (revalidationInterval) clearInterval(revalidationInterval);
    // Run every 5 minutes (300000 ms)
    revalidationInterval = setInterval(silentRevalidation, 300000);
    // Also run once immediately after a short delay
    setTimeout(silentRevalidation, 5000);
}

// ============================================================
// === NEW: Silent Analytics Logging (BASE B) ===
// ============================================================

function logAnalyticsEvent(actionType, details) {
    // Fire and forget – user never sees this
    fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
            action: 'log_system_event',
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
    const maxAttempts = 10;
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
    if (confirm('Reset all progress data for this course/term? This cannot be undone.')) {
        localStorage.removeItem(_progressKey());
        showAppNotification('\u{1F5D1}\uFE0F Progress reset.', 'info', 2000);
        setTimeout(renderProgressDashboard, 300);
    }
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
            <div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:0.85em;color:white;">\uD83D\uDCDD MCQ</span>
                    <span style="font-size:0.75em;color:#a0a8b4;">Best: ${data.mcqBest}%</span>
                </div>
                ${bar(mcqAvg, '#72efdd')}
            </div>
            <div style="margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:0.85em;color:white;">\u270D\uFE0F Short Answer</span>
                    <span style="font-size:0.75em;color:#a0a8b4;">Best: ${data.saBest}%</span>
                </div>
                ${bar(saAvg, '#ffc107')}
            </div>
            <div style="margin-bottom:2px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:0.85em;color:white;">\uD83D\uDCC4 Essay Sim</span>
                    <span style="font-size:0.75em;color:#a0a8b4;">Best: ${data.essayBest}%</span>
                </div>
                ${bar(esAvg, '#e67e00')}
            </div>
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid #2b3a55;">
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
            <button onclick="backToMenu()" class="back-button" style="margin:0;">\u2B05\uFE0F Back to Menu</button>
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
// ============================================================

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
}

function loadCourse(course, term, price) {
    document.body.setAttribute('data-course', course);
    document.body.setAttribute('data-term', term);
    currentPrice = price;
    
    document.getElementById('course-title').textContent = `${course} Term ${term.replace('T','')} Study Materials`;
    document.getElementById('price-banner').textContent = `Price: K${price}`;
    document.getElementById('price-val').textContent = `K${price}`;
    document.getElementById('price-desc').textContent = `${course} Term ${term.replace('T','')}`;
    
    document.getElementById('landing-view').style.display = 'none';
    document.getElementById('landing-header').style.display = 'none'; 
    document.getElementById('course-view').style.display = 'block';
    document.getElementById('fixed-header').style.display = 'block';
    document.getElementById('price-banner').style.display = 'block';
    document.body.classList.add('view-course');
    window.scrollTo(0,0);
    
    setTimeout(() => {
        initializeCourseLogic();
        renderQuiz(); 
    }, 100);
}

function backToMenu() {
    document.getElementById('landing-view').style.display = 'block';
    document.getElementById('landing-header').style.display = 'block'; 
    document.getElementById('course-view').style.display = 'none';
    document.getElementById('fixed-header').style.display = 'none';
    document.getElementById('price-banner').style.display = 'none';
    document.body.classList.remove('view-course');

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

function openPaymentModal() {
    document.getElementById('pay-term-name').textContent = `${currentCourse} ${currentTerm}`;
    document.getElementById('pay-amount').textContent = `K${currentPrice}`;
    document.getElementById('payment-modal').classList.add('show');
    updateBuyNowLink(currentCourse, currentTerm, currentPrice);

    setTimeout(() => {
        const input = document.getElementById('access-code-input');
        if(input) input.focus();
    }, 300);
}

// ============================================================
// === MODIFIED: closePaymentModal with idempotency reset for subscription guide ===
// ============================================================
function closePaymentModal() {
    const modal = document.getElementById('payment-modal');
    if (modal) modal.classList.remove('show');
    
    // ADDITIVE: Close the subscription guide if it exists (idempotency reset)
    const guide = document.getElementById('subscription-guide');
    if (guide) {
        guide.removeAttribute('open');
    }
}

function updateBuyNowLink(course, term, price) {
  const buyNowLink = document.getElementById('buy-now-link');
  const buyPriceElement = document.getElementById('buy-price');
  if (buyNowLink && buyPriceElement) {
    buyPriceElement.textContent = `K${price}`;
    const paymentUrl = `${PAYMENT_SCRIPT_URL}?course=${course}&term=${term}`;
    buyNowLink.href = paymentUrl;
    const buyButton = buyNowLink.querySelector('button');
    if (buyButton) {
      buyButton.innerHTML = `🛒 Buy ${course} ${term} (K${price})`;
    }
  }
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
}

function clearDemoLocks() {
    ["mcq", "shortAnswer", "essay", "flashcard", "documents"].forEach(
        m => localStorage.removeItem(`demo_${m}_used_${currentTermKey}`)
    );
}

// ============================================================
// === ADDITIVE HELPER: Show info for extra price cards (does not break existing flow) ===
// ============================================================
function showExtraPlanInfo(plan, price) {
    showAppNotification(`ℹ️ ${plan} (${price}) – coming soon! For now, use "Buy Now" for single term.`, "info", 4000);
}

// ============================================================
// === 6. QUIZ ENGINE with Tiered Access ===
// ============================================================

function renderQuiz() {
    // FREE USER: Fixed at 10 questions
    if (!hasFullAccess) {
        if (blockDemo('mcq')) return;
        startActualMcq(10);
        return;
    }
    
    // PAID USER: Show setup screen with preset buttons
    const container = document.getElementById("quiz-form");
    const totalAvailable = currentMcqData.length;
    
    if (totalAvailable <= 5) {
        startActualMcq(totalAvailable);
        return;
    }
    
    const steps = [5, 10, 20, 30, 40, 50, totalAvailable];
    const stepLabels = ['5', '10', '20', '30', '40', '50', 'ALL'];
    
    container.innerHTML = `
        <div style="background:#1e2a3a; padding:30px; border-radius:15px; border:2px solid #72efdd; text-align:center; max-width:450px; margin:20px auto;">
            <h2 style="color:white; margin-bottom:10px;">⚙️ Premium Quiz Setup</h2>
            <p style="color:#a0a8b4; margin-bottom:20px;">Choose your challenge size</p>
            
            <div style="margin:30px 0;">
                <div style="display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:20px 0;">
                    ${steps.map((step, index) => `
                        <button onclick="selectQuizStep(${step}, '${stepLabels[index]}')" 
                            style="flex:1; min-width:45px; background:${step === 10 ? '#28a745' : '#2b3a55'}; 
                                   color:white; border:none; padding:12px 8px; border-radius:8px; 
                                   font-weight:bold; cursor:pointer;">
                            ${stepLabels[index]}
                        </button>
                    `).join('')}
                </div>
                
                <div style="margin-top:25px; padding-top:20px; border-top:1px solid #3e506e;">
                    <p style="color:#a0a8b4; margin-bottom:10px;">Or custom number:</p>
                    <div style="display:flex; gap:10px;">
                        <input type="number" id="custom-q-count" min="1" max="${totalAvailable}" value="10" 
                               style="flex:2; padding:12px; border-radius:8px; border:1px solid #3e506e; 
                                      background:#0d1b2a; color:white;">
                        <button onclick="startCustomQuiz()" 
                                style="flex:1; background:#007bff; color:white; border:none; 
                                       padding:12px; border-radius:8px; font-weight:bold; cursor:pointer;">
                            Go
                        </button>
                    </div>
                </div>
                
                <div style="margin-top:20px; color:#72efdd; background:#0d1b2a; padding:10px; border-radius:6px;">
                    📊 ${totalAvailable} questions available
                </div>
            </div>
            
            <div style="margin-top:20px;">
                <button onclick="backToMenu()" class="back-button" style="margin-top:0;">⬅️ Back</button>
            </div>
        </div>
    `;
}

function renderShortAnswers() {
    // FREE USER: Fixed at 10 questions
    if (!hasFullAccess) {
        if (blockDemo('shortAnswer')) return;
        startActualShortAnswer(10);
        return;
    }
    
    // PAID USER: Show setup screen with preset buttons
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
                <button onclick="backToMenu()" class="back-button" style="margin-top:0;">⬅️ Back</button>
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
    container.scrollIntoView({ behavior: "smooth" });
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
    } else {
        resultDiv.innerHTML = `<p>❌ Correct: ${String.fromCharCode(65 + q.correct)}. ${parseKaeriMarkdown(q.options[q.correct])}</p>`;
        feedbackText = `Wrong. The correct answer is option ${String.fromCharCode(65 + q.correct)}.`;
    }
    
    const explanationBox = `<div class="explanation-box">${parseKaeriMarkdown(q.explanation || '')}</div>`;
    resultDiv.innerHTML += explanationBox;
    feedbackText += ` Explanation: ${humanizeLaTeX(q.explanation || '')}`;
    
    currentQuestionIndex++;

    // ── CHANGE 1: On last question, Finish button skips straight to final card ──
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

    const previewBtn = document.createElement("button");
    previewBtn.innerText = "👁️ Preview & Print";
    previewBtn.style.backgroundColor = "#007bff"; 
    previewBtn.style.color = "white";
    previewBtn.style.marginLeft = "10px";
    previewBtn.onclick = generatePrintPreview;
    container.appendChild(previewBtn);

    // ── CHANGE 2: Switch learning modality panel ──
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
    container.appendChild(switchDiv);

    // Record local progress
    recordProgressSession('mcq', currentScore, currentQuizData.length, `${currentCourse} ${currentTerm} MCQ`);
    // Log analytics
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
    container.scrollIntoView({ behavior: "smooth" });
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

    // ── CHANGE 1: On last question, Finish button skips straight to final card ──
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

    // ── CHANGE 2: Switch learning modality panel ──
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
    container.appendChild(switchDiv);

    recordProgressSession('shortAnswer', currentScore, currentQuizData.length, `${currentCourse} ${currentTerm} Short Answer`);
    logAnalyticsEvent('quiz_complete', `Short Answer score: ${currentScore}/${currentQuizData.length} (${percent}%)`);
}

function renderEssaySimulation() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";

    currentQuizData = currentEssayData; 
    if (currentQuizData.length === 0) {
        container.innerHTML = "<p>No essay simulations available for this term yet.</p>";
        updateProgress(0, 0);
        return;
    }

    currentQuizType = 'essay'; 
    updateProgress(0, 0);

    const header = document.createElement("h2");
    header.innerText = "Select Essay Topic";
    header.style.textAlign = "center"; 
    header.style.marginBottom = "25px";
    container.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'flashcard-topic-buttons'; 

    currentQuizData.forEach((essay, index) => {
        const btn = document.createElement("button");
        btn.textContent = essay.title; 
        btn.onclick = () => attemptStartEssay(index); 
        listDiv.appendChild(btn);
    });

    container.appendChild(listDiv);
}

function attemptStartEssay(index) {
    if (blockDemo('essay')) return; 
    startSpecificEssay(index);
}

function startSpecificEssay(index) {
    currentEssay = currentQuizData[index];
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
        <div class="question-header"><h3>📄 ${essay.title} — Step ${index + 1} of ${essay.steps.length}</h3><p>Topic: ${essay.topic} | ${essay.year}</p></div>
        <div class="question-box"><p><strong>Q:</strong> ${parseKaeriMarkdown(step.q)}</p><div class="options">
    `;
    step.options.forEach((opt, i) => {
        html += `<label class="option"><input type="radio" name="step-option" value="${i}" /> <span>${String.fromCharCode(65 + i)}. ${parseKaeriMarkdown(opt)}</span></label>`;
    });
    
    html += `</div><button id="essay-submit-btn" onclick="checkEssayStep()">✅ Submit Step</button></div>`;
    container.innerHTML = html;
    
    renderMath();
    document.getElementById("result").innerHTML = "";
    container.scrollIntoView({ behavior: "smooth" });
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

    // ── CHANGE 1: On last step, Finish button skips straight to final card ──
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
    retryBtn.onclick = () => attemptStartEssay(currentQuizData.indexOf(currentEssay));
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

    // ── CHANGE 2: Switch learning modality panel ──
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
    container.appendChild(switchDiv);

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
// === 8. FLASHCARD ENGINE - HYBRID MASTER (LINEAR + SRS) ===
// ============================================================

// --- TOPIC SELECTION & MODE CHOICE ---
function renderFlashcardTopics() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    currentQuizType = 'flashcard';
    updateProgress(0, 0);

    if (Object.keys(currentFlashcardTopics).length === 0) {
        container.innerHTML = "<p>No flashcards available for this term.</p>";
        return;
    }

    const header = document.createElement("h2");
    header.innerText = "Select Flashcard Topic";
    header.style.textAlign = "center";
    header.style.marginBottom = "25px";
    container.appendChild(header);

    const listDiv = document.createElement('div');
    listDiv.className = 'flashcard-topic-buttons';
    
    for (const topic in currentFlashcardTopics) {
        const btn = document.createElement("button");
        btn.textContent = topic;
        btn.onclick = () => attemptStartFlashcard(topic);
        listDiv.appendChild(btn);
    }
    container.appendChild(listDiv);
}

function attemptStartFlashcard(topic) {
    if (blockDemo('flashcard')) return;
    showFlashcardModeSelection(topic);
}

function showFlashcardModeSelection(topic) {
    const container = document.getElementById("quiz-form");
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
            <h2 style="margin-bottom: 10px; color: white;">🗂️ ${topic}</h2>
            <p style="color: #a0a8b4; margin-bottom: 25px;">Choose your study method:</p>

            <div style="display: flex; flex-direction: column; gap: 15px; max-width: 450px; margin: 0 auto;">
                
                <!-- OPTION 1: LINEAR (Review All) -->
                <button onclick="startFlashcards('${topic}', 'linear')" 
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
                <button onclick="startFlashcards('${topic}', 'srs')" 
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
            
            <button class="back-button" style="margin-top: 30px; background: transparent; color: #888; border: 1px solid #3e506e; padding: 10px 20px; border-radius: 20px;" onclick="renderFlashcardTopics()">Cancel</button>
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
                    <button class="restart-button" onclick="startFlashcards('${topic}', 'linear')">📖 Switch to Standard Review</button>
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
        const hasList = /^- /m.test(text) || /<ul>|<ol>|<li>/.test(parseKaeriMarkdown(text));
    
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
            ${modeLabel}: ${currentFlashcardTopic} <span style="color: white;">(${currentCardIndex + 1} / ${currentFlashcards.length})</span>
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
    container.scrollIntoView({ behavior: "smooth" });
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
    container.appendChild(switchDiv);

    recordProgressSession('flashcard', currentFlashcards.length, currentFlashcards.length, `${currentFlashcardTopic} Flashcards`);
    logAnalyticsEvent('flashcard_complete', `${currentFlashcardTopic} (${currentFlashcardMode} mode)`);
}

// ============================================================
// === 9. SMART FEATURES & PRINT ===
// ============================================================

function challengeFriend(score, total, modeName) {
    const link = "https://kaerikalmar.github.io/KAERI-CBU-REVISIONS-SITE/";
    let message = "";
    
    if (modeName === "Flashcards") {
        message = `I mastered the ${score} Flashcard Deck on Kaeri EdTech! Challenge you to beat me! 👇\n${link}`;
    } else {
        const percent = Math.round((score / total) * 100);
        message = `I scored ${percent}% (${score}/${total}) in ${currentCourse} ${currentTerm} (${modeName})! Challenge you to beat my score! 👇\n${link}`;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
}

// ── PRINT HELPERS (KAERI STANDARD REVISION KIT ENGINE v2.0) ──────────────
// Replaces the old flat _buildPrintItemHTML / _buildPrintDocHTML system.
// On preview: clean card list, no cover.
// On print:   full branded A4 document — front cover, TOC, JS-paginated
//             content pages (no card bleeds), back cover with QR code.
// ─────────────────────────────────────────────────────────────────────────

// ── COURSE IDENTITY MAP ───────────────────────────────────────────────────
const COURSE_IDENTITY = {
    'CS110': { accent: '#00bcd4', name: 'Introduction to Computing' },
    'MA110': { accent: '#42a5f5', name: 'Mathematics' },
    'PH110': { accent: '#ab47bc', name: 'Physics' },
    'CH110': { accent: '#ef5350', name: 'Chemistry' },
    'BI110': { accent: '#7cb342', name: 'Biology' },
    'LA111': { accent: '#ffa726', name: 'Communication Skills' },
    'MT221': { accent: '#26a69a', name: 'Mineral Processing' },
};

// ── SECTION COLOUR PALETTE (9 rotating slots) ────────────────────────────
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

// ── SESSION LABELS ────────────────────────────────────────────────────────
const SESSION_LABELS = {
    mcq:         { title: 'Multiple Choice',    icon: '📋' },
    shortAnswer: { title: 'Short Answer',       icon: '✍️'  },
    essay:       { title: 'Essay Simulation',   icon: '📄' },
    flashcard:   { title: 'Flashcard Glossary', icon: '🃏' },
};

// ── HELPERS ───────────────────────────────────────────────────────────────
function _courseIdentity(course) {
    return COURSE_IDENTITY[course] || { accent: '#111435', name: course };
}
function _termLabel(term) {
    return term ? 'Term ' + term.replace('T', '') : '';
}

// ── GROUP SESSION DATA INTO SECTIONS ─────────────────────────────────────
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
        sections.push({
            num:   1,
            name:  currentFlashcardTopic,
            pal:   SECTION_PALETTE[3],
            items: currentFlashcards,
        });
    }
    return sections;
}

// ── SINGLE CARD HTML (used in both preview and print doc) ─────────────────
function _itemCardHTML(item, sectionName, type, idx, pal) {
    const acc = pal.acc;
    let labelText = '', qHTML = '', aHTML = '', eHTML = '';

    function md(t) { return t ? parseKaeriMarkdown(t) : ''; }

    if (type === 'mcq') {
        labelText = 'Q' + (idx + 1);
        qHTML = md(item.q);
        const opt = (item.options && item.options[item.correct] !== undefined)
            ? String.fromCharCode(65 + item.correct) + '. ' + md(item.options[item.correct]) : '—';
        aHTML = '<strong>Answer:</strong> ' + opt;
        eHTML = md(item.explanation || 'No additional explanation.');
    } else if (type === 'shortAnswer') {
        labelText = 'Q' + (idx + 1);
        qHTML = md(item.q);
        aHTML = '<strong>Keywords:</strong> ' + (item.keywords || []).join(', ');
        eHTML = md(item.explanation || 'No additional explanation.');
    } else if (type === 'essay') {
        labelText = 'Step ' + (idx + 1);
        qHTML = md(item.q);
        const opt = (item.options && item.options[item.correct] !== undefined)
            ? String.fromCharCode(65 + item.correct) + '. ' + md(item.options[item.correct]) : '—';
        aHTML = '<strong>Correct:</strong> ' + opt;
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

// ── FULL BRANDED A4 PRINT DOCUMENT ────────────────────────────────────────
function _buildFullPrintDocument(course, term, sessionType, sections, date) {
    const identity  = _courseIdentity(course);
    const termLabel = _termLabel(term);
    const sessInfo  = SESSION_LABELS[sessionType] || { title: sessionType, icon: '📄' };
    const qrUrl     = 'https://quickchart.io/qr?text=https%3A%2F%2Fwhatsapp.com%2Fchannel%2F0029VbCc0hEL7UVMs55diC3i&dark=111435&size=300';

    let totalItems = 0;
    sections.forEach(s => { totalItems += s.items.length; });

    // TOC rows
    let tocRows = '';
    sections.forEach(s => {
        const typePrefix = sessionType === 'flashcard' ? 'Card' : sessionType === 'essay' ? 'Step' : 'Q';
        tocRows += `
        <div style="display:flex;align-items:center;padding:11px 18px;border-radius:4px;
                    font-size:12px;font-weight:500;background:${s.pal.bg};margin-bottom:6px;
                    page-break-inside:avoid;break-inside:avoid;">
            <span style="font-weight:800;color:${s.pal.acc};margin-right:18px;min-width:22px;">${String(s.num).padStart(2,'0')}</span>
            <span style="flex-grow:1;color:#222;">${s.name}</span>
            <span style="color:#666;margin-right:14px;font-size:10px;">${typePrefix}1 – ${typePrefix}${s.items.length}</span>
            <span style="font-weight:700;color:${s.pal.acc};">${s.items.length} items</span>
        </div>`;
    });

    // Sections data serialised for the in-iframe pagination engine
    const sectionsJSON = JSON.stringify(sections.map(s => ({
        num: s.num, name: s.name, pal: s.pal,
        items: s.items,
    })));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
    :root { --primary:#111435; --yellow:#fccb00; }
    *{ box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body{ margin:0; padding:0; background:#e6e6e6; font-family:'Inter',Arial,sans-serif; }
    @page{ size:A4; margin:0; }
    .sheet{ width:210mm; height:297mm; background:white; margin:20px auto;
            position:relative; overflow:hidden; page-break-after:always;
            box-shadow:0 0 15px rgba(0,0,0,0.25); }
    @media print{ body{background:none;} .sheet{margin:0;box-shadow:none;} }
    .pg-header{ position:absolute; top:13mm; left:14mm; right:14mm; height:14mm;
                border-bottom:2px solid var(--primary); display:flex;
                justify-content:space-between; align-items:flex-end;
                padding-bottom:5px; color:var(--primary); }
    .pg-footer{ position:absolute; bottom:13mm; left:14mm; right:14mm; height:10mm;
                border-top:1px solid #ccc; display:flex; justify-content:space-between;
                align-items:center; font-size:9px; color:#888; padding-top:4px; }
    .pg-content{ position:absolute; top:32mm; bottom:27mm; left:14mm; right:14mm;
                 overflow:hidden; display:flex; flex-direction:column; }
    .brand{ font-weight:800; font-size:13px; letter-spacing:0.5px; text-transform:uppercase; color:var(--primary); }
    .meta { font-size:9px; font-weight:600; color:#666; text-transform:uppercase; }
    .pg-num{ font-weight:700; color:var(--primary); }
    .sheet.cover{ background:var(--primary); color:white; display:flex;
                  flex-direction:column; justify-content:center; padding:18mm; }
    .cover-graphics{ position:absolute; inset:0; overflow:hidden; pointer-events:none; }
    .diag{ position:absolute; top:-50%; right:-20%; width:150%; height:150%;
           background:linear-gradient(135deg,transparent 45%,rgba(252,203,0,0.13) 45%,rgba(252,203,0,0.13) 55%,transparent 55%);
           transform:rotate(25deg); }
    .circ{ position:absolute; bottom:-150px; left:-150px; width:400px; height:400px;
           border-radius:50%; background:rgba(26,32,85,0.75); }
    .cover-inner{ position:relative; z-index:2; height:100%; display:flex; flex-direction:column; justify-content:center; }
    .stats-grid{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:36px 0; max-width:72%; }
    .stat-num{ font-size:40px; font-weight:800; color:var(--yellow); display:block; line-height:1; }
    .stat-lbl{ font-size:10px; text-transform:uppercase; color:#ddd; letter-spacing:1px; }
    .cover-rule{ border-top:1px solid var(--yellow); padding-top:18px; margin-top:auto; }
    .sec-title{ font-size:13px; font-weight:800; color:var(--primary);
                border-bottom:3px solid var(--yellow); padding-bottom:8px; margin-bottom:14px; }
</style>
</head>
<body>

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
        <div class="stats-grid">
            <div><span class="stat-num">${totalItems}</span><span class="stat-lbl">ITEMS</span></div>
            <div><span class="stat-num">${sections.length}</span><span class="stat-lbl">SECTIONS</span></div>
            <div><span class="stat-num" style="font-size:22px;">${course}</span><span class="stat-lbl">COURSE</span></div>
            <div><span class="stat-num">A4</span><span class="stat-lbl">FORMAT</span></div>
        </div>
        <div class="cover-rule">
            <h3 style="color:var(--yellow);margin:0;">KAERI EDTECH</h3>
            <p style="font-size:10px;opacity:0.75;margin-top:4px;">${identity.name} · ${termLabel} · ${date}</p>
        </div>
    </div>
</div>

<!-- TABLE OF CONTENTS -->
<div class="sheet">
    <div class="pg-header">
        <span class="brand">KAERI EDTECH</span>
        <span class="meta">${course} · ${termLabel}</span>
    </div>
    <div class="pg-footer">
        <span>&copy; 2026 Kaeri EdTech</span><span class="pg-num">Page 2</span>
    </div>
    <div class="pg-content">
        <div class="sec-title">Table of Contents &mdash; ${sections.length} Section${sections.length !== 1 ? 's' : ''}</div>
        ${tocRows}
        <div style="margin-top:16px;padding:12px 16px;background:#f8f9fc;border-radius:6px;font-size:12px;color:#444;line-height:1.6;">
            <strong style="color:var(--primary);">How to use this kit:</strong>
            Cover the answer, attempt the question, then reveal and read the explanation.
            This kit contains <strong>${totalItems} items</strong> across <strong>${sections.length} section${sections.length !== 1 ? 's' : ''}</strong>.
        </div>
    </div>
</div>

<!-- CONTENT PAGES (filled by pagination engine below) -->
<div id="dynamic-content"></div>

<!-- BACK COVER -->
<div class="sheet cover" style="justify-content:flex-start;">
    <div class="cover-graphics">
        <div class="diag" style="background:linear-gradient(135deg,transparent 45%,rgba(252,203,0,0.08) 45%,rgba(252,203,0,0.08) 55%,transparent 55%);"></div>
    </div>
    <div class="cover-inner" style="justify-content:space-between;">
        <div>
            <h1 style="color:white;font-size:44px;margin-bottom:8px;">KAERI EDTECH</h1>
            <p style="color:#ddd;font-weight:300;font-size:16px;">Empowering Learners Through Smart Educational Technology</p>
        </div>
        <div style="background:rgba(255,255,255,0.05);border-left:5px solid var(--yellow);padding:22px;border-radius:8px;">
            <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap;">
                <div style="flex:1;">
                    <div style="font-size:10px;font-weight:800;color:var(--yellow);letter-spacing:1px;margin-bottom:8px;">CALL / WHATSAPP</div>
                    <div style="font-size:22px;font-weight:800;color:white;margin-bottom:3px;">096-100-5406</div>
                    <div style="font-size:22px;font-weight:800;color:white;margin-bottom:18px;">096-431-2504</div>
                    <div style="font-size:10px;font-weight:800;color:var(--yellow);letter-spacing:1px;margin-bottom:4px;">FOLLOW OUR WHATSAPP CHANNEL</div>
                    <div style="font-size:11px;color:#aaa;">Scan to join the official Kaeri EdTech community.</div>
                </div>
                <img src="${qrUrl}" style="width:110px;height:110px;border:2px solid white;border-radius:8px;">
            </div>
        </div>
        <div style="font-size:10px;color:#aaa;line-height:1.7;border-top:1px solid #333;padding-top:16px;">
            <strong>Document:</strong> ${course} · ${identity.name} · ${termLabel} · ${sessInfo.title}<br>
            <strong>Generated:</strong> ${date} &nbsp;&nbsp;
            <strong>&copy; 2026 Kaeri EdTech. All rights reserved.</strong>
        </div>
    </div>
</div>

<!-- PAGINATION ENGINE: measures every card before placing it -->
<script>
(function(){
    const MM=3.7795275591,PAGE_H=297*MM,TOP=32*MM,BOT=27*MM,SIDE=14*MM,BUF=22;
    const CONTENT_H=PAGE_H-TOP-BOT-BUF, CONTENT_W=(210-14-14)*MM, GAP=10;
    const root=document.getElementById('dynamic-content');
    const sb=document.createElement('div');
    sb.style.cssText='position:fixed;top:-9999px;left:-9999px;width:'+CONTENT_W+'px;visibility:hidden;pointer-events:none;font-family:Inter,Arial,sans-serif;';
    document.body.appendChild(sb);

    const TYPE=${JSON.stringify(sessionType)};
    const COURSE=${JSON.stringify(course)};
    const TERM=${JSON.stringify(termLabel)};
    const SESS_TITLE=${JSON.stringify(sessInfo.title)};
    const SECS=${sectionsJSON};

    let pageCount=2;

    function measure(el){
        sb.innerHTML='';
        const cl=el.cloneNode(true);
        sb.appendChild(cl);
        const st=window.getComputedStyle(cl);
        return cl.offsetHeight+(parseFloat(st.marginTop)||0)+(parseFloat(st.marginBottom)||0);
    }

    function newPage(){
        pageCount++;
        const sheet=document.createElement('div');
        sheet.className='sheet';
        sheet.innerHTML=
            '<div class="pg-header"><span class="brand">KAERI EDTECH</span>'+
            '<span class="meta">'+COURSE+' \xB7 '+TERM+' \xB7 '+SESS_TITLE+'</span></div>'+
            '<div class="pg-footer"><span>\u00A9 2026 Kaeri EdTech</span>'+
            '<span class="pg-num">Page '+pageCount+'</span></div>'+
            '<div class="pg-content" id="pg-'+pageCount+'"></div>';
        root.appendChild(sheet);
        return {el:sheet.querySelector('#pg-'+pageCount),used:0};
    }

    function place(el,state,gap){
        gap=(gap===undefined)?GAP:gap;
        const h=measure(el),g=state.used>0?gap:0;
        if(state.used+h+g>CONTENT_H) state=newPage();
        if(state.used>0){const sp=document.createElement('div');sp.style.height=GAP+'px';state.el.appendChild(sp);}
        state.el.appendChild(el);
        state.used+=h+(state.used>0?GAP:0);
        return state;
    }

    function banner(sec){
        const d=document.createElement('div');
        d.style.cssText='background:'+sec.pal.bg+';color:'+sec.pal.acc+';padding:8px 14px;'+
            'border-left:6px solid '+sec.pal.acc+';display:flex;align-items:center;'+
            'font-weight:700;font-size:12px;font-family:Inter,Arial,sans-serif;'+
            'page-break-inside:avoid;break-inside:avoid;';
        d.textContent='SECTION '+sec.num+' \xB7 '+sec.name.toUpperCase();
        return d;
    }

    function cardEl(item,secName,idx,pal){
        const acc=pal.acc;
        let lbl='',qH='',aH='',eH='';
        function md(t){
            if(!t)return'';
            return t.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
                     .replace(/__(.*?)__/g,'<u>$1</u>')
                     .replace(/\n/g,'<br>');
        }
        if(TYPE==='mcq'){
            lbl='Q'+(idx+1);
            qH=md(item.q||'');
            const o=(item.options&&item.options[item.correct]!==undefined)
                ?String.fromCharCode(65+item.correct)+'. '+md(item.options[item.correct]):'—';
            aH='<strong>Answer:</strong> '+o;
            eH=md(item.explanation||'No additional explanation.');
        } else if(TYPE==='shortAnswer'){
            lbl='Q'+(idx+1);
            qH=md(item.q||'');
            aH='<strong>Keywords:</strong> '+(item.keywords||[]).join(', ');
            eH=md(item.explanation||'No additional explanation.');
        } else if(TYPE==='essay'){
            lbl='Step '+(idx+1);
            qH=md(item.q||'');
            const o=(item.options&&item.options[item.correct]!==undefined)
                ?String.fromCharCode(65+item.correct)+'. '+md(item.options[item.correct]):'—';
            aH='<strong>Correct:</strong> '+o;
            eH=md(item.explanation||'No additional explanation.');
        } else {
            lbl='Card '+(idx+1);
            qH=md(item.front||'');
            aH=md(item.back||'');
            eH='';
        }
        const d=document.createElement('div');
        d.innerHTML='<div style="border:1px solid #ddd;border-left:5px solid '+acc+
            ';border-radius:6px;background:#fff;padding:13px 15px;'+
            'box-shadow:0 2px 5px rgba(0,0,0,0.05);page-break-inside:avoid;break-inside:avoid;">'+
            '<div style="font-size:10px;font-weight:800;color:'+acc+';letter-spacing:0.5px;margin-bottom:3px;text-transform:uppercase;">'+lbl+'</div>'+
            '<div style="font-size:9px;font-weight:600;color:'+acc+';text-transform:uppercase;letter-spacing:0.3px;margin-bottom:5px;">'+secName+'</div>'+
            '<div style="font-size:13px;font-weight:700;color:#111435;margin-bottom:9px;line-height:1.4;">'+qH+'</div>'+
            '<div style="font-size:12px;font-weight:500;color:#1e3a2f;background:#f0faf4;padding:6px 10px;border-radius:4px;margin-bottom:6px;">'+aH+'</div>'+
            (eH?'<div style="background:#f9f9f9;padding:6px 10px;font-size:11px;color:#333;line-height:1.45;border-left:4px solid '+acc+';border-radius:0 4px 4px 0;">'+
            '<span style="font-weight:800;color:'+acc+';text-transform:uppercase;font-size:10px;margin-right:4px;">EXPLANATION</span>'+eH+'</div>':'')+
            '</div>';
        return d.firstElementChild;
    }

    function build(){
        SECS.forEach(function(sec){
            var state=newPage();
            state=place(banner(sec),state,0);
            sec.items.forEach(function(item,idx){
                state=place(cardEl(item,sec.name,idx,sec.pal),state,10);
            });
        });
    }

    if(document.fonts&&document.fonts.ready) document.fonts.ready.then(build);
    else window.addEventListener('load',build);
})();
</script>
</body>
</html>`;
}

// ── IN-APP PREVIEW (no cover — clean scannable list) ─────────────────────
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
            SECTION ${s.num} · ${s.name.toUpperCase()}
        </div>`;
        s.items.forEach((item, idx) => {
            previewHTML += `<div style="margin-bottom:8px;">${_itemCardHTML(item, s.name, currentQuizType, idx, s.pal)}</div>`;
        });
    });

    previewHTML += `
        <div style="margin-top:18px;padding-top:10px;border-top:1px solid #ddd;text-align:center;font-size:7.5pt;color:#888;">
            Study smarter with Kaeri EdTech &mdash; 📞 096-100-5406 &nbsp;|&nbsp; 096-431-2504
        </div>
    </div>`;

    // Store for proceedToPrint
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

// ── PROCEED TO PRINT (full branded A4 in hidden iframe) ───────────────────
function proceedToPrint() {
    if (!printContentData) return;
    closePrintPreview();

    const { sections, date, course, term, sessionType } = printContentData;
    const fullHTML = _buildFullPrintDocument(course, term, sessionType, sections, date);

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:210mm;height:297mm;border:none;visibility:hidden;';
    document.body.appendChild(iframe);

    const iDoc = iframe.contentDocument || iframe.contentWindow.document;
    iDoc.open();
    iDoc.write(fullHTML);
    iDoc.close();

    // KaTeX inside iframe (physics/maths courses)
    if (typeof renderMathInElement === 'function') {
        try {
            renderMathInElement(iDoc.body, {
                delimiters: [
                    { left: '$$', right: '$$', display: true  },
                    { left: '$',  right: '$',  display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true  },
                ],
                throwOnError: false,
            });
        } catch(e) { console.warn('KaTeX in print iframe:', e); }
    }

    // 1200ms: fonts load + pagination engine runs before print dialog opens
    setTimeout(() => {
        try { iframe.contentWindow.focus(); iframe.contentWindow.print(); }
        catch(e) { console.warn('Print failed:', e); }
        setTimeout(() => { if (iframe.parentNode) document.body.removeChild(iframe); }, 3000);
    }, 1200);
}

function closePrintPreview() {
    const modal = document.getElementById('print-preview-modal');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = 'auto';
}

// ============================================================
// === 10. UTILITIES ===
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

// ============================================================
// === 11. TEXT-TO-SPEECH (SMART HUMAN ENGINE) ===
// ============================================================

const ttsMap = [
    { r: /\\alpha/g, s: "alpha" }, { r: /\\beta/g, s: "beta" }, { r: /\\gamma/g, s: "gamma" },
    { r: /\\theta/g, s: "theta" }, { r: /\\lambda/g, s: "lambda" }, { r: /\\pi/g, s: "pi" },
    { r: /\\Delta/g, s: "Delta" }, { r: /\\mu/g, s: "mew" }, { r: /\\sigma/g, s: "sigma" },
    { r: /\\therefore/g, s: "therefore" }, { r: /\\exists/g, s: "there exists" },
    { r: /\\forall/g, s: "for all" }, { r: /\\in/g, s: "is an element of" },
    { r: /\\cup/g, s: "union" }, { r: /\\cap/g, s: "intersection" },
    { r: /\\sin/g, s: "sine" }, { r: /\\cos/g, s: "cosine" }, { r: /\\tan/g, s: "tangent" },
    { r: /\\int/g, s: "the integral of" }, { r: /\\sum/g, s: "the sum of" },
    { r: /dy\/dx/g, s: "d y d x" }, { r: /\\lim/g, s: "the limit" }, { r: /\\to/g, s: "approaches" },
    { r: /\\frac\{1\}\{2\}/g, s: "one half" },
    { r: /\\frac\{(.+?)\}\{(.+?)\}/g, s: "$1 over $2" },
    { r: /\^2/g, s: " squared" }, { r: /\^3/g, s: " cubed" },
    { r: /\^\{(.+?)\}/g, s: " to the power of $1" },
    { r: /\\sqrt\{(.+?)\}/g, s: "the square root of $1" },
    { r: /\\vec\{(.+?)\}/g, s: "vector $1" },
    { r: /\\approx/g, s: "is approximately" }, { r: /\\neq/g, s: "is not equal to" },
    { r: /\\leq/g, s: "less or equal" }, { r: /\\geq/g, s: "greater or equal" },
    { r: /\\times/g, s: "times" }, { r: /\\div/g, s: "divided by" }, { r: /\\cdot/g, s: "dot" },
    { r: /\\ce\{(.+?)\}/g, s: "$1" }, { r: /->/g, s: "yields" },
    { r: /\*\*/g, s: "" }, { r: /__/g, s: "" }, { r: /#/g, s: "" }, { r: />/g, s: "" },
    { r: /\\text\{(.+?)\}/g, s: "$1" }, { r: /\$\$/g, s: "" }, { r: /\$/g, s: "" }, { r: /\\/g, s: "" }
];

function humanizeLaTeX(text) {
    let cleanText = text;
    ttsMap.forEach(map => { cleanText = cleanText.replace(map.r, map.s); });
    return cleanText.replace(/\s+/g, ' ').trim();
}

let utterance = null;
function updateTtsButtonText() {
    const ttsButton = document.getElementById('tts-toggle-button');
    if (ttsButton) ttsButton.textContent = ttsEnabled ? '🔊 Turn Reader Off' : '🔇 Turn Reader On';
}

function toggleTTS() {
    ttsEnabled = !ttsEnabled;
    localStorage.setItem("ttsEnabled", ttsEnabled);
    stopReading();
    updateTtsButtonText();
    showAppNotification(ttsEnabled ? "🔊 Reader is now ON." : "🔇 Reader is now OFF.");
    logAnalyticsEvent('tts_toggle', ttsEnabled ? 'ON' : 'OFF');
}

function stopReading() {
    if (utterance) { window.speechSynthesis.cancel(); utterance = null; }
}

function readText(text) {
    if (!ttsEnabled) return;
    stopReading();
    utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
}

function readCurrentQuestion() {
    if (!ttsEnabled) return;
    stopReading();
    let textToRead = "";
    if (currentQuizType === 'mcq' || currentQuizType === 'shortAnswer') {
        const qData = currentQuizData[currentQuestionIndex];
        textToRead += "Question " + (currentQuestionIndex + 1) + ". " + humanizeLaTeX(qData.q) + ". ";
        if (qData.options) {
            textToRead += "Options are: ";
            qData.options.forEach((opt, i) => {
                textToRead += String.fromCharCode(65 + i) + ". " + humanizeLaTeX(opt) + ". ... ";
            });
        }
    } else if (currentQuizType === 'essay') {
        const step = currentEssay.steps[currentStepIndex];
        textToRead += "Step " + (currentStepIndex + 1) + ". " + humanizeLaTeX(step.q) + ". ";
        step.options.forEach((opt, i) => {
            textToRead += String.fromCharCode(65 + i) + ". " + humanizeLaTeX(opt) + ". ... ";
        });
    }
    readText(textToRead);
}

function readFlashcard() {
    if (!ttsEnabled) return;
    stopReading();
    const card = currentFlashcards[currentCardIndex];
    readText(isCardFront ? "Front: " + humanizeLaTeX(card.front) : "Back: " + humanizeLaTeX(card.back));
}

// ============================================================
// === 12. GLOBAL EVENT HANDLERS & STUDENT BOARD ===
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

document.addEventListener("keydown", (e) => {
    if ((e.key === 'u' || e.key === 'U') && currentCourse && !hasFullAccess) {
        e.preventDefault();
        openPaymentModal();
        return; 
    }
    
    if (!currentQuizType) return;
    
    if (currentQuizType === "mcq" || currentQuizType === "essay") {
        const options = document.querySelectorAll('input[type="radio"]');
        const selected = document.querySelector('input[type="radio"]:checked');
        let index = Array.from(options).indexOf(selected);
        switch (e.key) {
            case "ArrowDown": case "ArrowRight":
                if (options.length) { index = (index + 1) % options.length; options[index].checked = true; } break;
            case "ArrowUp": case "ArrowLeft":
                if (options.length) { index = (index - 1 + options.length) % options.length; options[index].checked = true; } break;
            case "1": case "a": case "A": if (options[0]) options[0].checked = true; break;
            case "2": case "b": case "B": if (options[1]) options[1].checked = true; break;
            case "3": case "c": case "C": if (options[2]) options[2].checked = true; break;
            case "4": case "d": case "D": if (options[3]) options[3].checked = true; break;
            case "Enter":
                if (currentQuizType === "mcq") checkMcqAnswer();
                if (currentQuizType === "essay") checkEssayStep();
                break;
            case " ": case "n": case "N":
                const nextBtn = document.querySelector("#result button");
                if (nextBtn) nextBtn.click();
                break;
        }
    }
    
    if (currentQuizType === "shortAnswer" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault(); 
        checkShortAnswer();
    }
    
    if (currentQuizType === "flashcard") {
        if (e.key === " " || e.key === "Enter") {
             e.preventDefault(); // Stop scrolling
             if (isCardFront) flipCard();
             else if (currentFlashcardMode === 'linear') flipCard(); // Allow flip back in linear
        }

        if (currentFlashcardMode === 'linear') {
            // Linear Shortcuts
            if (e.key === "ArrowLeft") prevFlashcard();
            if (e.key === "ArrowRight") nextFlashcard();
        } else {
            // SRS Shortcuts (Only when answer shown)
            if (!isCardFront) {
                if (e.key === "1") rateCard(0);
                if (e.key === "2") rateCard(3);
                if (e.key === "3") rateCard(4);
                if (e.key === "4") rateCard(5);
            }
        }
    }
    
    if (e.key === "Escape") {
        closePaymentModal();
        closePrintPreview();
        closeDocViewer();
    }
});

document.addEventListener('DOMContentLoaded', function() {
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