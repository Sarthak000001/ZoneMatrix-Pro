/**
 * C&C Financials - Zone Detector & Scorer Engine (V2 & V3 Algorithms)
 * Reconstructed from authentic reverse-engineered bundle specifications
 */

window.ZoneEngine = (function() {
  const HTF_SET = new Set(['1w', '1M', '3M', '6M', '1Y']);

  const DEFAULT_CONFIG = {
    impulseRangeMultiplier: 1.0,
    impulseBodyRatio: 0.55,
    softImpulseRangeMultiplier: 0.92,
    softImpulseBodyRatio: 0.50,
    htfImpulseBodyRatioMin: 0.45,
    baseBodyRatioMax: 0.50,
    looseBaseBodyRatioMax: 0.62,
    baseRangeMultiplier: 4,
    htfBaseRangeMultiplier: 6,
    similarRangeTolerance: 0.3,
    breakoutBuffer: 0.001,
    thresholdTolerance: 0.03,
    minDepartureAtr: 0.22,
    minZoneScore: 48,
    maxBaseCandles: 4,
    maxHtfBaseCandles: 6,
    maxLegInGapCandles: 3,
    maxLegOutCandles: 3,
    lookbackAchievementBars: 20,
    reactionWindow: 20
  };

  function clip(x) {
    return Math.min(1, Math.max(0, x));
  }

  // Calculate True Range and ATR
  function calculateATR(candles, period = 14) {
    if (!candles || candles.length === 0) return [];
    const atrs = [];
    let trSum = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prev = i > 0 ? candles[i - 1] : c;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close)
      );
      if (i < period) {
        trSum += tr;
        atrs.push(trSum / (i + 1));
      } else {
        const prevAtr = atrs[i - 1];
        atrs.push((prevAtr * (period - 1) + tr) / period);
      }
    }
    return atrs;
  }

  // Detect V2 Supply and Demand Zones on candles array
  function detectZonesV2(candles, timeframe = '1d', config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!candles || candles.length < 5) return [];

    const atrs = calculateATR(candles);
    const zones = [];
    const isHtf = HTF_SET.has(timeframe);
    const maxBase = isHtf ? cfg.maxHtfBaseCandles : cfg.maxBaseCandles;

    // Enrich candles with body ratio and range
    const enriched = candles.map((c, i) => {
      const range = Math.max(c.high - c.low, 0.001);
      const body = Math.abs(c.close - c.open);
      const bodyRatio = body / range;
      const direction = c.close > c.open ? 'bullish' : c.close < c.open ? 'bearish' : 'neutral';
      const atr = atrs[i] || range;
      const isImpulse = bodyRatio >= cfg.impulseBodyRatio && range >= atr * cfg.impulseRangeMultiplier;
      const isBase = bodyRatio <= cfg.baseBodyRatioMax;
      return { ...c, index: i, range, body, bodyRatio, direction, atr, isImpulse, isBase };
    });

    // Scan for Leg-in + Base (1 to maxBase candles) + Leg-out patterns
    for (let bStart = 1; bStart < enriched.length - 2; bStart++) {
      for (let bEnd = bStart; bEnd < Math.min(enriched.length - 1, bStart + maxBase); bEnd++) {
        const baseGroup = enriched.slice(bStart, bEnd + 1);
        const baseHigh = Math.max(...baseGroup.map(c => c.high));
        const baseLow = Math.min(...baseGroup.map(c => c.low));
        const baseRange = baseHigh - baseLow;
        const avgAtr = baseGroup.reduce((sum, c) => sum + c.atr, 0) / baseGroup.length;

        // Base compactness filter
        const widthLimit = isHtf ? 4.0 : 2.2;
        if (baseRange / avgAtr > widthLimit) continue;

        // Find Leg-in candidate before base
        let legIn = null;
        for (let li = bStart - 1; li >= Math.max(0, bStart - 1 - cfg.maxLegInGapCandles); li--) {
          if (enriched[li].isImpulse || enriched[li].bodyRatio >= cfg.softImpulseBodyRatio) {
            legIn = enriched[li];
            break;
          }
        }

        // Leg-out candidate after base
        const legOutStart = bEnd + 1;
        const legOutCandle = enriched[legOutStart];
        if (!legOutCandle || legOutCandle.direction === 'neutral') continue;

        const isDemand = legOutCandle.direction === 'bullish';
        const isSupply = legOutCandle.direction === 'bearish';
        if (!isDemand && !isSupply) continue;

        // Must break out of base
        const breakoutBuffer = cfg.breakoutBuffer;
        const confirmedBreakout = isDemand
          ? legOutCandle.close > baseHigh * (1 + breakoutBuffer)
          : legOutCandle.close < baseLow * (1 - breakoutBuffer);
        if (!confirmedBreakout) continue;

        // Group consecutive leg-outs
        const legOutGroup = [legOutCandle];
        let cur = legOutStart + 1;
        while (cur < Math.min(enriched.length, legOutStart + cfg.maxLegOutCandles)) {
          if (enriched[cur].direction === legOutCandle.direction) {
            legOutGroup.push(enriched[cur]);
            cur++;
          } else {
            break;
          }
        }

        const terminalLegOut = legOutGroup[legOutGroup.length - 1];

        // Pattern name (RBR, DBR, DBD, RBD)
        const inDir = legIn ? (legIn.direction === 'bullish' ? 'R' : 'D') : '';
        const outDir = isDemand ? 'R' : 'D';
        const pattern = inDir ? `${inDir}B${outDir}` : (isDemand ? 'BR' : 'BD');

        // Zone boundaries
        let proximal, distal;
        if (isDemand) {
          proximal = baseHigh;
          distal = baseLow;
          // Extension for reversal DBR
          if (pattern === 'DBR' && legIn) {
            distal = Math.min(distal, legIn.low);
          }
        } else {
          proximal = baseLow;
          distal = baseHigh;
          if (pattern === 'RBD' && legIn) {
            distal = Math.max(distal, legIn.high);
          }
        }

        const top = Math.max(proximal, distal);
        const bottom = Math.min(proximal, distal);

        // Evaluate Freshness on all subsequent candles
        let freshnessState = 'fresh';
        let touchCount = 0;
        for (let fi = terminalLegOut.index + 1; fi < enriched.length; fi++) {
          const fc = enriched[fi];
          const touches = isDemand ? fc.low <= proximal : fc.high >= proximal;
          if (touches) {
            touchCount++;
            const breaksDistal = isDemand ? fc.close < distal : fc.close > distal;
            if (breaksDistal) {
              freshnessState = 'broken_by_close';
              break;
            } else {
              const closesInside = isDemand ? (fc.close <= proximal && fc.close >= distal) : (fc.close >= proximal && fc.close <= distal);
              freshnessState = closesInside ? 'closed_inside' : 'tested_by_wick';
            }
          }
        }

        // Scoring: V2 100-point formula
        const departureAtr = isDemand ? (terminalLegOut.close - baseHigh) / avgAtr : (baseLow - terminalLegOut.close) / avgAtr;
        const totalLegOutRange = legOutGroup.reduce((s, c) => s + c.range, 0);
        const legOutRangeAtr = totalLegOutRange / avgAtr;

        // Achievement check: lookback 20 extreme
        let lookbackExtreme = false;
        if (legIn && legIn.index >= cfg.lookbackAchievementBars) {
          const lookbackSlice = enriched.slice(legIn.index - cfg.lookbackAchievementBars, legIn.index);
          if (isDemand) {
            lookbackExtreme = terminalLegOut.high > Math.max(...lookbackSlice.map(c => c.high));
          } else {
            lookbackExtreme = terminalLegOut.low < Math.min(...lookbackSlice.map(c => c.low));
          }
        }
        let achievementScore = (lookbackExtreme ? 1.2 : 0) + (pattern.includes('B') ? 0.9 : 0);
        if (legOutGroup.length > 1) achievementScore += 0.4;

        // Freshness factor
        const freshFactor = freshnessState === 'fresh' ? 1.0 : freshnessState === 'tested_by_wick' ? 0.75 : freshnessState === 'closed_inside' ? 0.45 : 0;

        // Follow through
        const followThrough = Math.max(0, departureAtr);

        // Score Components
        const baseCountPts = 12 * clip(1 - Math.max(0, baseGroup.length - 2) / maxBase);
        const compactnessPts = 11 * clip(1 - (baseRange / avgAtr) / (isHtf ? 4.0 : 1.8));
        const departurePts = 16 * clip(departureAtr / 1.8);
        const legOutRangePts = 14 * clip(legOutRangeAtr / 3.0);
        const terminalBodyPts = 8 * clip(terminalLegOut.bodyRatio);
        const achievementPts = 22 * clip(achievementScore / 3.2);
        const freshnessPts = 9 * freshFactor;
        const followThroughPts = 8 * clip(followThrough / 3.0);

        let subtotal = baseCountPts + compactnessPts + departurePts + legOutRangePts + terminalBodyPts + achievementPts + freshnessPts + followThroughPts;
        if (legOutGroup.length > 1) subtotal += 3;
        if (isHtf && achievementScore >= 1.8) subtotal += 8;

        const scoreBeforeBonus = Math.min(100, Math.round(subtotal * 100) / 100);
        const originBonus = 5;
        const finalScore = Math.min(100, Math.round((scoreBeforeBonus + originBonus) * 100) / 100);

        // Quality grade
        let quality = 'average';
        if (freshnessState === 'broken_by_close') quality = 'broken';
        else if (finalScore >= 78 && achievementScore >= 1.8) quality = 'perfect';
        else if (finalScore >= 62) quality = 'good';
        else if (finalScore >= 48) quality = 'average';
        else quality = 'weak';

        // Decision Score (baseline formation score)
        const decisionScore = finalScore;

        zones.push({
          id: `v2_zone_${zones.length + 1}`,
          detectorVersion: 'v2',
          type: isDemand ? 'demand' : 'supply',
          pattern,
          quality,
          score: finalScore,
          decisionScore,
          startTime: baseGroup[0].time,
          endTime: baseGroup[baseGroup.length - 1].time,
          legOutTime: terminalLegOut.time,
          top,
          bottom,
          proximal,
          distal,
          baseStartIndex: bStart,
          baseEndIndex: bEnd,
          legOutIndex: terminalLegOut.index,
          freshnessState,
          touchCount,
          isTradeable: finalScore >= 48 && freshnessState === 'fresh',
          scoreBreakdown: {
            baseCount: baseCountPts,
            compactness: compactnessPts,
            departure: departurePts,
            legOutRange: legOutRangePts,
            terminalBody: terminalBodyPts,
            achievement: achievementPts,
            freshness: freshnessPts,
            followThrough: followThroughPts,
            originBonus,
            finalScore
          }
        });
      }
    }

    return zones.sort((a, b) => b.score - a.score);
  }

  // Calculate Decision Score given higher-timeframe coincidence matches
  function calculateDecisionScore(formationScore, htfMatches = []) {
    // Decision Score = formation score + sum(baseWeight * multiplier)
    // Multipliers: full containment = 1.0, partial overlap = 0.75, near = 0.4
    // Base Weights: 1w = 1, 1M = 2, 3M = 12, 6M = 13
    let bonus = 0;
    for (const m of htfMatches) {
      const weight = m.timeframe === '1w' ? 1 : m.timeframe === '1M' ? 2 : m.timeframe === '3M' ? 12 : m.timeframe === '6M' ? 13 : 1;
      const mult = m.multiplier || (m.relationship === 'full' ? 1.0 : m.relationship === 'partial' ? 0.75 : 0.4);
      bonus += weight * mult;
    }
    return Math.min(100, Math.round((formationScore + bonus) * 100) / 100);
  }

  // Calculate Trade Geometry
  function calculateTradeGeometry(zone, cmp, oppositeZoneProximal = null) {
    const isDemand = zone.type === 'demand';
    const entry = zone.proximal;
    const stop = zone.distal;
    const distancePercent = Math.abs((cmp - entry) / cmp) * 100;
    
    // Risk = |entry - stop|
    const risk = Math.abs(entry - stop);
    let target = oppositeZoneProximal;
    if (!target) {
      // Default to 2R or 3R target if opposite proximal not provided
      target = isDemand ? entry + risk * 2.5 : entry - risk * 2.5;
    }

    const reward = Math.abs(target - entry);
    const riskReward = risk > 0 ? Math.round((reward / risk) * 100) / 100 : null;

    return {
      entry,
      stop,
      target,
      distancePercent: Math.round(distancePercent * 100) / 100,
      riskReward,
      risk: Math.round(risk * 100) / 100,
      reward: Math.round(reward * 100) / 100
    };
  }

  return {
    DEFAULT_CONFIG,
    calculateATR,
    detectZonesV2,
    calculateDecisionScore,
    calculateTradeGeometry
  };
})();
