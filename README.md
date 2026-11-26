# ZoneMatrix Pro — Institutional Stock Analysis & Trading Terminal

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Upstox API v2](https://img.shields.io/badge/API-Upstox%20v2-ff6b00.svg)](https://developer.upstox.com/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)]()

**ZoneMatrix Pro** is an institutional-grade supply-demand zone trading and stock analysis terminal for Indian Equities (NSE Nifty 500 & Indices). It features authentic multi-timeframe zone detection algorithms (V2 and V3), a confluence scanner, institutional order geometry calculations, backtesting simulation, and real-time market data integration with Upstox API v2.

---

## ⚡ Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended with native `.env` support)
- No `npm install` required! Built entirely with native Node.js standard library.

### 2. Configure Environment (Optional for Live Data)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` with your Upstox Analytics Token (recommended) for live NSE market data:
```env
PORT=3000
# 1-Year Analytics Token (No daily 3:30 AM expiration!)
UPSTOX_ANALYTICS_TOKEN=your_upstox_analytics_token_here
```
> [!NOTE]
> If no Upstox token is provided, the platform automatically runs in **Offline / Sample Data Mode**, using pre-cached instruments, reports, and candles for instant out-of-the-box exploration.

### 3. Configure Upstox Analytics Token (No 3:30 AM Expiry)
Upstox provides **1-Year Analytics Tokens** for read-only live market data without requiring daily OAuth re-authentication:
1. Log in to [Upstox Developer Console](https://developer.upstox.com/)
2. Open your App & click the **Analytics** tab
3. Click **Generate Token** and copy the token
4. Paste it directly into the website's top-right **Upstox** modal, or set it via terminal:
```bash
npm run token
# or: node get-token.mjs
```

### 4. Start the Terminal
```bash
npm start
# or: node server.mjs
```

Open your browser at:
```
http://localhost:3000/
```

---

## 🔒 Security & Sensitive Data Practice

This repository adheres to standard security practices for public open-source repositories:

- **Zero Hardcoded Secrets**: No API keys, secret keys, bearer tokens, or user passwords are hardcoded in the codebase.
- **Environment Isolation**: All credentials are read from `process.env` and local `.env` files via `env.mjs`.
- **Git Ignore Safeguards**: `.env`, `_cache/upstox-config.json`, runtime cache files, logs, and OS files are excluded from Git via [.gitignore](.gitignore).
- **Masked Token Responses**: Backend endpoints (`/api/settings/upstox`) sanitize credentials and only return safe masked token strings (e.g. `eyJ0eXAi...QKZ4`).
- **Data Isolation**: Seed data is stored cleanly in `data/`, keeping large dynamic runtime caches separate.

---

## 🛠️ Key Platform Features

### 1. Interactive Candlestick & Supply/Demand Chart (`?view=chart`)
- **Symbol Selection**: Fast autocomplete across 1,800+ NSE equities and indices.
- **Multi-Timeframe Analysis**: 5m, 15m, 60m, 75m, 125m, 240m, 1D, 1W, 1M, 3M, 6M, 1Y.
- **Dual Zone Detectors**:
  - **V3 (Structure-First Preview)**: Server-calculated canonical zone detector with structural arrival geometry and authenticity checks.
  - **V2 (Production Rules)**: 100-point scoring algorithm (compactness, departure, leg-out range, terminal body, achievement, freshness, follow-through).
- **Zone Details Drawer**: Slide-in inspection panel displaying the 100-point breakdown, order geometry (Entry, Stop Loss, Target 1, R:R), and quick-add buttons to Watchlist and Dashboard.
- **Moving Average Overlays**: 20 EMA, 50 EMA, 100 EMA, 200 EMA with crosshair coordinate inspection.

### 2. Zone Distance Report (`?view=zones`)
- Identifies stocks closest to qualified demand and supply zones in the Nifty 500 universe.
- Real-time order geometry: Entry, Stop-Loss, Target, and Reward-to-Risk ratio.
- Higher-timeframe (HTF) reaction context and multi-EMA positions.

### 3. Zone Confluence Report (`?view=confluence`)
- Lower-timeframe zones overlapping higher-timeframe decision areas (e.g. Monthly Income Trade `MIT` with 1M HTF / 1w ITF / 1d LTF).
- Precise coincidence classification, overlap percentage, and decision score calculations.

### 4. Zone Watch (`?view=zone-watch`)
- Real-time tracking of saved zones with touch counts, distance over CMP, and reaction monitoring (`REACTING`, `WATCHING`, `IN_ZONE`).

### 5. Setup Dashboard (`?view=dashboard`)
- 3-column priority layout:
  - HTF Reacting Stocks
  - Best Execution Stocks
  - HTF Reacting Indices

### 6. Strategy Backtesting (`?view=backtesting`)
- Simulation parameter configuration (Universe, timeframe, initial capital, risk %).
- Interactive backtest metrics (Win Rate %, Profit Factor, Max Drawdown) and trade log.

### 7. Operations & Upstox Management (`?view=operations`)
- Live Upstox token validation modal.
- Data provider health monitoring (Upstox environment status, sync status, cache workers).
- Diagnostic system activity console.

---

## 📂 Project Structure

```text
Stock-analysis/
├── .env.example             # Template for environment variables and Upstox API keys
├── .gitattributes           # Git line-ending normalization configuration
├── .gitignore               # Strict ignore rules for secrets, cache, and dependencies
├── LICENSE                  # MIT Open Source License
├── package.json             # Project metadata, run scripts, and engine specifications
├── README.md                # Main documentation and quick-start guide
├── env.mjs                  # Universal environment loader (.env parser)
├── server.mjs               # Node.js HTTP server & API backend
├── upstox-service.mjs       # Upstox API v2 live market data integration
├── get-token.mjs            # Interactive OAuth CLI helper to generate Upstox access tokens
│
├── data/                    # Clean seed datasets for offline & demo use
│   ├── instruments.json     # NSE equity and index instrument masters
│   ├── candles-*.json       # Baseline historical daily candles (e.g. COCHINSHIP, RELIANCE)
│   ├── report-*.json        # Seed zone distance and confluence reports
│   └── dashboard-items.json # Initial dashboard cards & state
│
├── docs/                    # Architectural breakdown & algorithm specifications
│   ├── README.md            # Comprehensive Table of Contents (Chapters 01 - 21)
│   ├── 01_PROJECT_ARCHITECTURE.md
│   ├── 04_NETWORK_AND_API_ANALYSIS.md
│   ├── 06_SUPPLY_DEMAND_ALGORITHMS.md
│   ├── 16_ALGORITHM_RECONSTRUCTION.md
│   └── ... (21 in-depth research modules)
│
├── public/                  # Frontend single-page application assets
│   ├── index.html           # Main terminal user interface
│   ├── css/
│   │   ├── style.css        # Modern dark theme styling with glassmorphism
│   │   └── original.css     # Production stylesheet
│   └── js/
│       ├── app.js           # Single Page App routing, UI state, modal controllers
│       ├── chart-engine.js  # High-performance candlestick, volume, & zone renderer
│       └── v2-detector.js   # Client-side 100-point zone detection engine
│
├── samples/                 # Sample zone summaries and test payloads
└── tools/                   # Developer & reverse-engineering utilities
    ├── README.md            # Tools guide
    └── extractors/          # Offline data extraction scripts
```

---

## 📖 Complete Documentation

Detailed reverse-engineering and algorithm reconstruction documentation is available in the [`docs/`](docs/README.md) directory:

- [Project Architecture & Scope](docs/01_PROJECT_ARCHITECTURE.md)
- [Network & API Specification](docs/04_NETWORK_AND_API_ANALYSIS.md)
- [Supply & Demand Algorithms (V2 vs V3)](docs/06_SUPPLY_DEMAND_ALGORITHMS.md)
- [Multi-Timeframe Trend & Alignment](docs/12_MULTI_TIMEFRAME_ANALYSIS.md)
- [Trading Signal Engine & Order Geometry](docs/13_TRADING_SIGNAL_ENGINE.md)
- [Algorithm Reconstruction Source](docs/16_ALGORITHM_RECONSTRUCTION.md)

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
