# Nigraan

> *nigraan* (نگران) — **guardian, one who watches over**

**A personal-safety wristband and a family alert network.** 

Nigraan solves a critical flaw in traditional personal safety apps: relying on the user to reach, unlock, and operate their phone during an emergency. With a BLE-enabled wristband, users can raise an alarm instantly without a phone in hand. Furthermore, because escalation deadlines live on the server, a destroyed or disconnected phone acts as the alert itself.

---

## 🌟 Key Features

* **Instant SOS & Fall Detection:** Trigger an SOS from the app or wristband. Built-in IMU on the band automatically detects falls and hard impacts.
* **Family Takeover:** Receiving phones go full-screen red, vibrate with a siren, and display a live map pin of the wearer.
* **Server-Owned Deadlines (High Alert):** When walking through unsafe areas, users can arm "High Alert". The server checks in every 5 minutes. If the user fails to respond, the server automatically pages the family — even if the user's phone is destroyed or offline.
* **Live Location Tracking:** In an emergency, live location is streamed directly to a secure, HMAC-signed web map that can be safely shared with first responders.
* **Good Samaritan Fan-out:** High-severity alerts can anonymously notify nearby Nigraan users (within 800m) for immediate community assistance.

---

## 🛠️ Tech Stack

| Component | Technologies Used |
|---|---|
| **Hardware Band** | Seeed Studio XIAO nRF52840 Sense · Arduino C++ · BLE 5.0 |
| **Mobile App** | React Native (Expo) · Android · Custom Kotlin Alarm Module |
| **Backend Server** | FastAPI (Python) · PostgreSQL (Supabase) · WebSockets |
| **Deployment** | AWS EC2 · Caddy (HTTPS) · Systemd |

---

## 🚀 Running the Project (No Hardware Required)

You can demo the entire product loop using the built-in "Virtual Band" simulator in the app.

### 1. Start the Server
The backend requires PostgreSQL. Configure your `DATABASE_URL` in `.env`.
```bash
pip install -r requirements.txt
python server/migrate_pg.py
python server/nigraan_server.py
```
*(To test across the internet with the mobile app, expose the server using `ngrok http 8000`)*

### 2. Run the App
```bash
cd nigraan-app
npm install
npx expo start
```
Use the Expo Go app or build a native Android APK to test background services and lock-screen sirens. 

---

## 🔒 Security Highlights

* **Privacy-First Pairing:** Accounts cannot be searched. Users must explicitly share a 10-minute temporary code or a permanent invite link to pair.
* **Encrypted Sessions:** Session tokens are hashed using SHA-256 in the database.
* **Band Authentication:** The physical band requires a 6-digit PIN over an encrypted BLE link to prevent unauthorized access.

---
<p align="center">
  <em>نگران — one who watches over.</em>
</p>
