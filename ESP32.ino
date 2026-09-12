#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <Wire.h>
#include <MPU6050.h>
#include <Adafruit_BMP085.h>

// ---------------- WIFI ----------------
const char* ssid = "GRAPHETHON 03";
const char* password = "12345678";

// ---------------- BACKEND ----------------
const char* serverName = "http://192.168.50.12:3001/api/telemetry";

// ---------------- WORKER ----------------
String workerId = "MNR-001";

// ---------------- PINS ----------------
#define DHTPIN 4
#define DHTTYPE DHT11
#define MQ2_PIN 34
#define BUZZER 25

// ---------------- LIMITS ----------------
#define TEMP_LIMIT 40
#define GAS_LIMIT 1200

// ---------------- O2 CALCULATION LIMITS ----------------
// Mirrors the logic in backend/o2Calculation.js
// Baseline atmospheric O2 in a mine tunnel (%)
#define O2_BASELINE       20.9
// Oxygen consumed per worker per cycle (%)
#define O2_DROP_PER_WORKER 0.12
// How much each 1% of CH4 gas displaces O2 (%)
#define O2_GAS_COEFFICIENT 1.2
// Clamp bounds for realistic mine O2 values
#define O2_MIN_BOUND      15.0
#define O2_MAX_BOUND      21.0
// Safety thresholds (OSHA / mining standards)
#define O2_DANGER_THRESHOLD  18.0   // Below: DANGER
#define O2_WARNING_THRESHOLD 19.5   // Below: WARNING, else SAFE

// Number of workers known to be active in this tunnel section.
// Update this value to reflect the actual deployment count,
// or receive it via a downlink MQTT/HTTP command in future.
#define KNOWN_WORKER_COUNT 12

#define MOTION_THRESHOLD 0.15
#define NO_MOTION_TIME 600000

#define SHOCK_THRESHOLD 3.0
#define TILT_THRESHOLD 0.3
#define IMPACT_WINDOW 5000

// ---------------- TIMING ----------------
#define SEND_INTERVAL 3000

// ---------------- O2 CALCULATION (mirrors backend/o2Calculation.js) ----------------
// Calculates estimated O2 level (%) from:
//   workerCount — active workers consuming oxygen by respiration
//   gasPercent  — MQ2/CH4 gas reading in % (0–5%)
// Returns: O2 % clamped to [O2_MIN_BOUND, O2_MAX_BOUND]
float calculateOxygenLevel(int workerCount, float gasPercent) {
  // Clamp inputs to safe ranges
  if (workerCount < 0) workerCount = 0;
  if (gasPercent  < 0) gasPercent  = 0.0;

  // Drop 1: Respiration — each worker consumes oxygen
  float workerDrop = workerCount * O2_DROP_PER_WORKER;
  if (workerDrop > 2.5) workerDrop = 2.5;  // cap at 2.5%

  // Drop 2: Gas displacement — CH4/flammable gas displaces O2
  float gasDrop = gasPercent * O2_GAS_COEFFICIENT;
  if (gasDrop > 4.0) gasDrop = 4.0;  // cap at 4.0%

  // Small noise (±0.05%) simulated via millis-based pseudo-random
  float noise = ((millis() % 100) / 1000.0) - 0.05;

  // Combine all factors
  float o2 = O2_BASELINE - workerDrop - gasDrop + noise;

  // Clamp to realistic mine bounds
  if (o2 < O2_MIN_BOUND) o2 = O2_MIN_BOUND;
  if (o2 > O2_MAX_BOUND) o2 = O2_MAX_BOUND;

  return o2;
}

// Returns O2 safety label as a string: "SAFE", "WARNING", or "DANGER"
String getO2Label(float o2) {
  if (o2 < O2_DANGER_THRESHOLD)  return "DANGER";
  if (o2 < O2_WARNING_THRESHOLD) return "WARNING";
  return "SAFE";
}

// ---------------- OBJECTS ----------------
DHT dht(DHTPIN, DHTTYPE);
MPU6050 mpu;
Adafruit_BMP085 bmp;

// ---------------- GLOBALS ----------------
unsigned long lastSendTime = 0;
unsigned long lastMotionTime = 0;
unsigned long impactTime = 0;
bool firstReading = true;

float prevX = 0, prevY = 0, prevZ = 0;
bool bmpAvailable = false;

// 🔔 BUZZER
unsigned long buzzerStartTime = 0;
bool buzzerActive = false;
bool lastAlertState = false;

// 📡 DEVICE STATUS
String deviceStatus = "connected";

// 📊 SENSOR STATUS
String dhtStatus = "ok";
String mq2Status = "ok";
String mpuStatus = "ok";
String bmpStatus = "ok";

// ⭐ PRESSURE TRACK
float prevPressure = 1013;

// ---------------- WIFI ----------------
void connectWiFi() {
  WiFi.begin(ssid, password);
  Serial.print("Connecting WiFi");

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(500);
    Serial.print(".");
    retry++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ Connected");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ WiFi Failed");
  }
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);

  pinMode(BUZZER, OUTPUT);
  digitalWrite(BUZZER, LOW);

  dht.begin();
  Wire.begin();
  mpu.initialize();

  if (bmp.begin()) {
    bmpAvailable = true;
    Serial.println("BMP180 OK");
  } else {
    bmpAvailable = false;
    Serial.println("BMP180 NOT FOUND");
  }

  connectWiFi();
  lastMotionTime = millis();
}

// ---------------- LOOP ----------------
void loop() {

  if (millis() - lastSendTime < SEND_INTERVAL) return;
  lastSendTime = millis();

  // -------- DEVICE STATUS --------
  deviceStatus = (WiFi.status() == WL_CONNECTED) ? "connected" : "disconnected";

  // -------- DHT --------
  float temp = dht.readTemperature();
  float hum  = dht.readHumidity();

  if (isnan(temp) || isnan(hum)) {
    dhtStatus = "fail";
  } else {
    dhtStatus = "ok";
  }

  // -------- MQ2 --------
  int gas = analogRead(MQ2_PIN);
  // Convert raw ADC reading to approximate CH4 % for backend
  float ch4 = gas / 10000.0;
  mq2Status = (gas >= 0) ? "ok" : "fail";

  // -------- O2 ESTIMATION (NEW — replaces static 20.9 fallback) --------
  // Uses on-device calculateOxygenLevel() which mirrors backend/o2Calculation.js
  // Inputs: known worker count in tunnel + current MQ2 CH4 % reading
  float o2 = calculateOxygenLevel(KNOWN_WORKER_COUNT, ch4);
  String o2Label = getO2Label(o2);

  // -------- BMP --------
  float pressure = 0;
  if (bmpAvailable) {
    pressure = bmp.readPressure() / 100.0;
    bmpStatus = "ok";
  } else {
    bmpStatus = "fail";
  }

  // -------- MPU --------
  int16_t ax, ay, az;
  mpu.getAcceleration(&ax, &ay, &az);
  mpuStatus = (ax == 0 && ay == 0 && az == 0) ? "fail" : "ok";

  float x = ax / 16384.0;
  float y = ay / 16384.0;
  float z = az / 16384.0;

  float delta = abs(x - prevX) + abs(y - prevY) + abs(z - prevZ);
  bool motion = (delta > MOTION_THRESHOLD);

  if (motion) lastMotionTime = millis();
  bool noMotion = (millis() - lastMotionTime > NO_MOTION_TIME);

  float magnitude = sqrt(x*x + y*y + z*z);
  bool shock = magnitude > SHOCK_THRESHOLD;
  bool tilt  = z < TILT_THRESHOLD;

  bool impact = false;
  if (shock && tilt) impactTime = millis();

  if (impactTime > 0 && millis() - impactTime < IMPACT_WINDOW && !motion) {
    impact = true;
  }

  prevX = x;
  prevY = y;
  prevZ = z;

  // -------- ALERT --------
  bool alert = false;
  String reason = "";

  if (temp > TEMP_LIMIT) { alert = true; reason += "TEMP "; }
  if (gas  > GAS_LIMIT)  { alert = true; reason += "GAS "; }
  if (noMotion)          { alert = true; reason += "NO_MOTION "; }
  if (impact)            { alert = true; reason += "IMPACT "; }

  // NEW: O2 danger alert — trigger buzzer and log if O2 below 18%
  if (o2 < O2_DANGER_THRESHOLD) {
    alert = true;
    reason += "LOW_O2 ";
  }



// Skip first reading
if (firstReading) {
  prevPressure = pressure;
  firstReading = false;
} else {

  // Low pressure
  if (pressure < 900) {
    alert = true;
    reason += "LOW_PRESSURE ";
  }

  // Sudden drop
  if ((prevPressure - pressure) > 20) {
    alert = true;
    reason += "PRESSURE_DROP ";
  }

  prevPressure = pressure;
}

  // -------- BUZZER --------
  if (alert && !lastAlertState) {
    digitalWrite(BUZZER, HIGH);
    buzzerStartTime = millis();
    buzzerActive = true;
  }

  if (buzzerActive && millis() - buzzerStartTime >= 1000) {
    digitalWrite(BUZZER, LOW);
    buzzerActive = false;
  }

  lastAlertState = alert;

  // -------- JSON --------
  String json = "{";
  json += "\"worker_id\":\"" + workerId + "\",";
  json += "\"dht_status\":\"" + dhtStatus + "\",";
  json += "\"mq2_status\":\"" + mq2Status + "\",";
  json += "\"mpu_status\":\"" + mpuStatus + "\",";
  json += "\"bmp_status\":\"" + bmpStatus + "\",";
  json += "\"device_status\":\"" + deviceStatus + "\",";
  json += "\"timestamp\":" + String(millis()) + ",";
  json += "\"temp\":" + String(temp) + ",";
  json += "\"humidity\":" + String(hum) + ",";
  json += "\"ch4\":" + String(ch4, 4) + ",";
  json += "\"gas_raw\":" + String(gas) + ",";
  // NEW: on-device O2 estimate sent to backend (replaces static 20.9 fallback)
  json += "\"o2\":" + String(o2, 2) + ",";
  json += "\"o2_label\":\"" + o2Label + "\",";
  json += "\"pressure\":" + String(pressure) + ",";
  json += "\"motion\":" + String(motion ? "1" : "0") + ",";
  json += "\"fall\":" + String(impact ? "1" : "0") + ",";
  json += "\"alert\":" + String(alert ? "true" : "false") + ",";
  json += "\"reason\":\"" + reason + "\"";
  json += "}";

  Serial.println("📡 Sending:");
  Serial.println(json);

  // -------- SEND --------
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverName);
    http.addHeader("Content-Type", "application/json");

    int response = http.POST(json);
    Serial.println(response > 0 ? "✅ Sent" : "❌ Failed");

    http.end();
  } else {
    connectWiFi();
  }
}