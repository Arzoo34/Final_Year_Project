// ============================================================
//  SafeMine — Floating help bot (Groq via /api/chat)
//  Answers questions about the dashboard, safety workflow, and live data
// ============================================================

'use strict';

(function () {
  const style = document.createElement('style');
  style.textContent = `
    #sm-bot-bubble {
      position: fixed; bottom: 28px; right: 28px;
      width: 54px; height: 54px; border-radius: 50%;
      background: linear-gradient(145deg, #0ea5e9, #0284c7);
      box-shadow: 0 4px 22px rgba(14,165,233,0.45);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; z-index: 9999;
      transition: transform 0.2s, box-shadow 0.2s;
      font-size: 22px; user-select: none;
      border: 1px solid rgba(255,255,255,0.15);
    }
    #sm-bot-bubble:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(14,165,233,0.55); }
    #sm-bot-bubble .sm-notif {
      position: absolute; top: -3px; right: -3px;
      width: 16px; height: 16px; border-radius: 50%;
      background: #ef4444; font-size: 9px; font-weight: 700;
      color: #fff; display: flex; align-items: center; justify-content: center;
    }
    #sm-bot-panel {
      position: fixed; bottom: 94px; right: 28px;
      width: 380px; max-height: min(560px, calc(100vh - 120px));
      height: 520px;
      background: #0b0f14; border: 1px solid rgba(14,165,233,0.35);
      border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,0.55);
      display: none; flex-direction: column;
      z-index: 9998; overflow: hidden;
      font-family: Inter, system-ui, -apple-system, sans-serif;
      animation: smSlideUp 0.25s ease;
    }
    @keyframes smSlideUp {
      from { transform: translateY(16px); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }
    #sm-bot-panel.open { display: flex; }
    .sm-bot-header {
      background: linear-gradient(135deg, #082f49, #0c4a6e);
      padding: 14px 16px; display: flex; align-items: center; gap: 10px;
      border-bottom: 1px solid rgba(14,165,233,0.2);
      flex-shrink: 0;
    }
    .sm-bot-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(14,165,233,0.2); border: 2px solid rgba(14,165,233,0.6);
      display: flex; align-items: center; justify-content: center; font-size: 18px;
    }
    .sm-bot-title { font-size: 14px; font-weight: 700; color: #f1f5f9; letter-spacing: -0.02em; }
    .sm-bot-status { font-size: 10px; color: #7dd3fc; margin-top: 2px; }
    .sm-bot-close {
      margin-left: auto; background: none; border: none;
      color: #64748b; font-size: 18px; cursor: pointer; padding: 0 4px;
      transition: color 0.2s;
    }
    .sm-bot-close:hover { color: #e2e8f0; }
    .sm-bot-log {
      flex: 1; overflow-y: auto; padding: 14px;
      display: flex; flex-direction: column; gap: 10px;
      scrollbar-width: thin; scrollbar-color: #1e3a4a transparent;
      min-height: 0;
    }
    .sm-bot-log::-webkit-scrollbar { width: 5px; }
    .sm-bot-log::-webkit-scrollbar-thumb { background: #1e3a4a; border-radius: 3px; }
    .sm-bot-msg { display: flex; gap: 8px; max-width: 94%; animation: smFade 0.22s ease; }
    @keyframes smFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }
    .sm-bot-msg.user { align-self: flex-end; flex-direction: row-reverse; }
    .sm-bot-msg-icon {
      width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; font-size: 13px;
    }
    .sm-bot-msg-icon.bot { background: rgba(14,165,233,0.15); border: 1px solid rgba(14,165,233,0.35); }
    .sm-bot-msg-icon.user { background: #1e293b; border: 1px solid #334155; }
    .sm-bot-msg-bubble {
      padding: 10px 13px; border-radius: 14px;
      font-size: 12.5px; line-height: 1.55; color: #cbd5e1;
    }
    .sm-bot-msg.bot .sm-bot-msg-bubble {
      background: #111827; border: 1px solid #1f2937; border-top-left-radius: 4px;
    }
    .sm-bot-msg.user .sm-bot-msg-bubble {
      background: #0c4a6e; border: 1px solid rgba(14,165,233,0.25);
      color: #f0f9ff; border-top-right-radius: 4px;
    }
    .sm-bot-typing { display: flex; gap: 4px; padding: 8px 12px; }
    .sm-bot-typing span {
      width: 6px; height: 6px; background: #38bdf8; border-radius: 50%;
      animation: smDot 1.2s infinite;
    }
    .sm-bot-typing span:nth-child(2) { animation-delay: 0.2s; }
    .sm-bot-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes smDot { 0%,60%,100% { opacity: 0.35; transform: scale(0.85); } 30% { opacity: 1; transform: scale(1.05); } }
    .sm-bot-chips {
      padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px;
      border-top: 1px solid #1e293b; flex-shrink: 0;
      max-height: 88px; overflow-y: auto;
    }
    .sm-bot-chip {
      background: #111827; border: 1px solid #1f2937;
      color: #94a3b8; font-size: 10.5px; padding: 5px 10px; border-radius: 20px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .sm-bot-chip:hover { border-color: #38bdf8; color: #7dd3fc; background: rgba(14,165,233,0.08); }
    .sm-bot-input-row {
      padding: 12px; display: flex; gap: 8px;
      border-top: 1px solid #1e293b; background: #070a0d;
      flex-shrink: 0;
    }
    .sm-bot-input {
      flex: 1; background: #111827; border: 1px solid #1f2937;
      color: #f1f5f9; padding: 9px 12px; border-radius: 10px;
      font-family: inherit; font-size: 12px; resize: none;
      height: 40px; outline: none; transition: border-color 0.2s;
    }
    .sm-bot-input:focus { border-color: #0ea5e9; }
    .sm-bot-send {
      background: #0ea5e9; border: none; color: #020617;
      width: 40px; height: 40px; border-radius: 10px; cursor: pointer;
      font-size: 16px; transition: filter 0.2s; flex-shrink: 0;
    }
    .sm-bot-send:hover { filter: brightness(1.08); }
    .sm-bot-send:disabled { opacity: 0.45; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  const html = `
    <div id="sm-bot-bubble" title="SafeMine assistant">
      ⛑
      <div class="sm-notif" id="sm-bot-notif" style="display:none">1</div>
    </div>
    <div id="sm-bot-panel">
      <div class="sm-bot-header">
        <div class="sm-bot-avatar">🤖</div>
        <div>
          <div class="sm-bot-title">SafeMine Assistant</div>
          <div class="sm-bot-status" id="sm-bot-status-text">● AI · Ask about this app</div>
        </div>
        <button type="button" class="sm-bot-close" id="sm-bot-close" aria-label="Close">✕</button>
      </div>
      <div class="sm-bot-log" id="sm-bot-log"></div>
      <div class="sm-bot-chips" id="sm-bot-chips">
        <span class="sm-bot-chip" data-q="Which workers are highest risk right now and what should I check?">⚠ Top risks</span>
        <span class="sm-bot-chip" data-q="What do CH4, CO, and O2 thresholds mean in SafeMine and when should I evacuate?">💨 Gas thresholds</span>
        <span class="sm-bot-chip" data-q="Explain the Dashboard, Workers page, Alerts, and Mine Map in simple terms.">📊 App tour</span>
        <span class="sm-bot-chip" data-q="What should the control room do when a worker presses SOS or a fall is detected?">🆘 SOS / fall</span>
        <span class="sm-bot-chip" data-q="How does helmet telemetry typically reach this system (MQTT, HTTP /api/telemetry)?">📡 Data flow</span>
        <span class="sm-bot-chip" data-q="Give a short checklist for a shift handover using the data shown in the UI.">📋 Handover</span>
      </div>
      <div class="sm-bot-input-row">
        <textarea class="sm-bot-input" id="sm-bot-input" placeholder="Ask about SafeMine, safety, or the screen you are on…" rows="1"></textarea>
        <button type="button" class="sm-bot-send" id="sm-bot-send">➤</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const BOT_HISTORY = [];
  let isOpen = false;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getAppContext() {
    try {
      const st = window.state;
      if (!st || !Array.isArray(st.workers)) {
        return 'UI state not loaded yet. Describe features using general SafeMine product knowledge; suggest refreshing if live counts are needed.';
      }
      const workers = st.workers;
      const alerts = st.alerts || [];
      const em = workers.filter(w => w.status === 'emergency').length;
      const crit = workers.filter(w => w.status === 'critical').length;
      const avg = workers.length
        ? (workers.reduce((a, w) => a + (Number(w.risk) || 0), 0) / workers.length).toFixed(1)
        : '0';
      const top = workers
        .slice()
        .sort((a, b) => (Number(b.risk) || 0) - (Number(a.risk) || 0))
        .slice(0, 6)
        .map(w => `${w.id} (${w.name}): risk ${w.risk}, ${w.zone}, CH4 ${(Number(w.ch4) || 0).toFixed(2)}%, CO ${w.co || 0}ppm, O2 ${w.o2 ?? '?'}%, status ${w.status}`)
        .join('\n');
      const alertLines = alerts.slice(0, 5).map(a => `[${a.level}] ${a.title}`).join('\n');
      return `
USER APP CONTEXT (SafeMine UI):
- Tracked workers: ${workers.length} | emergency: ${em} | critical: ${cr} | avg risk (0–10): ${avg}
- Alerts visible in UI: ${alerts.length}
- Backend online flag: ${st.backendOnline ? 'yes' : 'no'}
Top workers by risk:
${top || '(none)'}
Recent alert titles:
${alertLines || '(none)'}`;
    } catch {
      return 'Could not read UI state.';
    }
  }

  function appendMsg(role, text) {
    const log = document.getElementById('sm-bot-log');
    const div = document.createElement('div');
    div.className = `sm-bot-msg ${role}`;
    const safe = escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#f1f5f9">$1</strong>')
      .replace(/\n- /g, '\n• ')
      .replace(/\n/g, '<br>');
    div.innerHTML = `
      <div class="sm-bot-msg-icon ${role}">${role === 'bot' ? '🤖' : '👤'}</div>
      <div class="sm-bot-msg-bubble">${safe}</div>
    `;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (!isOpen && role === 'bot') {
      const n = document.getElementById('sm-bot-notif');
      if (n) n.style.display = 'flex';
    }
  }

  function showTyping() {
    const log = document.getElementById('sm-bot-log');
    const el = document.createElement('div');
    el.id = 'sm-typing';
    el.className = 'sm-bot-msg bot';
    el.innerHTML = `<div class="sm-bot-msg-icon bot">🤖</div><div class="sm-bot-msg-bubble sm-bot-typing"><span></span><span></span><span></span></div>`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function removeTyping() {
    document.getElementById('sm-typing')?.remove();
  }

  function setStatus(text) {
    const el = document.getElementById('sm-bot-status-text');
    if (el) el.textContent = text;
  }

  async function postChat(messages) {
    const ctx = getAppContext();
    const systemContext = `You are **SafeMine Assistant**, embedded in the SafeMine web app (underground mine worker safety, smart helmets, gas, alerts, map, evacuations).

Help operators use the application: explain screens, workflows, gas/risk concepts, and what to do in emergencies. Stay practical and concise (short paragraphs, bullet lists when useful).

When "USER APP CONTEXT" includes live worker/alert summaries, ground your answers in those numbers and names. If context says state is not loaded, say how to load live data (run backend, open dashboard from the server URL, use Refresh).

Do not claim to execute actions in the mine; you advise and explain the software and safety procedures.

${ctx}`;

    const res = await fetch(window.SafeMineFetch.url('/chat'), {
      method: 'POST',
      headers: window.SafeMineFetch.jsonHeaders(),
      body: JSON.stringify({ systemContext, messages }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const text = data.content?.map(c => c.text || '').join('') || 'No response.';
    return { text, provider: data.provider || 'ai' };
  }

  const bot = {
    toggle() {
      const panel = document.getElementById('sm-bot-panel');
      isOpen = !isOpen;
      panel.classList.toggle('open', isOpen);
      if (isOpen) {
        const n = document.getElementById('sm-bot-notif');
        if (n) n.style.display = 'none';
        document.getElementById('sm-bot-input')?.focus();
      }
    },

    handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    },

    ask(question) {
      const input = document.getElementById('sm-bot-input');
      if (input) input.value = question;
      this.send();
    },

    async send() {
      const input = document.getElementById('sm-bot-input');
      const msg = (input && input.value) ? input.value.trim() : '';
      if (!msg) return;
      input.value = '';

      if (!isOpen) this.toggle();

      appendMsg('user', msg);
      showTyping();

      const sendBtn = document.getElementById('sm-bot-send');
      sendBtn.disabled = true;
      setStatus('● Thinking…');

      BOT_HISTORY.push({ role: 'user', content: msg });
      if (BOT_HISTORY.length > 18) BOT_HISTORY.splice(0, 2);

      try {
        const { text: reply, provider } = await postChat(BOT_HISTORY.slice(-10));
        BOT_HISTORY.push({ role: 'assistant', content: reply });
        removeTyping();
        appendMsg('bot', reply);
        setStatus(provider === 'groq' ? '● Groq · Ready' : '● AI · Ready');
      } catch (err) {
        removeTyping();
        const keyHint = /api key|unauthorized|401|invalid.*key/i.test(String(err.message));
        const extra = keyHint
          ? 'Add **GROQ_API_KEY** to `backend/.env` (https://console.groq.com/keys), then restart the server.'
          : 'If this is a model error, set **GROQ_MODEL** in `backend/.env` or update the backend — see https://console.groq.com/docs/deprecations';
        appendMsg('bot', `⚠ ${err.message}\n\n${extra}`);
        setStatus('● Error — check Groq key');
      }

      sendBtn.disabled = false;
    },

    pushAlert(text) {
      appendMsg('bot', `🚨 **Live alert (broadcast):** ${text}`);
    },
  };

  document.getElementById('sm-bot-bubble').addEventListener('click', () => bot.toggle());
  document.getElementById('sm-bot-close').addEventListener('click', () => bot.toggle());
  document.getElementById('sm-bot-send').addEventListener('click', () => bot.send());
  document.getElementById('sm-bot-input').addEventListener('keydown', e => bot.handleKey(e));
  document.querySelectorAll('.sm-bot-chip').forEach(el => {
    el.addEventListener('click', () => bot.ask(el.getAttribute('data-q') || ''));
  });

  window.SafeMineBot = bot;
  window.TerraBot = bot;

  setTimeout(() => {
    appendMsg('bot', '👋 Hi — I’m the **SafeMine** assistant (powered by **Groq**). Ask how to use the dashboard, read gas/risk data, or respond to alerts. Quick chips below or type your own question.');
  }, 600);
})();
