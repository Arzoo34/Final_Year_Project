# SafeMine Backend Services 🛡️

The **SafeMine Backend** is an event-driven Node.js & Express engine designed for real-time underground miner safety monitoring, IoT sensor data processing, sensor fusion alert detection, pathfinding optimization, and live telemetry streaming via WebSockets and MQTT.

---

## 🌟 Key Capabilities

- **Real-Time Telemetry Streaming**: Low-latency WebSocket server (`ws`) pushing live worker telemetry, gas levels, panic state, and anchor updates to the dashboard.
- **Embedded MQTT Broker**: Integrated [Aedes MQTT](https://github.com/moscajs/aedes) broker listening on `mqtt://localhost:1883` for direct hardware and LoRaWAN gateway communication.
- **Persistence Engine**: SQLite database using `sql.js` with automatic disk synchronization (`mineguard.db`).
- **Sensor Fusion & Escalation Engine**: Automated threshold monitoring (gas levels, fall detection, heart rate, panic button press) with multi-stage SOS alert escalations.
- **Evacuation Pathfinding & Optimization**: Dynamic path routing (`optimizer.js`) calculating hazard-avoiding evacuation routes for underground personnel.
- **AI Safety Assistant**: Groq API integration (Llama 3) for conversational AI safety queries, shift logs, and alert synthesis.
- **Flexible Authentication**: JWT-backed authentication with optional Supabase integration.

---

## 📁 Directory & Core Modules

```
backend/
├── server.js              # Core Express server, WebSocket engine, MQTT broker & API routes
├── db.js                  # sql.js database layer with file persistence (mineguard.db)
├── auth.js                # Auth router (JWT token issue & Supabase validation gate)
├── dummy-engine.js        # Internal telemetry generator (simulates 12 underground miners)
├── lora-gateway.js        # LoRaWAN gateway bridge and MQTT telemetry forwarder
├── esp32_simulator.js     # ESP32 hardware simulator for HTTP/MQTT telemetry testing
├── optimizer.js           # Dynamic hazard-avoidance pathfinding & zone risk calculations
├── o2Calculation.js       # Oxygen depletion and gas accumulation physics engine
├── emergency-contact.js   # Emergency SOS contact escalation & notification trigger
├── seed.js                # Database initialization script with realistic mock data
├── reset-db.js            # Database reset script
├── patch-gps.js           # Utilities for patching miner coordinates and anchor zones
└── .env.example           # Environment variables configuration template
```

---

## ⚙️ Configuration (`.env`)

Copy `.env.example` to `.env` inside the `backend/` directory to configure environment variables:

```bash
cp .env.example .env
```

### Key Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3001` | HTTP API & WebSocket server port |
| `MQTT_PORT` | `1883` | Aedes MQTT broker port |
| `DUMMY_MODE` | `true` | When `true`, automatically generates mock miner telemetry without requiring external hardware |
| `GROQ_API_KEY` | — | API key from [Groq Console](https://console.groq.com/keys) for AI Chat assistant capabilities |
| `AUTH_ENABLED` | `false` | Enables JWT authentication requirement on protected `/api/*` endpoints |
| `JWT_SECRET` | — | Secret key used to sign and verify SQLite JWT tokens |
| `ALERT_TTL_MS` | `60000` | De-duplication window for recurring sensor alerts |

---

## 🚀 Getting Started

### 1. Prerequisites

Ensure you have **Node.js** (v18 or higher) installed on your machine.

### 2. Install Dependencies

```bash
npm install
```

### 3. Initialize & Seed Database

Run the full setup command to reset, seed, and map default worker & anchor locations:

```bash
npm run demo-setup
```

### 4. Launch Server

**Production Mode:**
```bash
npm start
```

**Development Mode (Auto-restart on change):**
```bash
npm run dev
```

---

## 📡 Hardware & Firmware Integration (ESP32 / LoRa)

Hardware nodes (e.g., ESP32-powered Smart Helmets) can submit sensor telemetry via **HTTP POST** or **MQTT**:

### HTTP Telemetry Endpoint
`POST /api/telemetry`

```json
{
  "worker_id": "MNR-001",
  "heart_rate": 82,
  "spo2": 98,
  "gas_level": 12,
  "gas_type": "CH4",
  "temp": 28.5,
  "humidity": 65,
  "battery": 92,
  "panic": false,
  "fall_detected": false
}
```

### ESP32 Hardware Simulator
To test ESP32 hardware telemetry submission:
```bash
node esp32_simulator.js
```

### LoRaWAN Gateway Bridge
To run the LoRaWAN gateway MQTT bridge:
```bash
npm run lora
```

---

## 🛰️ Main API Endpoints Summary

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Backend status & system uptime health check |
| `GET` | `/api/workers` | Retrieve list of active workers and current telemetry |
| `GET` | `/api/anchors` | Retrieve underground Bluetooth / LoRa location anchors |
| `GET` | `/api/alerts` | Fetch active safety alerts and historical warnings |
| `POST` | `/api/telemetry` | Submit single sensor payload (from hardware or simulator) |
| `POST` | `/api/chat` | SafeMine AI Assistant query endpoint |
| `POST` | `/api/auth/login` | User authentication & JWT issuance |
| `POST` | `/api/auth/register` | Register new user account |

---

## 📜 Available NPM Scripts

- `npm start` – Run production backend server (`node server.js`).
- `npm run dev` – Run server with Nodemon auto-reload.
- `npm run seed` – Populate `mineguard.db` with demo workers, anchors, and emergency contacts.
- `npm run reset-db` – Reset SQLite database file to clean state.
- `npm run demo-setup` – Sequential run: Reset DB ➔ Seed Data ➔ Patch GPS.
- `npm run lora` – Run the LoRaWAN gateway bridge (`node lora-gateway.js`).
