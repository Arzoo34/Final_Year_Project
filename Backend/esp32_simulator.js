const http = require('http');

console.log('🚀 Starting ESP32 Simulator...');
console.log('📡 This script simulates the ESP32 hardware sending telemetry to the backend.');

const workerId = "MNR-001";
const serverHost = "localhost";
const serverPort = 3001;
const serverPath = "/api/telemetry";

function sendTelemetry() {
  const payload = JSON.stringify({
    worker_id: workerId,
    dht_status: "ok",
    mq2_status: "ok",
    mpu_status: "ok",
    bmp_status: "ok",
    device_status: "connected",
    timestamp: Date.now(),
    temp: 26.5 + (Math.random() * 2), // Simulate varying temp
    humidity: 50.0 + (Math.random() * 5),
    ch4: 1.2 + Math.random(),
    gas_raw: 300 + Math.floor(Math.random() * 50),
    o2: 20.8,
    o2_label: "SAFE",
    pressure: 1013.25,
    motion: "1",
    fall: "0",
    alert: "false",
    reason: ""
  });

  const options = {
    hostname: serverHost,
    port: serverPort,
    path: serverPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
         console.log(`[ESP32 Simulator] ✅ Sent payload for ${workerId}: Response code ${res.statusCode}`);
      } else {
         console.log(`[ESP32 Simulator] ❌ Failed: HTTP ${res.statusCode}`);
      }
    });
  });

  req.on('error', (e) => {
    console.error(`[ESP32 Simulator] ❌ Connection Failed: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// Send every 3 seconds, just like ESP32.ino SEND_INTERVAL = 3000
setInterval(sendTelemetry, 3000);
sendTelemetry(); // Initial send
