/**
 * SafeMine — Supabase email/password login (load after frontend/utils/api.js).
 */
'use strict';

const form = document.getElementById('login-form');
const errEl = document.getElementById('auth-error');
const hintEl = document.getElementById('auth-hint');
const submitBtn = document.getElementById('auth-submit');

function setError(msg) {
  if (errEl) errEl.textContent = msg || '';
}

async function init() {
  if (!window.SafeMineFetch || !window.SafeMineAuth) {
    if (hintEl) hintEl.textContent = 'Missing api.js — open this page from the SafeMine server (e.g. http://localhost:3001/login.html).';
    if (form) form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    return;
  }

  let cfg;
  try {
    const r = await fetch(window.SafeMineFetch.url('/auth/public-config'));
    cfg = await r.json();
  } catch (e) {
    if (hintEl) hintEl.textContent = 'Could not reach the backend. Start the server from the project (npm start) and use the same host/port.';
    return;
  }

  if (!cfg.supabaseConfigured) {
    if (hintEl) {
      hintEl.innerHTML =
        'Supabase is not configured. Add <code>SUPABASE_URL</code>, <code>SUPABASE_ANON_KEY</code>, and <code>SUPABASE_JWT_SECRET</code> to <code>backend/.env</code>, set <code>AUTH_ENABLED=true</code>, then restart the server. See <code>backend/.env.example</code>.';
    }
    if (form) form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    return;
  }

  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('');
    const email = document.getElementById('email')?.value?.trim() || '';
    const password = document.getElementById('password')?.value || '';
    if (!email || !password) {
      setError('Enter email and password.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      if (!data.session) {
        setError('No session returned. Confirm your email in Supabase if required.');
        return;
      }
      const exp = data.session.expires_at;
      localStorage.setItem(window.SafeMineAuth.SESSION_KEY, JSON.stringify({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: typeof exp === 'number' ? exp : Number(exp) || null,
      }));
      window.location.href = './index.html';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });
}

init();
