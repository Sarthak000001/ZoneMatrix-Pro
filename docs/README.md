# ZoneMatrix Pro — System Architecture & Reverse Engineering Documentation

This directory contains the comprehensive reverse engineering analysis, architectural breakdown, and algorithm specifications reconstructed for **ZoneMatrix Pro** (Institutional Stock Analysis & Supply-Demand Trading Terminal).

## Table of Contents

| Chapter | Document | Focus Area |
|---------|----------|------------|
| 01 | [Project Architecture](file:///docs/01_PROJECT_ARCHITECTURE.md) | Initial inspection, frontend bundle analysis, and scope boundary |
| 02 | [Website Map](file:///docs/02_WEBSITE_MAP.md) | Complete site map, views, navigation, and modal dialogues |
| 03 | [Page Functionality](file:///docs/03_PAGE_FUNCTIONALITY.md) | Chart tools, screeners, confluence matrix, and zone monitors |
| 04 | [Network & API Analysis](file:///docs/04_NETWORK_AND_API_ANALYSIS.md) | Endpoint specifications, payloads, auth, and Upstox integration |
| 05 | [Market Data Analysis](file:///docs/05_MARKET_DATA_ANALYSIS.md) | Candle normalization, intraday aggregation, and multi-resolution data |
| 06 | [Supply & Demand Algorithms](file:///docs/06_SUPPLY_DEMAND_ALGORITHMS.md) | V2 & V3 zone detection algorithms, base candle logic, and scoring |
| 07 | [Support & Resistance](file:///docs/07_SUPPORT_RESISTANCE.md) | Horizontal level detection and touch point confluence |
| 08 | [Market Structure](file:///docs/08_MARKET_STRUCTURE.md) | Swing high/low detection, trend structure, and break of structure (BOS) |
| 09 | [Technical Indicators](file:///docs/09_TECHNICAL_INDICATORS.md) | ATR, EMA, Bollinger Bands, and RSI integration |
| 10 | [Candlestick Analysis](file:///docs/10_CANDLESTICK.md) | Exciting candles, base candles, body ratio calculations |
| 11 | [Volume Analysis](file:///docs/11_VOLUME.md) | Relative volume, volume spike thresholds, and institutional footprint |
| 12 | [Multi-Timeframe Analysis](file:///docs/12_MULTI_TIMEFRAME_ANALYSIS.md) | HTF trend alignment (Monthly, Weekly, Daily, 75m, 15m) |
| 13 | [Trading Signal Engine](file:///docs/13_TRADING_SIGNAL_ENGINE.md) | Entry criteria, risk-reward ratios, stop-loss and target placement |
| 14 | [Monthly, Weekly, Yearly](file:///docs/14_MONTHLY_WEEKLY_YEARLY.md) | Higher timeframe zone confluence and institutional pivots |
| 15 | [Zone Wise Analysis](file:///docs/15_ZONE_WISE.md) | Detailed metrics per supply & demand zone |
| 16 | [Algorithm Reconstruction](file:///docs/16_ALGORITHM_RECONSTRUCTION.md) | Pure JavaScript implementation of canonical V2 & V3 detector rules |
| 17 | [Validation](file:///docs/17_VALIDATION.md) | Verification against historical market data |
| 18 | [Unknown & Unconfirmed Logic](file:///docs/18_UNKNOWN_AND_UNCONFIRMED_LOGIC.md) | Notes on proprietary server-side heuristics |
| 19 | [Final System Architecture](file:///docs/19_FINAL_SYSTEM_ARCHITECTURE.md) | End-to-end full stack architecture for production deployment |
| 20 | [Completion](file:///docs/20_COMPLETION.md) | Milestone summary and deliverables checklist |
| 21 | [Extended REA Findings](file:///docs/21_EXTENDED_REA_FINDINGS.md) | Deep inspection notes on chart-engine internals |

### Additional References
- [PROGRESS.md](file:///docs/PROGRESS.md) — Chronological reverse-engineering milestone journal
- [REA_CAPABILITIES.md](file:///docs/REA_CAPABILITIES.md) — REA environment notes
- [REVERSE_ENGINEERING_PLAN.md](file:///docs/REVERSE_ENGINEERING_PLAN.md) — 5-phase systematic reverse engineering strategy
