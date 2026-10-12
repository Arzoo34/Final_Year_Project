/**
 * SafeMine — Intro.js onboarding tour (first visit + restart).
 * Depends: intro.js (global introJs), navigateTo from app.js
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'safeMineTourSeen';
  const START_DELAY_MS = 900;

  function hasWorkerRows() {
    const tbody = document.getElementById('worker-tbody');
    if (!tbody) return false;
    return tbody.querySelectorAll('tr').length > 0;
  }

  function ensureDashboard() {
    if (typeof navigateTo === 'function') navigateTo('dashboard');
  }

  function buildSteps() {
    const workerIntro = hasWorkerRows()
      ? 'Live worker vitals, gas, risk, and status update in real time. Open Workers for full cards and actions.'
      : 'When your backend is online, miner rows appear here. Use the Workers page for detailed cards.';

    return [
      {
        intro: 'Welcome to SafeMine. Let’s take a quick tour.',
      },
      {
        element: document.querySelector('#page-dashboard'),
        intro: 'Your command overview: emergencies, critical counts, peak methane, risk, and network status.',
        position: 'bottom',
      },
      {
        element: document.querySelector('#safemine-tour-worker-table'),
        intro: workerIntro,
        position: 'top',
      },
      {
        element: document.querySelector('#safemine-tour-alerts-panel'),
        intro: 'Safety alerts stream here from helmets, gas thresholds, and system rules. Jump to Alerts for the full list.',
        position: 'left',
      },
      {
        element: document.querySelector('#topbar-marquee'),
        intro: 'The top bar stays in sync with live data: tracked miners, active alerts, and system health.',
        position: 'bottom',
      },
      {
        element: document.querySelector('[data-page="aiassist"]'),
        intro: 'AI Assistant answers questions using live mine context (when Groq is configured on the server).',
        position: 'right',
      },
      {
        intro: "You're all set! Stay safe.",
      },
    ].filter(function (step) {
      if (!step.element) return true;
      return !!step.element;
    });
  }

  const LAYOUT_SETTLE_MS = 160;

  /** Intro.js v7: introJs(). v8+: prefer introJs.tour() (introJs() is deprecated but still works). */
  function createIntroInstance() {
    if (typeof introJs === 'undefined') return null;
    if (typeof introJs.tour === 'function') return introJs.tour();
    if (typeof introJs === 'function') return introJs();
    return null;
  }

  function startTour() {
    ensureDashboard();

    window.requestAnimationFrame(function () {
      setTimeout(function () {
        const introFactory = createIntroInstance();
        if (!introFactory) {
          console.warn('[Tour] Intro.js not loaded — check script URL / network / ad blocker.');
          return;
        }

        const steps = buildSteps();
        if (steps.length < 2) {
          console.warn('[Tour] Missing tour targets (need #page-dashboard etc.)');
          return;
        }

        try {
          introFactory.setOptions({
            steps: steps,
            nextLabel: 'Next →',
            prevLabel: '← Back',
            doneLabel: 'Finish',
            skipLabel: 'Skip',
            scrollTo: 'element',
            scrollPadding: 48,
            showProgress: true,
            exitOnOverlayClick: false,
            disableInteraction: true,
            helperElementPadding: 6,
            overlayOpacity: 0.65,
          });

          const ret = introFactory.start();
          if (ret && typeof ret.then === 'function') {
            ret.catch(function (err) {
              console.error('[Tour] intro.start() failed:', err);
            });
          }
        } catch (err) {
          console.error('[Tour] Error:', err);
        }
      }, LAYOUT_SETTLE_MS);
    });
  }

  function scheduleFirstVisitTour() {
    if (localStorage.getItem(STORAGE_KEY)) return;
    setTimeout(function () {
      startTour();
      // Mark seen after scheduling so a failed load (e.g. blocked CDN) can retry on refresh
      localStorage.setItem(STORAGE_KEY, 'true');
    }, START_DELAY_MS);
  }

  window.startTour = startTour;

  window.addEventListener('load', function () {
    document.getElementById('tourBtn')?.addEventListener('click', function () {
      window.startTour();
    });
    scheduleFirstVisitTour();
  });
})();
