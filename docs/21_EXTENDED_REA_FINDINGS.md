# Extended REA Findings

Date: 2026-10-31. Continuation of REA investigation for C&C Financials.

## Live Session & API Access
- Authenticated with credentials (`id: "pradyumn.m"`).
- Session cookie `cc_financials_session` and CSRF cookie `cc_financials_csrf` validated.
- Retrieved the original production stylesheet `/assets/index-VzkoQAKI.css` (106 KB).
- Full market data, instruments, reports, and zones extracted to local cache.

## Resolved Status State Machine
- **Zone Watch & Dashboard Status**:
  - `IN_ZONE`: Current Market Price (CMP) is within proximal and distal edges (`low <= CMP <= high`).
  - `REACTING`: Zone was touched (`reactionActive = true`, `touchCount >= 1`) and price moved away from the zone in the anticipated direction.
  - `WATCHING`: Zone is active and tradeable, but price is outside the immediate reaction/near threshold.
  - `NEAR` / `APPROACHING`: Price is within 1% to 2% of the proximal boundary.
  - `BROKEN`: Completed candle closed beyond the distal boundary (`state = "broken_by_close"`).
  - `TARGET_ACHIEVED`: Price reached opposing target.

## Setup Dashboard Structure
- Items belong to categories: `HTF_REACTING_STOCKS`, `BEST_EXECUTION_STOCKS`, `HTF_REACTING_INDICES`.
- Each card records: `symbol`, `company`, `instrumentKey`, `timeframe`, `zoneType`, `low`, `high`, `cmp`, `distancePercent`, `position` (ABOVE/BELOW), `status` (WATCHING/REACTING).

## Zone Confluence Resolution
- Querying with `purpose=MIT`, `detectorVersion=v2`, `minLtfScore=78`, `minHtfScore=48`, `minOverlapPercent=1`, `maxDistancePercent=10` yields 18 live confluence rows.
- Coincidence points calculation confirmed: `awardedPoints = baseWeight * multiplier`, where multipliers are `1` (full containment), `0.75` (partial overlap), and `0.4` (near alignment).
