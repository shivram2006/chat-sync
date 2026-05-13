/* ═══════════════════════════════════════════════
   StudyFlow — app.js
   Hidden encrypted realtime chat + study planner
   Changes:
   - No auto-hide timer
   - Browser notifications on new message
   - Messages saved to localStorage (24hr)
   - Offline message delivery on reconnect
   ═══════════════════════════════════════════════ */

'use strict';

/* ── ENCRYPTION ─────────────────────────────── */
const _K = 'sp!@#2k24$hidden$chat$nova$2006!xZ';

function encrypt(plaintext) {
  return CryptoJS.AES.encrypt(plaintext, _K).toString();
}

function decrypt(ciphertext) {
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, _K);
    return bytes.toString(CryptoJS.enc.Utf8) || null;
  } catch { return null; }
}

/* ── SESSION ID ─────────────────────────────── */
const SESSION_ID = (() => {
  let id = sessionStorage.getItem('sp-session-id');
  if (!id) { id = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('sp-session-id', id); }
  return id;
})();

/* ── SECRET COMMANDS ─────────────────────────── */
const CMD_OPEN  = '2006';
const CMD_HIDE  = '0000';
const CMD_CLEAR = '1999';

/* ── MESSAGE STORAGE (localStorage, 24hr TTL) ── */
const MSG_KEY    = 'sp-messages';
const MSG_TTL_MS = 86400 * 1000; // 24 hours

function saveMessages(msgs) {
  try { localStorage.setItem(MSG_KEY, JSON.stringify(msgs)); } catch {}
}

function loadMessages() {
  try {
    const raw = localStorage.getItem(MSG_KEY);
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    const now  = Date.now();
    // Filter out messages older than 24 hours
    return msgs.filter(m => now - m.ts < MSG_TTL_MS);
  } catch { return []; }
}

function addToStorage(text, isSelf, ts) {
  const msgs = loadMessages();
  msgs.push({ text, isSelf, ts: ts || Date.now() });
  saveMessages(msgs);
}

function clearStorage() {
  localStorage.removeItem(MSG_KEY);
}

/* ── BROWSER NOTIFICATIONS ───────────────────── */
let notifPermission = 'default';

async function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    notifPermission = 'granted';
    return;
  }
  if (Notification.permission !== 'denied') {
    const result = await Notification.requestPermission();
    notifPermission = result;
  } else {
    notifPermission = Notification.permission;
  }
}

function sendNotification(text) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  // Only notify if tab is hidden or chat is closed
  if (!document.hidden && chatOpen) return;

  try {
    const n = new Notification('Task Reminder', {
      body: text.length > 60 ? text.slice(0, 60) + '...' : text,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📚</text></svg>",
      badge: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔔</text></svg>",
      tag: 'studyflow-reminder',
      silent: false,
    });

    // Click notification → open/focus tab and show chat
    n.onclick = () => {
      window.focus();
      if (!chatOpen) openChat();
      n.close();
    };

    // Auto close after 5 seconds
    setTimeout(() => n.close(), 5000);
  } catch {}
}

/* ── STATE ──────────────────────────────────── */
let chatOpen  = false;
let ws        = null;
let typingTimer = null;
let isTyping  = false;
let taskCount = 0;

/* ══════════════════════════════════════════════
   STUDY PLANNER UI
   ══════════════════════════════════════════════ */

function initDateBadge() {
  const el  = document.getElementById('dateBadge');
  const now = new Date();
  el.textContent = now.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' });
}

function initGreeting() {
  const h  = new Date().getHours();
  const el = document.getElementById('timeOfDay');
  el.textContent = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

const QUOTES = [
  '"The secret of getting ahead is getting started."',
  '"Success is the sum of small efforts repeated day in and day out."',
  '"Don\'t wish it were easier. Wish you were better."',
  '"Focus on being productive instead of busy."',
  '"Push yourself, because no one else is going to do it for you."',
  '"Great things never come from comfort zones."',
  '"Study hard, for the well is deep and our brains are shallow."',
];

function initQuote() {
  document.getElementById('quoteText').textContent =
    QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function initTheme() {
  const btn  = document.getElementById('themeToggle');
  const icon = document.getElementById('themeIcon');
  const html = document.documentElement;
  const saved = localStorage.getItem('sp-theme') || 'dark';
  html.setAttribute('data-theme', saved);
  icon.textContent = saved === 'dark' ? '🌙' : '☀️';
  btn.addEventListener('click', () => {
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    icon.textContent = next === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('sp-theme', next);
  });
}

/* ── POMODORO ───────────────────────────────── */
let pomoRunning = false, pomoTotal = 25*60, pomoLeft = 25*60;
let pomoInterval = null, pomoSession = 1;

function formatTime(s) {
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function updatePomoDisplay() {
  document.getElementById('pomoTime').textContent = formatTime(pomoLeft);
  document.getElementById('pomoBar').style.width = ((pomoTotal-pomoLeft)/pomoTotal*100)+'%';
}

function stopPomo() {
  clearInterval(pomoInterval); pomoRunning = false;
  document.getElementById('pomoToggle').textContent = 'Start';
}

function startPomo() {
  pomoRunning = true;
  document.getElementById('pomoToggle').textContent = 'Pause';
  pomoInterval = setInterval(() => {
    if (pomoLeft <= 0) {
      stopPomo(); showToast('🍅 Focus session complete!');
      pomoSession = pomoSession < 4 ? pomoSession+1 : 1;
      document.getElementById('pomoSession').textContent = `Session ${pomoSession} of 4`;
      return;
    }
    pomoLeft--; updatePomoDisplay();
  }, 1000);
}

function initPomodoro() {
  document.getElementById('pomoToggle').addEventListener('click', () => pomoRunning ? stopPomo() : startPomo());
  document.getElementById('pomoReset').addEventListener('click', () => { stopPomo(); pomoLeft=pomoTotal; updatePomoDisplay(); });
  document.getElementById('pomoSkip').addEventListener('click', () => { stopPomo(); pomoLeft=0; updatePomoDisplay(); });
  document.querySelectorAll('.pomo-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.pomo-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      stopPomo(); pomoTotal = parseInt(tab.dataset.mins)*60; pomoLeft = pomoTotal;
      document.getElementById('pomoBar').style.width = '0%';
      updatePomoDisplay();
    });
  });
  updatePomoDisplay();
}

/* ── GOALS ──────────────────────────────────── */
function updateGoals() {
  const checks = document.querySelectorAll('.goal-check');
  let done = 0;
  checks.forEach(c => { if (c.checked) done++; });
  document.getElementById('goalCount').textContent = `${done}/${checks.length}`;
  const pct = Math.round((done/checks.length)*100);
  document.getElementById('dailyPct').textContent = pct+'%';
  const circumference = 2*Math.PI*50;
  document.getElementById('dailyRing').style.strokeDashoffset = circumference-(pct/100)*circumference;
}

function injectSVGGradient() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const defs  = document.createElementNS(svgNS,'defs');
  const grad  = document.createElementNS(svgNS,'linearGradient');
  grad.setAttribute('id','ringGrad'); grad.setAttribute('x1','0%'); grad.setAttribute('y1','0%');
  grad.setAttribute('x2','100%'); grad.setAttribute('y2','100%');
  const s1 = document.createElementNS(svgNS,'stop'); s1.setAttribute('offset','0%'); s1.setAttribute('stop-color','#6c8bef');
  const s2 = document.createElementNS(svgNS,'stop'); s2.setAttribute('offset','100%'); s2.setAttribute('stop-color','#a78bfa');
  grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad);
  document.querySelector('.progress-ring').prepend(defs);
}

/* ── TASKS ──────────────────────────────────── */
function escapeHtml(text) {
  const d = document.createElement('div'); d.textContent = text; return d.innerHTML;
}

function addTask(text) {
  const list  = document.getElementById('taskList');
  const empty = list.querySelector('.task-empty');
  if (empty) empty.remove();
  const item  = document.createElement('div');
  item.className = 'task-item';
  item.innerHTML = `
    <input type="checkbox" class="task-item-check" onchange="this.nextElementSibling.style.textDecoration=this.checked?'line-through':'none'">
    <span class="task-item-text">${escapeHtml(text)}</span>
    <button class="task-item-del" onclick="this.parentElement.remove();updateTaskBadge();">✕</button>`;
  list.appendChild(item);
  updateTaskBadge();
}

function updateTaskBadge() {
  const count = document.querySelectorAll('.task-item').length;
  document.getElementById('taskBadge').textContent = count === 0 ? '0 tasks' : `${count} task${count>1?'s':''}`;
}

function initTaskInput() {
  const input = document.getElementById('taskInput');
  const btn   = document.getElementById('taskAddBtn');

  function handleInput() {
    const val = input.value.trim();
    if (!val) return;
    if (val === CMD_OPEN)  { input.value = ''; openChat(); return; }
    if (val === CMD_HIDE)  { input.value = ''; closeChat(true); return; }
    if (val === CMD_CLEAR) { input.value = ''; clearMessages(); return; }
    addTask(val);
    input.value = '';
    showToast('✅ Task added successfully');
  }

  btn.addEventListener('click', handleInput);
  input.addEventListener('keydown', e => { if (e.key==='Enter') handleInput(); });
}

/* ── NOTES ──────────────────────────────────── */
function initNotes() {
  const area  = document.getElementById('notesArea');
  const chars = document.getElementById('noteChars');
  const saved = document.getElementById('notesSaved');
  const stored = sessionStorage.getItem('sp-notes') || '';
  area.value = stored; chars.textContent = stored.length+' chars';
  let saveTimer;
  area.addEventListener('input', () => {
    chars.textContent = area.value.length+' chars';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      sessionStorage.setItem('sp-notes', area.value);
      saved.textContent = 'Saved'; setTimeout(()=>{ saved.textContent=''; },1500);
    }, 800);
  });
  document.getElementById('clearNotes').addEventListener('click', () => {
    area.value=''; chars.textContent='0 chars'; sessionStorage.removeItem('sp-notes');
    showToast('📝 Notes cleared');
  });
}

/* ── TOAST ──────────────────────────────────── */
const FAKE_NOTIFS = ['Study Reminder Updated','Pomodoro Session Logged','Daily Goal Synced','Notes Auto-Saved','Focus Streak: 3 sessions!'];

function showToast(msg) {
  const toast = document.getElementById('toastNotif');
  document.getElementById('toastText').textContent = msg;
  toast.classList.add('show');
  setTimeout(()=> toast.classList.remove('show'), 3000);
}

function startFakeNotifs() {
  [9000,25000,55000].forEach(d => setTimeout(()=>{
    if (!chatOpen) showToast('🔔 '+FAKE_NOTIFS[Math.floor(Math.random()*FAKE_NOTIFS.length)]);
  }, d));
}

/* ══════════════════════════════════════════════
   HIDDEN CHAT
   ══════════════════════════════════════════════ */

/* ── WEBSOCKET ──────────────────────────────── */
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}/ws/study/`);

  ws.onopen = () => { setConnectStatus(true); };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'system') {
        const dot = document.getElementById('chatStatusDot');
        dot.className = data.count >= 2 ? 'chat-status-dot online' : 'chat-status-dot';
        return;
      }

      if (data.type === 'message') {
        const plain = decrypt(data.message);
        if (!plain) return;

        // Skip typing signals from display
        if (plain.startsWith('__TYPING__'))     { if (!data.is_self) showTyping(); return; }
        if (plain.startsWith('__STOPTYPING__')) { if (!data.is_self) hideTyping(); return; }

        // Don't show own messages again (already shown on send)
        if (data.is_self) return;

        // Determine timestamp
        const ts = data.timestamp ? data.timestamp * 1000 : Date.now();

        // Save to localStorage
        addToStorage(plain, false, ts);

        // Show in UI
        appendMessageDOM(plain, false, ts, data.queued);

        // Browser notification (whether chat is open or not)
        sendNotification(plain);

        // If chat is closed, also show toast
        if (!chatOpen) showToast('🔔 New Task Reminder');
      }
    } catch {}
  };

  ws.onclose = (e) => {
    setConnectStatus(false);
    ws = null;
    if (e.code === 4001) {
      appendSystemNote('⚠ Session full. Only 2 users allowed.');
    }
  };

  ws.onerror = () => { setConnectStatus(false); };
}

function setConnectStatus(connected) {
  const bar  = document.getElementById('chatConnectBar');
  const text = document.getElementById('connectText');
  bar.classList.toggle('connected', connected);
  text.textContent = connected ? 'Secure channel active' : 'Reconnecting...';
}

/* ── SEND ───────────────────────────────────── */
function sendMessage(plain) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!plain.trim()) return;

  const cipher = encrypt(plain.trim());
  ws.send(JSON.stringify({ message: cipher, sender_id: SESSION_ID }));

  // Save own message
  addToStorage(plain.trim(), true, Date.now());

  // Show immediately
  appendMessageDOM(plain.trim(), true, Date.now(), false);
}

/* ── TYPING ─────────────────────────────────── */
function sendTypingSignal(typing) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ message: encrypt(typing ? '__TYPING__' : '__STOPTYPING__'), sender_id: SESSION_ID }));
}

function showTyping() {
  const el = document.getElementById('typingIndicator');
  el.classList.add('show');
  clearTimeout(typingTimer);
  typingTimer = setTimeout(hideTyping, 3000);
}

function hideTyping() {
  document.getElementById('typingIndicator').classList.remove('show');
}

/* ── MESSAGES DOM ───────────────────────────── */
function appendMessageDOM(text, isSelf, ts, queued) {
  const msgs  = document.getElementById('chatMessages');
  const noMsg = document.getElementById('chatNoMsg');
  if (noMsg) noMsg.remove();

  const d    = new Date(ts || Date.now());
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${isSelf ? 'self' : 'other'}`;
  bubble.innerHTML = `
    <div>${escapeHtml(text)}</div>
    <div class="msg-time">${queued ? '📬 ' : ''}${time}</div>`;
  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendSystemNote(text) {
  const msgs = document.getElementById('chatMessages');
  const el   = document.createElement('div');
  el.style.cssText = 'text-align:center;font-size:11px;color:var(--text-3);padding:6px 0;font-family:var(--mono)';
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
}

/* ── LOAD SAVED MESSAGES ────────────────────── */
function loadSavedMessages() {
  const msgs = loadMessages();
  if (!msgs.length) return;

  const container = document.getElementById('chatMessages');
  const noMsg     = document.getElementById('chatNoMsg');
  if (noMsg) noMsg.remove();

  // Day separator
  const sep = document.createElement('div');
  sep.style.cssText = 'text-align:center;font-size:10px;color:var(--text-3);padding:4px 0 8px;font-family:var(--mono)';
  sep.textContent = '— saved messages —';
  container.appendChild(sep);

  msgs.forEach(m => appendMessageDOM(m.text, m.isSelf, m.ts, false));
}

function clearMessages() {
  const msgs = document.getElementById('chatMessages');
  msgs.innerHTML = `
    <div class="chat-no-msg" id="chatNoMsg">
      <div class="no-msg-icon">🔐</div>
      <p>Secure channel active</p>
      <small>Messages cleared</small>
    </div>`;
  clearStorage();
  showToast('🔔 Study Reminder Updated');
}

/* ── OPEN / CLOSE CHAT ──────────────────────── */
function openChat() {
  chatOpen = true;

  // Request notification permission on first open
  requestNotifPermission();

  document.getElementById('chatOverlay').classList.add('active');
  document.getElementById('app').classList.add('blurred');

  setTimeout(() => document.getElementById('chatInput').focus(), 400);

  // Connect WebSocket (also triggers offline queue delivery from server)
  connectWebSocket();

  // Load stored messages from localStorage
  loadSavedMessages();
}

function closeChat(emergency = false) {
  chatOpen = false;

  const overlay = document.getElementById('chatOverlay');
  const app     = document.getElementById('app');
  const panel   = document.getElementById('chatPanel');

  if (emergency) {
    panel.classList.add('emergency-hide');
    setTimeout(() => {
      overlay.classList.remove('active');
      app.classList.remove('blurred');
      panel.classList.remove('emergency-hide');
    }, 300);
  } else {
    overlay.classList.remove('active');
    app.classList.remove('blurred');
  }

  // Keep WS alive so offline messages keep queuing on server
  // (Don't disconnect — stay connected for incoming msgs)

  // Clear messages from DOM only (not from localStorage)
  const msgs = document.getElementById('chatMessages');
  msgs.innerHTML = `
    <div class="chat-no-msg" id="chatNoMsg">
      <div class="no-msg-icon">🔐</div>
      <p>Secure channel active</p>
      <small>Messages disappear on close</small>
    </div>`;

  document.getElementById('chatStatusDot').className = 'chat-status-dot';
  showToast('🔔 Study Reminder Updated');
}

/* ── CHAT INPUT ─────────────────────────────── */
function initChatInput() {
  const input = document.getElementById('chatInput');
  const btn   = document.getElementById('chatSendBtn');

  function handleSend() {
    const val = input.value.trim();
    if (!val) return;
    if (val === CMD_HIDE)  { input.value = ''; closeChat(true); return; }
    if (val === CMD_CLEAR) { input.value = ''; clearMessages(); return; }
    sendMessage(val);
    input.value = '';
    sendTypingSignal(false);
    isTyping = false;
  }

  btn.addEventListener('click', handleSend);
  input.addEventListener('keydown', e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }});

  let typingDebounce;
  input.addEventListener('input', () => {
    if (!isTyping && input.value.length > 0) { isTyping=true; sendTypingSignal(true); }
    clearTimeout(typingDebounce);
    typingDebounce = setTimeout(() => {
      if (isTyping) { isTyping=false; sendTypingSignal(false); }
    }, 1500);
    if (input.value.length===0 && isTyping) { isTyping=false; sendTypingSignal(false); }
  });

  document.getElementById('chatCloseBtn').addEventListener('click', () => closeChat(false));
}

/* ── ESC TO HIDE ────────────────────────────── */
document.addEventListener('keydown', e => { if (e.key==='Escape' && chatOpen) closeChat(true); });

/* ── BACKGROUND WS CONNECTION ───────────────── */
// Keep WebSocket alive even when chat is closed
// So server can queue incoming messages and we get notified
function initBackgroundConnection() {
  // Connect in background after 2 seconds
  setTimeout(() => {
    if (!ws) connectWebSocket();
  }, 2000);

  // Reconnect if connection drops
  setInterval(() => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectWebSocket();
    }
  }, 5000);
}

/* ══════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  injectSVGGradient();
  initDateBadge();
  initGreeting();
  initQuote();
  initTheme();
  initPomodoro();
  initTaskInput();
  initNotes();
  initChatInput();
  updateGoals();
  startFakeNotifs();
  initBackgroundConnection(); // stay connected in background for notifications
});
