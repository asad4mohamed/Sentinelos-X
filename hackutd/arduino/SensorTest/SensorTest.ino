// SensorTest: finds a DHT11 on any free digital/analog pin, then prints readings.
// Read-only diagnostic. Serial @ 115200.
#include <DHT.h>

const uint8_t CANDIDATES[] = {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 0,
                              A0, A1, A2, A3, A4, A5};
const uint8_t NCAND = sizeof(CANDIDATES) / sizeof(CANDIDATES[0]);

DHT *dht = nullptr;
int8_t foundPin = -1;

void scanForSensor() {
  Serial.println("Scanning pins for a DHT11...");
  for (uint8_t i = 0; i < NCAND; i++) {
    uint8_t pin = CANDIDATES[i];
    DHT probe(pin, DHT11);
    probe.begin();
    delay(1100);  // DHT11 needs >1s between reads
    float t = probe.readTemperature();
    float h = probe.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      foundPin = pin;
      dht = new DHT(pin, DHT11);
      dht->begin();
      Serial.print("FOUND DHT11 on pin ");
      Serial.println(pin);
      return;
    }
  }
  Serial.println("No DHT11 responded on any pin. Check wiring/power.");
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 3000) {}
  Serial.println("SensorTest boot (UNO R4 WiFi)");
  scanForSensor();
}

void loop() {
  if (dht == nullptr) {
    delay(5000);
    scanForSensor();
    return;
  }
  float t = dht->readTemperature();
  float h = dht->readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("read failed");
  } else {
    Serial.print("pin=");  Serial.print(foundPin);
    Serial.print(" temp_C="); Serial.print(t, 1);
    Serial.print(" humidity_pct="); Serial.println(h, 1);
  }
  delay(2000);
}
