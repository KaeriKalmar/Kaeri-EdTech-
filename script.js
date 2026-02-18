// ============================================================
// === KAERI EDTECH QUIZ ENGINE - HYBRID MASTER (v11.0 SRS + SMART LAYOUT) ===
// === Server-Side Access + Local Content + Doc Delivery + KaTeX + Smart TTS + Markdown ===
// ============================================================

// --- CONFIGURATION & STATE ---
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxhbrFtkTCj-6ZmnY0xmGjwxIq8YoP3mHEghVbEb4ZnVn_sKoCL_VI3CdsjEjibnGIFbQ/exec";
const PAYMENT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz2g3G6nxVlUW3afcHFpvKY360Qd-XoAKkJ7Jz20pznebDrpBHGKjgkhgC4DMXijnN_/exec";

let ttsEnabled = false;
let printContentData = null;
let hasFullAccess = false;
let currentPrice = 15;
let isSubmissionLocked = false; 

// --- DATA CONTAINERS ---
let allMcqData = [], allShortData = [], allEssayData = [], allFlashcards = {};
let currentMcqData = [], currentShortData = [], currentEssayData = [], currentFlashcardTopics = {};

// --- SESSION CONTEXT ---
let currentCourse = null, currentTerm = null, currentTermKey = null;
let currentQuizType = null, currentQuestionIndex = 0, currentScore = 0, currentQuizData = [];
let currentEssay = null, currentStepIndex = 0, essayScore = 0;
// Flashcard specific contexts
let currentFlashcardTopic = null, currentFlashcards = [], currentCardIndex = 0, isCardFront = true;
let srsQueue = []; // For storing the SRS study session

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
// === 3. DOCUMENT DELIVERY ENGINE ===
// ============================================================

function injectDocViewerHTML() {
    if (document.getElementById('smart-doc-viewer')) return;
    
    const viewerHTML = `
    <div id="smart-doc-viewer" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.95); z-index:9999; align-items:center; justify-content:center;">
        <div style="background:#1a1a2e; width:95%; height:95%; border-radius:15px; padding:20px; display:flex; flex-direction:column; box-shadow:0 10px 40px rgba(0,0,0,0.5); border:2px solid #72efdd;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; padding-bottom:10px; border-bottom:1px solid #3e506e;">
                <h3 id="viewer-title" style="color:white; margin:0; font-size:1.3em;">Document Viewer</h3>
                <button onclick="closeDocViewer()" style="background:#dc3545; color:white; border:none; padding:8px 20px; border-radius:8px; cursor:pointer; font-weight:bold;">✕ Close</button>
            </div>
            <iframe id="doc-frame" style="flex:1; width:100%; border:none; border-radius:8px; background:white;" allow="autoplay; fullscreen" allowfullscreen></iframe>
            <div style="margin-top:10px; text-align:center; color:#888; font-size:0.8em; padding-top:10px; border-top:1px solid #3e506e;">
                <small>Protected Content - Do not share links outside Kaeri EdTech</small>
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
    
    if (!viewer || !iframe) {
        injectDocViewerHTML();
        setTimeout(() => openDocumentViewer(fileId, title), 100);
        return;
    }
    
    titleEl.textContent = title || "Document";
    iframe.src = `https://drive.google.com/file/d/${fileId}/preview?usp=drivesdk`;
    viewer.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    logDocumentView(title, fileId);
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

function logDocumentView(title, fileId) {
    try {
        fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
                action: 'logEvent',
                data: {
                    email: hasFullAccess ? 'full_access' : 'demo',
                    action: 'view_document',
                    course: currentCourse,
                    term: currentTerm,
                    details: `Viewed: ${title}`,
                    userAgent: navigator.userAgent
                }
            })
        }).catch(() => {});
    } catch (e) {}
}

async function renderDocuments() {
    if (blockDemo('documents')) return; 

    const container = document.getElementById("quiz-form");
    container.innerHTML = `
        <div style="text-align:center; padding:40px;">
            <div style="border:4px solid #f3f3f3; border-top:4px solid #72efdd; border-radius:50%; width:40px; height:40px; animation:spin 1s linear infinite; margin:0 auto;"></div>
            <h3 style="color:#a0a8b4; margin-top:20px;">Connecting to Library...</h3>
        </div>`;
    document.getElementById("result").innerHTML = "";
    
    currentQuizType = 'documents'; 
    updateProgress(0, 0);

    try {
        const payload = JSON.stringify({
            action: 'GET_STUDENT_DOCS',
            payload: { course: currentCourse, term: currentTerm }
        });

        const response = await fetch(APPS_SCRIPT_URL, {
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
        html += `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:15px; padding:20px 0;">`;

        documents.forEach(doc => {
            const shortDesc = doc.description ? (doc.description.length > 80 ? doc.description.substring(0, 80) + '...' : doc.description) : '';
            html += `
            <div class="doc-card" onclick="openDocumentViewer('${doc.fileId}', '${doc.title.replace(/'/g, "\\'")}')" style="background:#2b3a55; padding:15px; border-radius:10px; border-left:5px solid #28a745; cursor:pointer; transition:0.3s; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">
                <div style="font-size:0.7em; text-transform:uppercase; color:#28a745; font-weight:bold; letter-spacing:1px; margin-bottom:5px;">${doc.topic || 'General'}</div>
                <div style="font-size:1.1em; font-weight:bold; color:white; margin-bottom:8px; line-height:1.3;">${doc.title}</div>
                <div style="font-size:0.85em; color:#a0a8b4; margin-bottom:10px;">${shortDesc}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; border-top:1px solid #3e506e; padding-top:10px;">
                    <span style="background:#0d1b2a; padding:2px 8px; border-radius:4px; font-size:0.7em; color:#fff;">${doc.type || 'FILE'} • ${doc.size || 'Unknown'}</span>
                    <span style="color:#28a745; font-size:0.9em; font-weight:bold;">👁️ Open</span>
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
// === 4. SECURITY & AUTHENTICATION ===
// ============================================================

async function checkAccessStatus() {
    const storedToken = localStorage.getItem(`token_${currentTermKey}`);
    const storedExpiry = localStorage.getItem(`expiry_${currentTermKey}`);
    
    if (storedToken && storedExpiry && Date.now() < parseInt(storedExpiry)) {
        enableFullAccessUI();
        return;
    }
    enableDemoUI();
}

async function verifyCodeFromModal() {
    const userCode = document.getElementById('access-code-input').value.trim();
    if (!userCode) return alert("Please enter a code.");
    const userEmail = prompt("Enter the Email you used to pay:"); 
    if (!userEmail) return alert("Email required for verification.");

    let deviceFP = localStorage.getItem('device_fp');
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
                action: 'validateAccess',
                code: userCode,
                email: userEmail,
                deviceFP: deviceFP,
                course: currentCourse,
                term: currentTerm
            })
        });

        const result = await response.json();

        if (result.success) {
            localStorage.setItem(`token_${currentTermKey}`, result.data.token || "VALID");
            localStorage.setItem(`expiry_${currentTermKey}`, result.data.expiry);
            closePaymentModal();
            enableFullAccessUI();
            showAppNotification("✅ " + result.message, "success");
        } else {
            showAppNotification("❌ " + result.message, "error");
        }
    } catch (e) {
        showAppNotification("⚠️ Connection Error. Check internet.", "error");
    }
}

function blockDemo(type) {
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
// === 5. UI & NAVIGATION ===
// ============================================================

function enableFullAccessUI() {
    hasFullAccess = true;
    updateModeBanner("✅ FULL ACCESS");
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

function closePaymentModal() {
    document.getElementById('payment-modal').classList.remove('show');
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
// === 6. QUIZ ENGINE (UPDATED FOR KaTeX & SMART TTS & MARKDOWN) ===
// ============================================================

function renderQuiz() {
    if (blockDemo('mcq')) return;
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    let q = shuffle([...currentMcqData]).slice(0, 10);
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
    
    const nextBtn = document.createElement("button");
    nextBtn.innerText = currentQuestionIndex < currentQuizData.length ? "Next ➡️" : "Finish Quiz";
    nextBtn.onclick = displayMcqQuestion;
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
}

function renderShortAnswers() {
    if (blockDemo('shortAnswer')) return;
    const container = document.getElementById("quiz-form");
    container.innerHTML = "";
    document.getElementById("result").innerHTML = "";
    let q = shuffle([...currentShortData]).slice(0, 10);
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
    
    const nextBtn = document.createElement("button");
    nextBtn.innerText = currentQuestionIndex < currentQuizData.length ? "Next ➡️" : "Finish";
    nextBtn.onclick = displayShortAnswerQuestion;
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
    
    const nextBtn = document.createElement("button");
    nextBtn.innerText = currentStepIndex < essay.steps.length - 1 ? "Next ➡️" : "Finish";
    nextBtn.onclick = () => {
        if (currentStepIndex < essay.steps.length - 1) {
            currentStepIndex++;
            showEssayStep(currentStepIndex); 
        } else {
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
}

// ============================================================
// === SRS ENGINE (SPACED REPETITION - SM-2 ALGORITHM) ===
// ============================================================

const SRS_KEY_PREFIX = "kaeri_srs_v1_";

// 1. Get SRS Data for a specific card
function getCardSRS(topic, cardIndex) {
    const key = `${SRS_KEY_PREFIX}${currentTermKey}`;
    const allData = JSON.parse(localStorage.getItem(key) || "{}");
    
    // Structure: { "TopicName": { "0": { interval: 1, reps: 0, ef: 2.5, dueDate: 1715000... } } }
    if (!allData[topic]) allData[topic] = {};
    
    // Default 'New Card' state
    return allData[topic][cardIndex] || { 
        interval: 0, 
        repetition: 0, 
        efactor: 2.5, 
        dueDate: 0, // 0 means "New/Unseen"
        isNew: true
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
    
    // Reset if "Again" (Forgot)
    if (quality < 3) {
        card.repetition = 0;
        card.interval = 1; // Review tomorrow
    } else {
        // Successful recall (Quality 3, 4, or 5)
        
        if (card.repetition === 0) {
            // --- NEW: JUMP START LOGIC ---
            // If it's the FIRST time, trust the user's rating
            switch(quality) {
                case 3: card.interval = 2; break; // Hard -> 2 days
                case 4: card.interval = 4; break; // Good -> 4 days
                case 5: card.interval = 7; break; // Easy -> 7 days
                default: card.interval = 1;
            }
        } else if (card.repetition === 1) {
            // Second time seeing it successfully
            // If it was easy before, jump further, otherwise standard 6
            card.interval = (card.interval >= 6) ? Math.round(card.interval * card.efactor) : 6;
        } else {
            // Standard SM-2 Multiplier
            card.interval = Math.round(card.interval * card.efactor);
        }
        
        card.repetition += 1;
    }

    // Update E-Factor (Easiness Factor)
    // The previous formula was standard, this one is slightly more forgiving
    card.efactor = card.efactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (card.efactor < 1.3) card.efactor = 1.3;

    // Calculate Due Date (Now + Interval in Days)
    const now = new Date();
    // Add days to current time
    card.dueDate = now.setDate(now.getDate() + card.interval);
    card.isNew = false;

    saveCardSRS(topic, cardIndex, card);
    return card;
}
// ============================================================
// === FLASHCARD ENGINE (UPDATED WITH SRS & SMART LAYOUT) ===
// ============================================================

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
    startFlashcards(topic);
}

function startFlashcards(topic) {
    currentFlashcardTopic = topic;
    const allCards = currentFlashcardTopics[topic];
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

    srsQueue.sort((a, b) => a.srsData.dueDate - b.srsData.dueDate);

    currentFlashcards = srsQueue; 
    currentCardIndex = 0;
    isCardFront = true;

    if (currentFlashcards.length === 0) {
        const container = document.getElementById("quiz-form");
        container.innerHTML = `
        <div style="text-align: center;">
            <h2>🎉 Caught Up!</h2>
            <p>You have no cards due for review right now.</p>
            <p>Check back tomorrow or start another topic.</p>
            <button class="restart-button" onclick="renderFlashcardTopics()">Back to Topics</button>
        </div>`;
        return;
    }

    displayFlashcard();
}

function displayFlashcard() {
    const container = document.getElementById("quiz-form");
    
    if (currentCardIndex >= currentFlashcards.length) {
        return showFlashcardCompletion();
    }

    const cardObj = currentFlashcards[currentCardIndex]; 
    updateProgress(currentCardIndex + 1, currentFlashcards.length);
    
    // --- SMART LAYOUT ANALYZER ---
    function getLayoutClass(text) {
        const hasBlockMath = /\$\$|\\\[/.test(text);
        const hasList = /^- /m.test(text) || /<ul>|<ol>|<li>/.test(parseKaeriMarkdown(text));
        const isLong = text.length > 120;

        if (hasBlockMath || hasList || isLong) {
            return "layout-detailed";
        }
        return "layout-center";
    }

    const frontLayout = getLayoutClass(cardObj.front);
    const backLayout = getLayoutClass(cardObj.back);

    let html = `
        <h3>🧠 SRS Study: ${currentFlashcardTopic} (${currentCardIndex + 1} / ${currentFlashcards.length})</h3>
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

    // SRS CONTROLS
    html += `<div class="flashcard-nav-buttons" style="margin-top: 20px;">`;

    if (isCardFront) {
        html += `<button onclick="flipCard()" style="width:100%; background:#007bff; color:white;">🔄 Show Answer</button>`;
    } else {
        html += `
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:8px; width:100%;">
                <button onclick="rateCard(0)" style="background:#dc3545; font-size:0.8em; padding:12px 2px; border-radius:6px;">❌ Again<br><small style="opacity:0.7">1d</small></button>
                <button onclick="rateCard(3)" style="background:#ffc107; color:#333; font-size:0.8em; padding:12px 2px; border-radius:6px;">😬 Hard<br><small style="opacity:0.7">2d</small></button>
                <button onclick="rateCard(4)" style="background:#28a745; font-size:0.8em; padding:12px 2px; border-radius:6px;">✅ Good<br><small style="opacity:0.7">4d</small></button>
                <button onclick="rateCard(5)" style="background:#17a2b8; font-size:0.8em; padding:12px 2px; border-radius:6px;">🚀 Easy<br><small style="opacity:0.7">7d</small></button>
            </div>
        `;
    }
    
    html += `</div>`;
    html += `<button class="back-to-topics-button" onclick="renderFlashcardTopics()">⬅️ Back to Topics</button>`;

    container.innerHTML = html;
    
    renderMath();
    container.scrollIntoView({ behavior: "smooth" });
    readFlashcard();
}

function flipCard() { 
    isCardFront = !isCardFront; 
    displayFlashcard(); 
}

function rateCard(quality) {
    const cardObj = currentFlashcards[currentCardIndex];
    const result = calculateNextReview(currentFlashcardTopic, cardObj.originalIndex, quality);
    showAppNotification(`Scheduled for: ${Math.round(result.interval)} days`, "info", 1000);
    currentCardIndex++;
    isCardFront = true;
    displayFlashcard();
}

function showFlashcardCompletion() {
    const container = document.getElementById("quiz-form");
    container.innerHTML = `
        <div style="text-align: center;">
            <h2>Session Complete!</h2>
            <p>You have reviewed all due cards for "<strong>${currentFlashcardTopic}</strong>".</p>
        </div>
    `;
    updateProgress(currentFlashcards.length, currentFlashcards.length);

    const backBtn = document.createElement("button");
    backBtn.innerText = "⬅️ Back to Topics";
    backBtn.className = "back-button";
    backBtn.onclick = renderFlashcardTopics;
    container.appendChild(backBtn);
}

// ============================================================
// === 7. SMART FEATURES & PRINT ===
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

function generatePrintPreview() {
    const printDiv = document.getElementById("print-preview-content");
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    
    let modeTitle = "";
    if (currentQuizType === 'essay') modeTitle = currentEssay.title;
    else if (currentQuizType === 'flashcard') modeTitle = currentFlashcardTopic + " - Glossary";
    else modeTitle = `${currentCourse} ${currentTerm} - Practice Session`;
    
    let html = `
        <div class="preview-header">
            <h1>${modeTitle}</h1>
            <p><strong>Kaeri EdTech Study Systems</strong></p>
            <p>📞 Call/WhatsApp: <strong>0964312504</strong> for Full Access</p>
            <p style="font-size: 0.9em; border-top: 1px solid #ccc; padding-top: 5px; margin-top: 5px;">
                Generated on: ${date} | Preview - Click Print to save as PDF
            </p>
            <div style="background: #fff3cd; padding: 10px; border-radius: 5px; margin-top: 10px; border: 1px solid #ffeaa7; font-size: 0.9em;">
                <strong>💡 Tip:</strong> Use "Save as PDF" option in print dialog to create digital copy. Watermark will appear on all pages.
            </div>
        </div>
    `;
    
    if (currentQuizType === 'essay') {
        currentEssay.steps.forEach((step, index) => {
            html += `<div class="preview-step"><div class="preview-q">Step ${index + 1}: ${parseKaeriMarkdown(step.q)}</div><div class="preview-ans">✅ Correct Action: ${parseKaeriMarkdown(step.options[step.correct])}</div><div class="preview-exp">💡 Note: ${parseKaeriMarkdown(step.explanation || "No additional explanation.")}</div></div>`;
        });
    } else if (currentQuizType === 'mcq') {
        currentQuizData.forEach((item, index) => {
            html += `<div class="preview-step"><div class="preview-q">Q${index + 1}: ${parseKaeriMarkdown(item.q)}</div><div class="preview-ans">✅ Answer: ${parseKaeriMarkdown(item.options[item.correct])}</div><div class="preview-exp">💡 Explanation: ${parseKaeriMarkdown(item.explanation || "No additional explanation.")}</div></div>`;
        });
    } else if (currentQuizType === 'shortAnswer') {
        currentQuizData.forEach((item, index) => {
            html += `<div class="preview-step"><div class="preview-q">Q${index + 1}: ${parseKaeriMarkdown(item.q)}</div><div class="preview-ans">🔑 Required Keywords: ${item.keywords.join(", ")}</div><div class="preview-exp">💡 Explanation: ${parseKaeriMarkdown(item.explanation || "No additional explanation.")}</div></div>`;
        });
    } else if (currentQuizType === 'flashcard') {
        currentFlashcards.forEach((card, index) => {
            html += `<div class="preview-step" style="border-left-color: #6f42c1;"><div class="preview-q" style="color: #333; font-size: 1.1em;">${index + 1}. ${parseKaeriMarkdown(card.front)}</div><div class="preview-ans" style="color: #6f42c1; border-left-color: #6f42c1;">Definition:</div><div style="margin-top:5px; padding: 8px; background: #f8f9fa; border-radius: 4px;">${parseKaeriMarkdown(card.back)}</div></div>`;
        });
    }
    
    html += `<div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 0.9em; color: #666;"><p>Study smarter with Kaeri EdTech. Contact 0964312504 for full access.</p></div>`;
    
    printContentData = { html: html.replace(/preview-/g, 'pdf-') };
    printDiv.innerHTML = html;

    renderMath('print-preview-content');
    document.getElementById('print-preview-modal').classList.add('show');
    document.body.style.overflow = 'hidden';
}

function proceedToPrint() {
    closePrintPreview();
    setTimeout(() => {
        const printDiv = document.getElementById("printable-summary");
        printDiv.innerHTML = printContentData.html;
        renderMath('printable-summary');
        const style = document.createElement('style');
        style.innerHTML = `@page { margin: 20mm; size: A4; }`;
        printDiv.appendChild(style);
        window.print();
        setTimeout(() => { printDiv.innerHTML = ''; }, 1000);
    }, 300);
}

function closePrintPreview() {
    document.getElementById('print-preview-modal').classList.remove('show');
    document.body.style.overflow = 'auto';
}

// ============================================================
// === 8. UTILITIES ===
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
// === 9. TEXT-TO-SPEECH (SMART HUMAN ENGINE) ===
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
// === 10. GLOBAL EVENT HANDLERS & STUDENT BOARD ===
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
             if(isCardFront) flipCard();
        }
        if (!isCardFront) {
            if (e.key === "1") rateCard(0);
            if (e.key === "2") rateCard(3);
            if (e.key === "3") rateCard(4);
            if (e.key === "4") rateCard(5);
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
