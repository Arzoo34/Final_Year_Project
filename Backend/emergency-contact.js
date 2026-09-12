// ============================================================
//  MineGuard Pro — emergency-contact.js
//  Admin Emergency Call & SMS Forwarding
//  Uses Twilio if configured, falls back to simulated mode
// ============================================================
'use strict';

const ADMIN_PHONE   = process.env.ADMIN_PHONE   || '';
const ADMIN_NAME    = process.env.ADMIN_NAME    || 'Mine Safety Manager';
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL   || '';
const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID  || '';
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN   || '';
const TWILIO_FROM   = process.env.TWILIO_FROM_NUMBER  || '';

// Call log stored in memory (also broadcast via WS)
const callLog = [];

// ── Format phone number display ──────────────────────────────
function maskPhone(phone) {
  if (!phone || phone.length < 6) return '***';
  return phone.slice(0, 3) + '****' + phone.slice(-3);
}

// ── Send SMS via Twilio (or simulate) ────────────────────────
async function sendSMS(to, message) {
  const entry = {
    id: `sms-${Date.now()}`,
    type: 'sms',
    to: maskPhone(to),
    toRaw: to,
    message: message.slice(0, 160),
    status: 'pending',
    timestamp: new Date().toISOString(),
  };
  callLog.unshift(entry);
  if (callLog.length > 50) callLog.length = 50;

  if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) {
    try {
      const fetch = require('node-fetch');
      const body = new URLSearchParams({
        To: to,
        From: TWILIO_FROM,
        Body: message,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          },
          body: body.toString(),
        }
      );
      const data = await res.json();
      if (res.ok) {
        entry.status = 'sent';
        entry.sid = data.sid;
        console.log(`[SMS] ✅ Sent to ${maskPhone(to)}: "${message.slice(0, 50)}..."`);
      } else {
        entry.status = 'failed';
        entry.error = data.message || 'Twilio error';
        console.error(`[SMS] ❌ Failed: ${entry.error}`);
      }
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
      console.error(`[SMS] ❌ Error: ${err.message}`);
    }
  } else {
    // Simulated mode
    entry.status = 'simulated';
    console.log(`[SMS SIMULATED] → ${maskPhone(to)}: ${message}`);
    console.log('  ⚠  To enable real SMS: add TWILIO_* keys to backend/.env');
  }
  return entry;
}

// ── Trigger voice call via Twilio (or simulate) ──────────────
async function triggerCall(to, alertMessage) {
  const entry = {
    id: `call-${Date.now()}`,
    type: 'call',
    to: maskPhone(to),
    toRaw: to,
    message: alertMessage,
    status: 'pending',
    timestamp: new Date().toISOString(),
    adminName: ADMIN_NAME,
  };
  callLog.unshift(entry);
  if (callLog.length > 50) callLog.length = 50;

  if (TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) {
    try {
      const fetch = require('node-fetch');
      // TwiML voice message
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice" language="en-IN">
    MINE GUARD EMERGENCY ALERT.
    This is an automated call from Mine Guard Pro Safety System.
    ${alertMessage.replace(/[<>&]/g, ' ')}
    This call was triggered automatically due to a critical safety event.
    Please check the Mine Guard dashboard immediately.
    Repeating: ${alertMessage.replace(/[<>&]/g, ' ')}.
  </Say>
  <Pause length="2"/>
  <Say voice="alice">End of alert. Goodbye.</Say>
</Response>`;

      const body = new URLSearchParams({
        To: to,
        From: TWILIO_FROM,
        Twiml: twiml,
      });

      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          },
          body: body.toString(),
        }
      );
      const data = await res.json();
      if (res.ok) {
        entry.status = 'calling';
        entry.sid = data.sid;
        console.log(`[CALL] ✅ Calling ${maskPhone(to)} — SID: ${data.sid}`);
      } else {
        entry.status = 'failed';
        entry.error = data.message || 'Twilio error';
        console.error(`[CALL] ❌ Failed: ${entry.error}`);
      }
    } catch (err) {
      entry.status = 'error';
      entry.error = err.message;
      console.error(`[CALL] ❌ Error: ${err.message}`);
    }
  } else {
    entry.status = 'simulated';
    console.log(`[CALL SIMULATED] → ${maskPhone(to)}`);
    console.log(`  Message: ${alertMessage}`);
    console.log('  ⚠  To enable real calls: add TWILIO_* keys to backend/.env');
  }
  return entry;
}

// ── Auto-alert admin when emergency occurs ───────────────────
async function notifyAdmin(alert, workers) {
  if (!ADMIN_PHONE) {
    console.warn('[Emergency Contact] ADMIN_PHONE not set in .env — skipping notification');
    return null;
  }

  const emergencyWorkers = workers ? workers.filter(w => w.status === 'emergency') : [];
  const workerNames = emergencyWorkers.map(w => w.name).join(', ') || 'Unknown';
  const zones = [...new Set(emergencyWorkers.map(w => w.zone))].join(', ') || 'Unknown Zone';

  const smsText = `🚨 MINEGUARD EMERGENCY: ${alert.title}. ${alert.desc || ''}. Workers: ${workerNames}. Zone: ${zones}. CHECK DASHBOARD NOW.`;
  const callText = `Emergency alert from Mine Guard Pro. ${alert.title}. Workers ${workerNames} in ${zones} require immediate assistance. Please check your dashboard.`;

  const results = {};

  // Always send SMS for critical/emergency
  if (alert.level === 'emergency' || alert.level === 'critical') {
    results.sms = await sendSMS(ADMIN_PHONE, smsText);
  }

  // Only call admin for true emergencies (panic, fire, gas critical)
  if (alert.level === 'emergency') {
    results.call = await triggerCall(ADMIN_PHONE, callText);
  }

  return results;
}

// ── Get call log ─────────────────────────────────────────────
function getCallLog() { return callLog; }

// ── Config info (safe to expose to dashboard) ────────────────
function getAdminConfig() {
  return {
    adminName: ADMIN_NAME,
    adminPhone: maskPhone(ADMIN_PHONE),
    adminEmail: ADMIN_EMAIL,
    twilioConfigured: !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM),
    mode: (TWILIO_SID && TWILIO_TOKEN) ? 'live' : 'simulated',
  };
}

module.exports = { sendSMS, triggerCall, notifyAdmin, getCallLog, getAdminConfig, ADMIN_PHONE };
