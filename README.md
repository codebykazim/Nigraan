# Nigraan

A personal-safety wristband and a family alert network. Press a button on the band and the people who care about you know within a second — where you are, and that you need them. Fall down and say nothing, and they find out anyway.

| Component | Tech Stack |
|---|---|
| **Band** | Seeed Studio XIAO nRF52840 Sense · Arduino C++ · BLE 5.0 |
| **App** | React Native (Expo SDK 57) · Android · Kotlin native module |
| **Server** | FastAPI · Postgres · WebSockets |

## Architecture

- **Backend**: FastAPI + PostgreSQL (Supabase) + AWS EC2
- **Mobile App**: React Native (Expo) for Android
- **Hardware**: BLE wristband with IMU for fall detection

## Getting Started

### 1. The Server
```bash
pip install -r requirements.txt
python server/migrate_pg.py
python server/nigraan_server.py
```

### 2. The App
```bash
cd nigraan-app
npm install
npx expo start
```

## Security & Deployment
The app communicates securely via HTTPS and WebSockets.
Deployments are automated to AWS using EC2, Caddy, and Systemd.
