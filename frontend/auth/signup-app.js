/**
 * SafeMine — Supabase email/password signup (load after frontend/utils/api.js).
 */
'use strict';

const form = document.getElementById('signup-form');
const errEl = document.getElementById('auth-error');
const hintEl = document.getElementById('auth-hint');
const submitBtn = document.getElementById('auth-submit');

function setError(msg) {
  if (errEl) errEl.textContent = msg || '';
}

async function init() {
  if (!window.SafeMineFetch || !window.SafeMineAuth) {
    if (hintEl) hintEl.textContent = 'Missing api.js — open this page from the SafeMine server (e.g. http://localhost:3001/signup.html).';
    if (form) form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    return;
  }

  let cfg;
  try {
    const r = await fetch(window.SafeMineFetch.url('/auth/public-config'));
    cfg = await r.json();
  } catch (e) {
    if (hintEl) hintEl.textContent = 'Could not reach the backend. Start the server and open this page from the same origin.';
    return;
  }

  if (!cfg.supabaseConfigured) {
    if (hintEl) {
      hintEl.innerHTML =
        'Supabase is not configured. Add <code>SUPABASE_URL</code>, <code>SUPABASE_ANON_KEY</code>, and <code>SUPABASE_JWT_SECRET</code> to <code>backend/.env</code>, then restart.';
    }
    if (form) form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    return;
  }

  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const redirect = new URL('index.html', window.location.href).href;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('');
    const name = document.getElementById('name')?.value?.trim() || '';
    const email = document.getElementById('email')?.value?.trim() || '';
    const password = document.getElementById('password')?.value || '';
    const password2 = document.getElementById('password2')?.value || '';
    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== password2) {
      setError('Passwords do not match.');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account…';
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name },
          emailRedirectTo: redirect,
        },
      });
      if (error) {
        setError(error.message);
        return;
      }
      if (data.session) {
        const exp = data.session.expires_at;
        localStorage.setItem(window.SafeMineAuth.SESSION_KEY, JSON.stringify({
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token,
          expires_at: typeof exp === 'number' ? exp : Number(exp) || null,
        }));
        window.location.href = './index.html';
        return;
      }
      setError('');
      if (hintEl) {
        hintEl.innerHTML =
          '<strong>Check your email</strong> to confirm your account (if confirmation is enabled in Supabase). After confirming, you can <a href="login.html">sign in</a>.';
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create account';
    }
  });
}

init();
