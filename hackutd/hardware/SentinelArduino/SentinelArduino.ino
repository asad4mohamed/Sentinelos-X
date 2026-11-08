// SentinelOS X - Arduino UNO R4 WiFi demo firmware.
//
// Role: untrusted physical sensor node + status indicator. It reads a REAL DHT11
// (temperature/humidity) and posts the measurements to a local bridge over plain HTTP,
// and shows the bridge's status on the onboard LED matrix. It never authorizes actions
// and never talks to the incident store directly.
//
// A 0.96" 128x64 I2C OLED (SSD1306 @ 0x3C; GND, VCC->5V, SCL->A5, SDA->A4) shows the live
// readings plus the state the bridge reports, with the next human step during an incident.
// The OLED is display-only: it never changes what is sent to or accepted from the bridge.
//
// Serial @115200:  send 'A' to trigger a clearly SYNTHETIC demo incident (fallback only).
#include <WiFiS3.h>
#include <Arduino_LED_Matrix.h>
#include <DHT.h>
#include <U8g2lib.h>
#include <Wire.h>
#include "arduino_secrets.h"  // WIFI_SSID, WIFI_PASS, BRIDGE_HOST, BRIDGE_PORT, BRIDGE_TOKEN

#define DHT_PIN 2  // DHT11 data pin (verified by reading it earlier)
static const unsigned long SENSOR_MS = 4000UL;        // how often a reading is POSTed to the bridge
static const unsigned long SENSOR_READ_MS = 2000UL;   // local DHT11 read (display refresh); DHT11 max ~1 Hz
static const unsigned long OLED_MS = 500UL;
// Local EARLY-WARNING levels shown on the OLED only. They sit below the real incident limits
// (SENSOR_TEMP_LIMIT_C=30, SENSOR_HUMIDITY_LIMIT_PCT=70 in hardware/.env, enforced in SpacetimeDB).
static const float WARN_TEMP_C = 27.0f, WARN_HUM_PCT = 60.0f;
static const float LIMIT_TEMP_C = 30.0f, LIMIT_HUM_PCT = 70.0f;  // display-only mirror of the bridge defaults

static const char DEVICE_ID[] = "uno-r4-01";
static const unsigned long HEARTBEAT_MS = 15000UL;
static const unsigned long STATUS_POLL_MS = 3500UL;
static const unsigned long WIFI_RETRY_MS = 10000UL;
static const unsigned long HTTP_TIMEOUT_MS = 4000UL;
static const unsigned long TRIGGER_COOLDOWN_MS = 5000UL;

ArduinoLEDMatrix matrix;
WiFiClient client;
DHT dht(DHT_PIN, DHT11);
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);
unsigned long lastSensor = 0, lastSensorRead = 0, lastOled = 0;
unsigned int sensorFailures = 0;
float curT = NAN, curH = NAN;  // latest successful local reading; NAN = unknown (never shown as 0)
bool sensorOk = false;         // the most recent read succeeded
char bridgeState[24] = "HEALTHY";

enum Face { FACE_OFFLINE, FACE_OK, FACE_ALERT, FACE_BUSY };

// 8 rows x 12 cols
static byte F_OK[8][12] = {
  {0,0,0,0,0,0,0,0,0,0,0,1},
  {0,0,0,0,0,0,0,0,0,0,1,1},
  {0,0,0,0,0,0,0,0,0,1,1,0},
  {1,0,0,0,0,0,0,0,1,1,0,0},
  {1,1,0,0,0,0,0,1,1,0,0,0},
  {0,1,1,0,0,0,1,1,0,0,0,0},
  {0,0,1,1,0,1,1,0,0,0,0,0},
  {0,0,0,1,1,1,0,0,0,0,0,0}};
static byte F_ALERT[8][12] = {
  {0,0,1,1,0,0,0,0,1,1,0,0},
  {0,0,0,1,1,0,0,1,1,0,0,0},
  {0,0,0,0,1,1,1,1,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,1,1,1,1,0,0,0,0},
  {0,0,0,1,1,0,0,1,1,0,0,0},
  {0,0,1,1,0,0,0,0,1,1,0,0}};
static byte F_BUSY[8][12] = {  // hourglass
  {0,0,1,1,1,1,1,1,1,1,0,0},
  {0,0,0,1,0,0,0,0,1,0,0,0},
  {0,0,0,0,1,0,0,1,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,0,1,1,0,0,0,0,0},
  {0,0,0,0,1,0,0,1,0,0,0,0},
  {0,0,0,1,0,1,1,0,1,0,0,0},
  {0,0,1,1,1,1,1,1,1,1,0,0}};
static byte F_OFFLINE[8][12] = {  // dashed frame = no link to bridge
  {1,0,1,0,1,0,1,0,1,0,1,0},
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {1,0,0,0,0,0,0,0,0,0,0,1},
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {1,0,0,0,0,0,0,0,0,0,0,1},
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {0,0,0,0,0,0,0,0,0,0,0,0},
  {1,0,1,0,1,0,1,0,1,0,1,0}};

Face currentFace = FACE_OFFLINE;
bool faceShown = false;
bool pendingTrigger = false;
bool busy = false;  // bridge says an incident is in flight
unsigned long lastHeartbeat = 0, lastPoll = 0, lastWifiTry = 0, lastTrigger = 0;
bool bridgeReachable = false;

void showFace(Face f) {
  if (faceShown && f == currentFace) return;
  currentFace = f;
  faceShown = true;
  switch (f) {
    case FACE_OK:      matrix.renderBitmap(F_OK, 8, 12); break;
    case FACE_ALERT:   matrix.renderBitmap(F_ALERT, 8, 12); break;
    case FACE_BUSY:    matrix.renderBitmap(F_BUSY, 8, 12); break;
    default:           matrix.renderBitmap(F_OFFLINE, 8, 12); break;
  }
}

// Minimal bounded HTTP/1.1 request. Returns HTTP status code (0 on failure) and
// copies the response body (trimmed, truncated) into `body`.
int httpRequest(const char* method, const char* path, const char* payload, char* body, size_t bodySize) {
  if (bodySize) body[0] = '\0';
  client.stop();
  if (!client.connect(BRIDGE_HOST, BRIDGE_PORT)) return 0;

  client.print(method); client.print(' '); client.print(path); client.println(" HTTP/1.1");
  client.print("Host: "); client.print(BRIDGE_HOST); client.print(':'); client.println(BRIDGE_PORT);
  client.print("X-Device-Token: "); client.println(BRIDGE_TOKEN);
  client.println("Connection: close");
  if (payload) {
    client.println("Content-Type: application/json");
    client.print("Content-Length: "); client.println(strlen(payload));
  }
  client.println();
  if (payload) client.print(payload);

  static char buf[384];
  size_t n = 0;
  unsigned long deadline = millis() + HTTP_TIMEOUT_MS;
  while (millis() < deadline && n < sizeof(buf) - 1) {
    while (client.available() && n < sizeof(buf) - 1) buf[n++] = (char)client.read();
    if (!client.connected() && !client.available()) break;
  }
  buf[n] = '\0';
  client.stop();

  int code = 0;
  if (n > 12 && strncmp(buf, "HTTP/1.", 7) == 0) code = atoi(buf + 9);
  char* sep = strstr(buf, "\r\n\r\n");
  if (sep && bodySize) {
    sep += 4;
    strncpy(body, sep, bodySize - 1);
    body[bodySize - 1] = '\0';
    for (int i = strlen(body) - 1; i >= 0 && (body[i] == '\r' || body[i] == '\n' || body[i] == ' '); i--) body[i] = '\0';
  }
  return code;
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  bridgeReachable = false;
  showFace(FACE_OFFLINE);
  if (millis() - lastWifiTry < WIFI_RETRY_MS && lastWifiTry != 0) return;
  lastWifiTry = millis();
  Serial.println("[wifi] connecting...");
  if (strlen(WIFI_PASS) == 0) WiFi.begin(WIFI_SSID);
  else WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 8000UL) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[wifi] connected, IP=");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[wifi] failed, will retry");
  }
}

void sendEvent(const char* type) {
  char payload[160];
  snprintf(payload, sizeof(payload),
           "{\"device_id\":\"%s\",\"event_type\":\"%s\",\"scenario_id\":\"INC-003\",\"simulated\":true}",
           DEVICE_ID, type);
  char body[160];
  int code = httpRequest("POST", "/hardware/events", payload, body, sizeof(body));
  Serial.print("[event] "); Serial.print(type); Serial.print(" -> HTTP "); Serial.print(code);
  if (code) { Serial.print(" "); Serial.println(body); } else Serial.println(" (no response)");
  bridgeReachable = (code == 202);
  if (!bridgeReachable) showFace(FACE_OFFLINE);
}

// Reads the real DHT11 locally (drives the OLED). A failed read keeps the last good value only
// for display age purposes: sensorOk goes false, so nothing stale is posted or shown as live.
void readSensor() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (isnan(t) || isnan(h)) {
    sensorFailures++;
    sensorOk = false;
    Serial.print("[sensor] read failed ("); Serial.print(sensorFailures); Serial.println(" in a row)");
    return;
  }
  sensorFailures = 0;
  sensorOk = true;
  curT = t;
  curH = h;
}

// Reports the latest real measurement. A failed read is never reported as a value.
void sendSensorReading() {
  if (!sensorOk) return;
  float t = curT, h = curH;
  String payload = String("{\"device_id\":\"") + DEVICE_ID + "\",\"event_type\":\"sensor_reading\",\"temp_c\":" +
                   String(t, 1) + ",\"humidity_pct\":" + String(h, 1) + ",\"simulated\":false}";
  char body[96];
  int code = httpRequest("POST", "/hardware/events", payload.c_str(), body, sizeof(body));
  Serial.print("[sensor] "); Serial.print(t, 1); Serial.print("C "); Serial.print(h, 0);
  Serial.print("% -> HTTP "); Serial.println(code);
  bridgeReachable = (code == 202);
  if (!bridgeReachable) showFace(FACE_OFFLINE);
}

void pollStatus() {
  char body[48];
  int code = httpRequest("GET", "/hardware/status", nullptr, body, sizeof(body));
  if (code != 200) {
    Serial.print("[status] HTTP "); Serial.println(code);
    bridgeReachable = false;
    showFace(FACE_OFFLINE);
    return;
  }
  bridgeReachable = true;
  busy = false;
  strncpy(bridgeState, body, sizeof(bridgeState) - 1);
  bridgeState[sizeof(bridgeState) - 1] = '\0';
  if (!strcmp(body, "HEALTHY") || !strcmp(body, "RECOVERED")) showFace(FACE_OK);
  else if (!strcmp(body, "ALERT")) { showFace(FACE_ALERT); busy = true; }
  else if (!strcmp(body, "INVESTIGATING") || !strcmp(body, "AWAITING_APPROVAL")) { showFace(FACE_BUSY); busy = true; }
  static char last[24] = "";
  if (strcmp(last, body)) {
    Serial.print("[status] "); Serial.println(body);
    strncpy(last, body, sizeof(last) - 1);
  }
}

// ---- OLED -------------------------------------------------------------------------------
// Title bar + live readings + two lines of "what is happening / what to do next".
void oledDraw() {
  const bool wifiUp = WiFi.status() == WL_CONNECTED;
  const bool known = sensorOk && !isnan(curT) && !isnan(curH);
  const bool hot = known && curT >= LIMIT_TEMP_C, wet = known && curH >= LIMIT_HUM_PCT;
  const bool warnT = known && curT >= WARN_TEMP_C, warnH = known && curH >= WARN_HUM_PCT;

  const char* title;
  char l1[24], l2[24];
  bool blink = false;
  l1[0] = l2[0] = '\0';

  if (!wifiUp) {
    title = "NO WIFI"; strcpy(l1, "Local readings only"); strcpy(l2, "Reconnecting...");
  } else if (!bridgeReachable) {
    title = "NO BRIDGE"; strcpy(l1, "Local readings only"); strcpy(l2, "Check laptop bridge");
  } else if (!strcmp(bridgeState, "ALERT")) {
    title = "ALERT"; blink = true;
    if (hot && wet) strcpy(l1, "TEMP+HUMIDITY OVER");
    else if (hot) strcpy(l1, "TEMP over limit");
    else if (wet) strcpy(l1, "HUMIDITY over limit");
    else strcpy(l1, "Incident opened");
    strcpy(l2, "Next: AI investigates");
  } else if (!strcmp(bridgeState, "INVESTIGATING")) {
    title = "INVESTIGATING"; strcpy(l1, "AI analysing evidence"); strcpy(l2, "Next: analyst ACCEPTS");
  } else if (!strcmp(bridgeState, "AWAITING_APPROVAL")) {
    title = "APPROVAL NEEDED"; blink = true;
    strcpy(l1, "Analyst: ACCEPT, then"); strcpy(l2, "Commander: APPROVE");
  } else if (!strcmp(bridgeState, "RECOVERED")) {
    title = "RESOLVED"; strcpy(l1, "Response approved"); strcpy(l2, "Readings settling...");
  } else if (warnT || warnH) {
    title = "WARNING";
    if (warnT && warnH) strcpy(l1, "Temp+humidity rising");
    else if (warnT) strcpy(l1, "Temperature rising");
    else strcpy(l1, "Humidity rising");
    strcpy(l2, "Ease off the sensor");
  } else if (!known) {
    title = "SENSOR ERROR"; strcpy(l1, "No valid DHT11 read"); strcpy(l2, "Check wiring (pin 2)");
  } else {
    title = "NORMAL"; strcpy(l1, "All readings normal"); strcpy(l2, "Monitoring live");
  }

  const bool inverted = !(blink && ((millis() / 500UL) & 1));
  oled.clearBuffer();
  // title bar
  if (inverted) { oled.setDrawColor(1); oled.drawBox(0, 0, 128, 12); oled.setDrawColor(0); }
  else { oled.setDrawColor(1); oled.drawFrame(0, 0, 128, 12); }
  oled.setFont(u8g2_font_6x10_tr);
  oled.drawStr(3, 10, title);
  oled.setDrawColor(1);

  // readings
  char v[12];
  oled.setFont(u8g2_font_5x7_tr);
  oled.drawStr(4, 21, "TEMP");
  oled.drawStr(70, 21, "HUMIDITY");
  oled.setFont(u8g2_font_logisoso16_tr);
  if (known) snprintf(v, sizeof(v), "%.1fC", curT); else strcpy(v, "--");
  oled.drawStr(4, 42, v);
  if (known) snprintf(v, sizeof(v), "%.0f%%", curH); else strcpy(v, "--");
  oled.drawStr(70, 42, v);
  if (hot || warnT) oled.drawFrame(0, 23, 64, 23);   // box around the reading that is out of range
  if (wet || warnH) oled.drawFrame(66, 23, 62, 23);

  // guidance
  oled.setFont(u8g2_font_6x10_tr);
  oled.drawStr(2, 55, l1);
  oled.drawStr(2, 64, l2);
  oled.sendBuffer();
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000UL) {}
  oled.begin();
  oled.setBusClock(400000);
  matrix.begin();
  dht.begin();
  showFace(FACE_OFFLINE);
  Serial.println("SentinelOS X firmware boot. Reading a REAL DHT11 on pin 2. Send 'A' for a SYNTHETIC demo incident.");
  Serial.print("[wifi] firmware "); Serial.println(WiFi.firmwareVersion());
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == 'A' || c == 'a') pendingTrigger = true;
  }

  // Local sensor + OLED run even when Wi-Fi or the bridge is down.
  unsigned long nowLocal = millis();
  if (!lastSensorRead || nowLocal - lastSensorRead >= SENSOR_READ_MS) {
    lastSensorRead = nowLocal ? nowLocal : 1;
    readSensor();
    lastOled = 0;  // redraw immediately with the new reading
  }
  if (!lastOled || nowLocal - lastOled >= OLED_MS) {
    lastOled = nowLocal ? nowLocal : 1;
    oledDraw();
  }

  ensureWifi();
  if (WiFi.status() != WL_CONNECTED) return;

  unsigned long now = millis();
  if (pendingTrigger) {
    pendingTrigger = false;
    if (busy) Serial.println("[trigger] ignored: incident already in flight");
    else if (lastTrigger && now - lastTrigger < TRIGGER_COOLDOWN_MS) Serial.println("[trigger] ignored: cooldown");
    else {
      lastTrigger = now;
      sendEvent("simulated_incident");
      pollStatus();
    }
  }
  if (!lastSensor || now - lastSensor >= SENSOR_MS) {
    lastSensor = now ? now : 1;
    sendSensorReading();
  }
  if (!lastHeartbeat || now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now ? now : 1;
    sendEvent("heartbeat");
  }
  if (!lastPoll || now - lastPoll >= STATUS_POLL_MS) {
    lastPoll = now ? now : 1;
    pollStatus();
  }
}
