/**
 * C&C Financials - Interactive Financial Chart Engine  (v2 - detail-first redesign)
 * Canvas candlesticks, volume, EMAs and supply/demand zones.
 *
 * Drop-in replacement: same class name, constructor, and public methods as v1.
 *
 * What's new
 *  - Large, crisp, pixel-aligned candles with a wider default zoom-in
 *  - Hover = full candle inspector: highlighted bar, O/H/L/C ticks, floating
 *    tooltip (date, OHLC, change, range, body %, wicks, volume)
 *  - O/H/L/C price guides on the right axis for the hovered candle
 *  - "Nice number" price grid + vertical time grid, smart date labels
 *    (intraday times / month / year changes)
 *  - Keyboard: ← → step through candles, + / - zoom, Home/End jump, 0 reset
 *  - Touch: drag to pan, pinch to zoom, tap to inspect a candle
 *  - Drawing clipped to the plot area, EMA line labels, zone tags kept on-screen
 *  - Shift + wheel pans the chart, plain wheel zooms
 *  - ResizeObserver, destroy() for clean teardown
 */

class FinancialChart {
  constructor(canvasContainerId, options = {}) {
    this.container = document.getElementById(canvasContainerId);
    if (!this.container) throw new Error(`Container #${canvasContainerId} not found`);

    this.options = {
      theme: 'dark',
      bullishColor: '#089981',
      bearishColor: '#f23645',
      volumeBullish: 'rgba(8, 153, 129, 0.28)',
      volumeBearish: 'rgba(242, 54, 69, 0.28)',
      demandColor: 'rgba(16, 185, 129, 0.18)',
      demandBorder: '#10b981',
      supplyColor: 'rgba(239, 68, 68, 0.18)',
      supplyBorder: '#ef4444',
      gridColor: '#1e2430',
      textColor: '#94a3b8',
      crosshairColor: 'rgba(148, 163, 184, 0.6)',
      tooltipBg: 'rgba(15, 23, 42, 0.96)',
      tooltipBorder: '#334155',
      tooltipText: '#e2e8f0',
      tooltipMuted: '#94a3b8',
      pillBg: '#0f172a',
      pillText: '#f8fafc',
      spotlight: 'rgba(255, 255, 255, 0.05)',
      axisLine: '#263041',
      ...options
    };

    this.candles = [];
    this.zones = [];
    this.indicators = { ema20: false, ema50: false, ema100: false, ema200: false };
    this.emaData = { ema20: [], ema50: [], ema100: [], ema200: [] };
    this.timeframe = options.timeframe || '1d';
    this._initDateFormatters();

    // Canvas setup
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.tabIndex = 0; // keyboard support
    this.canvas.style.outline = 'none';
    this.canvas.style.touchAction = 'none';
    this.container.innerHTML = '';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Dimensions & margins
    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 500;
    this.rightMargin = 78;  // price scale
    this.bottomMargin = 30; // time scale
    this.topMargin = 20;

    // Viewport state
    this.candleWidth = 8;
    this.candleSpacing = 4;
    this.offsetIndex = 0;   // candles hidden past the right edge
    this.visibleCount = 60;
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartOffset = 0;
    this.hoverPoint = null;
    this.lastHoveredIndex = -1;
    this.selectedZone = null;
    this.onZoneSelect = options.onZoneSelect || null;
    this.hasFitted = false;
    this.renderRequested = false;
    this.view = null;

    // Price & time scale stretch state
    this.autoPriceScale = true;
    this.priceScaleMultiplier = 1.0;
    this.priceCenterOffset = 0;
    this.baseMinPrice = 0;
    this.baseMaxPrice = 100;
    this.minPrice = 0;
    this.maxPrice = 100;
    this.isDraggingPriceScale = false;
    this.isDraggingTimeScale = false;
    this.initialScaleMultiplier = 1.0;
    this.initialVisibleCount = 60;
    this.initialCenterOffset = 0;

    // Feature toggles
    this.showCmpLaser = true;
    this.showHighLowMarkers = true;
    this.showGrid = true;
    this.showCandleSpotlight = true;
    this.showTooltip = true;

    this._listeners = [];
    this.initEvents();
    this.resize();
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  _on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    this._listeners.push([target, type, handler, opts]);
  }

  destroy() {
    this._listeners.forEach(([t, ty, h, o]) => t.removeEventListener(ty, h, o));
    this._listeners = [];
    if (this._ro) this._ro.disconnect();
  }

  _rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _niceStep(range, target) {
    const rough = range / Math.max(1, target);
    const pow = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const f = rough / pow;
    const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
    return nice * pow;
  }

  _fmtPrice(p) {
    return `₹${p.toFixed(2)}`;
  }

  _fmtVol(v) {
    if (!v) return '-';
    return v >= 1e7 ? (v / 1e7).toFixed(2) + 'Cr' :
      v >= 1e5 ? (v / 1e5).toFixed(2) + 'L' :
        v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toLocaleString();
  }

  _initDateFormatters() {
    try {
      this._dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
      this._monFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', month: 'short' });
      this._year2Fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: '2-digit' });
      this._year4Fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric' });
      this._timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
      this._fullFmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
    } catch (e) {
      this._dateFmt = null;
    }
  }

  _getDateInfo(unixSec) {
    const ms = unixSec < 1e11 ? unixSec * 1000 : unixSec;
    const d = new Date(ms);
    if (!this._dateFmt) {
      const mon = d.toLocaleString('en-US', { month: 'short' });
      const day = String(d.getDate()).padStart(2, '0');
      const yr4 = String(d.getFullYear());
      const yr2 = yr4.slice(-2);
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return {
        date: d,
        dayMonth: `${day} ${mon}`,
        month: mon,
        year2: yr2,
        year4: yr4,
        time: time,
        dayMonthYear: `${day} ${mon} '${yr2}`,
        monthYear: `${mon} '${yr2}`,
        fullDate: d.toDateString()
      };
    }
    const dayMonth = this._dateFmt.format(d);
    const month = this._monFmt.format(d);
    const yr2 = this._year2Fmt.format(d);
    const yr4 = this._year4Fmt.format(d);
    const time = this._timeFmt.format(d);
    return {
      date: d,
      dayMonth: dayMonth,
      month: month,
      year2: yr2,
      year4: yr4,
      time: time,
      dayMonthYear: `${dayMonth} '${yr2}`,
      monthYear: `${month} '${yr2}`,
      fullDate: this._fullFmt.format(d)
    };
  }

  _isIntraday() {
    if (this.timeframe) {
      return !['1d', '1w', '1M', '3M', '6M', '1Y'].includes(this.timeframe);
    }
    if (this.candles.length < 2) return false;
    const sampleSize = Math.min(10, this.candles.length - 1);
    let intradayHits = 0;
    for (let i = this.candles.length - 1; i > this.candles.length - 1 - sampleSize; i--) {
      const diff = Math.abs(this.candles[i].time - this.candles[i - 1].time);
      if (diff > 0 && diff <= 14400) intradayHits++;
    }
    return intradayHits >= Math.ceil(sampleSize / 2);
  }

  _isMonthlyOrHigher() {
    if (this.timeframe) {
      return ['1M', '3M', '6M', '1Y'].includes(this.timeframe);
    }
    return false;
  }

  _hoveredIndexAbs() {
    // absolute candle index under the pointer
    if (!this.view || !this.hoverPoint) return -1;
    const { startIndex, slot, count, plotWidth } = this.view;
    if (this.hoverPoint.x < 0 || this.hoverPoint.x > plotWidth) return -1;
    const i = Math.min(count - 1, Math.max(0, Math.floor(this.hoverPoint.x / slot)));
    return startIndex + i;
  }

  /* ------------------------------------------------------------------ */
  /* Public API (unchanged)                                              */
  /* ------------------------------------------------------------------ */

  requestRender() {
    if (this.renderRequested) return;
    this.renderRequested = true;
    requestAnimationFrame(() => {
      this.renderRequested = false;
      this.render();
    });
  }

  resetPriceScale() {
    this.autoPriceScale = true;
    this.priceScaleMultiplier = 1.0;
    this.priceCenterOffset = 0;
    this.requestRender();
  }

  setTimeframe(tf) {
    if (!tf || this.timeframe === tf) return;
    this.timeframe = tf;
    this.requestRender();
  }

  setTheme(themeName) {
    this.options.theme = themeName;
    if (themeName === 'light') {
      Object.assign(this.options, {
        gridColor: 'rgba(203, 213, 225, 0.6)',
        textColor: '#475569',
        crosshairColor: 'rgba(71, 85, 105, 0.45)',
        demandColor: 'rgba(5, 150, 105, 0.16)',
        demandBorder: '#059669',
        supplyColor: 'rgba(225, 29, 72, 0.16)',
        supplyBorder: '#e11d48',
        bullishColor: '#059669',
        bearishColor: '#dc2626',
        volumeBullish: 'rgba(5, 150, 105, 0.28)',
        volumeBearish: 'rgba(220, 38, 38, 0.28)',
        tooltipBg: 'rgba(255, 255, 255, 0.97)',
        tooltipBorder: '#cbd5e1',
        tooltipText: '#0f172a',
        tooltipMuted: '#64748b',
        pillBg: '#ffffff',
        pillText: '#0f172a',
        spotlight: 'rgba(15, 23, 42, 0.05)',
        axisLine: '#cbd5e1'
      });
    } else {
      Object.assign(this.options, {
        gridColor: '#1e2430',
        textColor: '#94a3b8',
        crosshairColor: 'rgba(148, 163, 184, 0.6)',
        demandColor: 'rgba(16, 185, 129, 0.18)',
        demandBorder: '#10b981',
        supplyColor: 'rgba(244, 63, 94, 0.18)',
        supplyBorder: '#f43f5e',
        bullishColor: '#089981',
        bearishColor: '#f23645',
        volumeBullish: 'rgba(8, 153, 129, 0.28)',
        volumeBearish: 'rgba(242, 54, 69, 0.28)',
        tooltipBg: 'rgba(15, 23, 42, 0.96)',
        tooltipBorder: '#334155',
        tooltipText: '#e2e8f0',
        tooltipMuted: '#94a3b8',
        pillBg: '#0f172a',
        pillText: '#f8fafc',
        spotlight: 'rgba(255, 255, 255, 0.05)',
        axisLine: '#263041'
      });
    }
    this.requestRender();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width || this.width;
    this.height = rect.height || this.height;

    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.requestRender();
  }

  setData(candles, zones = []) {
    this.candles = candles || [];
    this.zones = zones || [];
    this.calculateIndicators();
    this.fitContent();
    if (this.candles.length) {
      this.updateLegendWithCandle(this.candles[this.candles.length - 1]);
    }
  }

  // Refresh candles and zones without snapping the viewport back to fit.
  applyLiveUpdate(candles, zones = []) {
    const followLive = (this.offsetIndex || 0) === 0;
    const prevVisible = this.visibleCount;
    const autoScale = this.autoPriceScale !== false;
    this.candles = candles || [];
    this.zones = zones || [];
    this.calculateIndicators();
    if (!this.candles.length) {
      this.requestRender();
      return;
    }
    if (!this.hasFitted) {
      this.fitContent();
      return;
    }
    this.visibleCount = Math.max(4, Math.min(this.candles.length, prevVisible));
    if (followLive) this.offsetIndex = 0;
    else this.offsetIndex = Math.max(0, Math.min(Math.max(0, this.candles.length - this.visibleCount), this.offsetIndex || 0));
    if (this.lastHoveredIndex < 0) {
      this.updateLegendWithCandle(this.candles[this.candles.length - 1]);
    }
    if (followLive && autoScale) this.resetPriceScale();
    else this.requestRender();
  }

  setZones(zones) {
    this.zones = zones || [];
    this.requestRender();
  }

  setIndicator(name, active) {
    this.indicators[name] = !!active;
    this.requestRender();
  }

  toggleCmpLaser() {
    this.showCmpLaser = !this.showCmpLaser;
    this.requestRender();
    return this.showCmpLaser;
  }

  toggleHighLowMarkers() {
    this.showHighLowMarkers = !this.showHighLowMarkers;
    this.requestRender();
    return this.showHighLowMarkers;
  }

  toggleGrid() {
    this.showGrid = !this.showGrid;
    this.requestRender();
    return this.showGrid;
  }

  toggleSpotlight() {
    this.showCandleSpotlight = !this.showCandleSpotlight;
    this.requestRender();
    return this.showCandleSpotlight;
  }

  toggleTooltip() {
    this.showTooltip = !this.showTooltip;
    this.requestRender();
    return this.showTooltip;
  }

  updateLegendWithCandle(candle) {
    const infoEl = document.getElementById('chart-legend-ohlc');
    if (!infoEl || !candle) return;
    const change = candle.close - candle.open;
    const pct = candle.open > 0 ? (change / candle.open) * 100 : 0;
    const isUp = change >= 0;
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const bodyPct = range > 0 ? Math.round((body / range) * 100) : 0;
    const info = this._getDateInfo(candle.time);
    const dateStr = info.dayMonthYear + (this._isIntraday() ? ` ${info.time}` : '');

    let volStr = '-';
    if (candle.volume) {
      volStr = candle.volume >= 1e6 ? (candle.volume / 1e6).toFixed(2) + 'M' :
        candle.volume >= 1e3 ? (candle.volume / 1e3).toFixed(1) + 'K' :
          candle.volume.toLocaleString();
    }

    infoEl.innerHTML = `
      <span style="color:#e2e8f0;font-weight:600;padding-right:6px;border-right:1px solid rgba(255,255,255,0.15)">${dateStr}</span>
      <span>O: <b>${candle.open.toFixed(2)}</b></span>
      <span>H: <b>${candle.high.toFixed(2)}</b></span>
      <span>L: <b>${candle.low.toFixed(2)}</b></span>
      <span>C: <b>${candle.close.toFixed(2)}</b></span>
      <span style="color:${isUp ? '#10b981' : '#ef4444'};font-weight:700">${isUp ? '+' : ''}${change.toFixed(2)} (${isUp ? '+' : ''}${pct.toFixed(2)}%)</span>
      <span style="color:var(--text-muted)">Range: <b style="color:var(--text-main)">₹${range.toFixed(2)}</b></span>
      <span style="color:var(--text-muted)">Body: <b style="color:var(--text-main)">${bodyPct}%</b></span>
      <span>Vol: <b>${volStr}</b></span>
    `;
  }

  calculateIndicators() {
    const calcEMA = (period) => {
      if (!this.candles.length) return [];
      const k = 2 / (period + 1);
      const ema = [];
      let prev = this.candles[0].close;
      ema.push(prev);
      for (let i = 1; i < this.candles.length; i++) {
        prev = this.candles[i].close * k + prev * (1 - k);
        ema.push(prev);
      }
      return ema;
    };

    this.emaData = {
      ema20: calcEMA(20),
      ema50: calcEMA(50),
      ema100: calcEMA(100),
      ema200: calcEMA(200)
    };
  }

  fitContent() {
    if (!this.candles.length) return;
    // Wider candles by default (~14px per slot) so every bar is easy to read
    const plotW = this.width - this.rightMargin;
    this.visibleCount = Math.max(4, Math.min(this.candles.length, Math.floor(plotW / 14)));
    this.offsetIndex = 0;
    this.hasFitted = true;
    this.resetPriceScale();
    this.requestRender();
  }

  zoomAt(mouseX, factor) {
    if (!this.candles.length) return;
    const plotWidth = this.width - this.rightMargin;
    const clampedMouseX = Math.max(0, Math.min(plotWidth, mouseX != null ? mouseX : plotWidth / 2));
    const ratio = clampedMouseX / plotWidth;

    const oldVisible = this.visibleCount;
    const newVisible = Math.max(4, Math.min(this.candles.length, Math.round(oldVisible * factor)));
    if (newVisible === oldVisible) {
      // rounding can swallow small factors; nudge by one candle
      if (factor < 1 && oldVisible > 4) return this.zoomAt(mouseX, (oldVisible - 1) / oldVisible);
      if (factor > 1 && oldVisible < this.candles.length) return this.zoomAt(mouseX, (oldVisible + 1) / oldVisible);
      return;
    }

    const total = this.candles.length;
    const oldEndIndex = total - this.offsetIndex;
    const oldStartIndex = Math.max(0, oldEndIndex - oldVisible);
    const anchorIndex = oldStartIndex + ratio * oldVisible;
    const newStartIndex = Math.round(anchorIndex - ratio * newVisible);
    const newEndIndex = newStartIndex + newVisible;

    this.visibleCount = newVisible;
    this.offsetIndex = Math.max(0, Math.min(total - newVisible, total - newEndIndex));
    this.requestRender();
  }

  zoomIn() { this.zoomAt((this.width - this.rightMargin) / 2, 0.75); }
  zoomOut() { this.zoomAt((this.width - this.rightMargin) / 2, 1.33); }

  panBy(candles) {
    const maxOff = Math.max(0, this.candles.length - this.visibleCount);
    this.offsetIndex = Math.max(0, Math.min(maxOff, this.offsetIndex + candles));
    this.requestRender();
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  initEvents() {
    this._on(window, 'resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(this.container);
    }

    this._on(this.canvas, 'mousedown', (e) => {
      this.canvas.focus({ preventScroll: true });
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotWidth = this.width - this.rightMargin;

      if (x >= plotWidth && y >= this.height - this.bottomMargin) {
        this.resetPriceScale();
        return;
      }
      if (x >= plotWidth) {
        this.isDraggingPriceScale = true;
        this.dragStartY = e.clientY;
        this.initialScaleMultiplier = this.priceScaleMultiplier;
        return;
      }
      if (y >= this.height - this.bottomMargin) {
        this.isDraggingTimeScale = true;
        this.dragStartX = e.clientX;
        this.initialVisibleCount = this.visibleCount;
        return;
      }

      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartOffset = this.offsetIndex;
      this.initialCenterOffset = this.priceCenterOffset;
      this.hoverPoint = { x, y };
      this.checkZoneClick(e);
    });

    this._on(this.canvas, 'mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotWidth = this.width - this.rightMargin;

      if (x >= plotWidth && y >= this.height - this.bottomMargin) this.canvas.style.cursor = 'pointer';
      else if (x >= plotWidth) this.canvas.style.cursor = 'ns-resize';
      else if (y >= this.height - this.bottomMargin) this.canvas.style.cursor = 'ew-resize';
      else this.canvas.style.cursor = this.isDragging ? 'grabbing' : 'crosshair';

      this.hoverPoint = { x, y };
      this.requestRender();
    });

    this._on(this.canvas, 'mouseleave', () => {
      this.hoverPoint = null;
      this.lastHoveredIndex = -1;
      if (this.candles.length) this.updateLegendWithCandle(this.candles[this.candles.length - 1]);
      this.requestRender();
    });

    this._on(window, 'mousemove', (e) => {
      if (this.isDraggingPriceScale) {
        const dy = e.clientY - this.dragStartY;
        this.autoPriceScale = false;
        const factor = Math.exp(-dy * 0.008);
        this.priceScaleMultiplier = Math.max(0.04, Math.min(25, this.initialScaleMultiplier * factor));
        this.requestRender();
        return;
      }
      if (this.isDraggingTimeScale) {
        const dx = e.clientX - this.dragStartX;
        const factor = Math.exp(-dx * 0.005);
        this.visibleCount = Math.max(4, Math.min(this.candles.length, Math.round(this.initialVisibleCount * factor)));
        this.requestRender();
        return;
      }
      if (this.isDragging) {
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        const slot = this.view ? this.view.slot : (this.candleWidth + this.candleSpacing);
        const shiftCandles = Math.round(dx / (slot || 1));
        const maxOff = Math.max(0, this.candles.length - this.visibleCount);
        this.offsetIndex = Math.max(0, Math.min(maxOff, this.dragStartOffset + shiftCandles));

        if (!this.autoPriceScale) {
          const chartHeight = this.height - this.bottomMargin - this.topMargin;
          const pricePerPx = (this.maxPrice - this.minPrice) / (chartHeight || 1);
          this.priceCenterOffset = this.initialCenterOffset + dy * pricePerPx;
        }
        this.requestRender();
      }
    });

    this._on(window, 'mouseup', () => {
      this.isDragging = false;
      this.isDraggingPriceScale = false;
      this.isDraggingTimeScale = false;
    });

    this._on(this.canvas, 'dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotWidth = this.width - this.rightMargin;
      if (x >= plotWidth) this.resetPriceScale();
      else if (y >= this.height - this.bottomMargin) this.fitContent();
      else { this.resetPriceScale(); this.fitContent(); }
    });

    this._on(this.canvas, 'wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      if (e.shiftKey) {
        // Shift + wheel pans
        const d = (e.deltaY || e.deltaX) > 0 ? -3 : 3;
        this.panBy(d);
        return;
      }
      this.zoomAt(mouseX, e.deltaY < 0 ? 0.85 : 1.18);
    }, { passive: false });

    // Keyboard: step through candles & zoom
    this._on(this.canvas, 'keydown', (e) => {
      if (!this.candles.length || !this.view) return;
      const { startIndex, count, slot } = this.view;
      let handled = true;
      const cur = this._hoveredIndexAbs();
      const setHoverTo = (abs) => {
        abs = Math.max(0, Math.min(this.candles.length - 1, abs));
        if (abs < startIndex) this.panBy(startIndex - abs);
        else if (abs >= startIndex + count) this.panBy(-(abs - (startIndex + count - 1)));
        // recompute after potential pan: the view updates on render, so estimate
        const endIdx = Math.max(0, this.candles.length - this.offsetIndex);
        const newStart = Math.max(0, endIdx - this.visibleCount);
        const c = this.candles[abs];
        this.hoverPoint = {
          x: (abs - newStart) * slot + slot / 2,
          y: this.hoverPoint ? this.hoverPoint.y : this.priceToY(c.close)
        };
        this.requestRender();
      };
      switch (e.key) {
        case 'ArrowLeft': setHoverTo((cur < 0 ? this.candles.length - 1 - this.offsetIndex : cur) - 1); break;
        case 'ArrowRight': setHoverTo((cur < 0 ? this.candles.length - 1 - this.offsetIndex : cur) + 1); break;
        case 'Home': this.offsetIndex = Math.max(0, this.candles.length - this.visibleCount); this.requestRender(); break;
        case 'End': this.offsetIndex = 0; this.requestRender(); break;
        case '+': case '=': this.zoomIn(); break;
        case '-': case '_': this.zoomOut(); break;
        case '0': this.resetPriceScale(); this.fitContent(); break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    });

    // Touch: drag to pan, pinch to zoom, tap to inspect
    let touchMode = null, pinchStartDist = 0, pinchStartVisible = 0, tStartX = 0, tStartOffset = 0;
    const tpos = (t) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    this._on(this.canvas, 'touchstart', (e) => {
      if (e.touches.length === 2) {
        touchMode = 'pinch';
        pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        pinchStartVisible = this.visibleCount;
      } else if (e.touches.length === 1) {
        touchMode = 'pan';
        tStartX = e.touches[0].clientX;
        tStartOffset = this.offsetIndex;
        this.hoverPoint = tpos(e.touches[0]);
        this.requestRender();
      }
      e.preventDefault();
    }, { passive: false });
    this._on(this.canvas, 'touchmove', (e) => {
      if (touchMode === 'pinch' && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const target = Math.max(4, Math.min(this.candles.length, Math.round(pinchStartVisible * (pinchStartDist / (d || 1)))));
        this.visibleCount = target;
        this.offsetIndex = Math.max(0, Math.min(Math.max(0, this.candles.length - target), this.offsetIndex));
        this.requestRender();
      } else if (touchMode === 'pan' && e.touches.length === 1) {
        const slot = this.view ? this.view.slot : 10;
        const dx = e.touches[0].clientX - tStartX;
        const maxOff = Math.max(0, this.candles.length - this.visibleCount);
        this.offsetIndex = Math.max(0, Math.min(maxOff, tStartOffset + Math.round(dx / slot)));
        this.hoverPoint = tpos(e.touches[0]);
        this.requestRender();
      }
      e.preventDefault();
    }, { passive: false });
    this._on(this.canvas, 'touchend', () => { touchMode = null; });
  }

  checkZoneClick() {
    if (!this.hoverPoint || !this.zones.length) return;
    const { y } = this.hoverPoint;
    const clicked = this.zones.find(z => {
      const yTop = this.priceToY(z.top);
      const yBottom = this.priceToY(z.bottom);
      const min = Math.min(yTop, yBottom);
      const max = Math.max(yTop, yBottom);
      return y >= min - 4 && y <= max + 4;
    });
    if (clicked) {
      this.selectedZone = clicked;
      if (this.onZoneSelect) this.onZoneSelect(clicked);
      this.requestRender();
    }
  }

  priceToY(price) {
    const chartHeight = this.height - this.bottomMargin - this.topMargin;
    const norm = (price - this.minPrice) / (this.maxPrice - this.minPrice || 1);
    return this.height - this.bottomMargin - norm * chartHeight;
  }

  yToPrice(y) {
    const chartHeight = this.height - this.bottomMargin - this.topMargin;
    const norm = (this.height - this.bottomMargin - y) / chartHeight;
    return this.minPrice + norm * (this.maxPrice - this.minPrice);
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  render() {
    if (!this.ctx || !this.candles.length) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const opt = this.options;

    ctx.clearRect(0, 0, w, h);
    ctx.setLineDash([]);

    // Visible slice
    const total = this.candles.length;
    const endIndex = Math.max(0, Math.min(total, total - this.offsetIndex));
    const startIndex = Math.max(0, endIndex - this.visibleCount);
    const visibleCandles = this.candles.slice(startIndex, endIndex);
    if (!visibleCandles.length) return;

    // Price bounds
    let minP = Infinity, maxP = -Infinity, maxVol = 0;
    for (const c of visibleCandles) {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
    }

    const candleSpan = maxP - minP;
    for (const z of this.zones) {
      if (z.top && z.bottom && z.top >= minP - candleSpan * 0.35 && z.bottom <= maxP + candleSpan * 0.35) {
        if (z.top > maxP) maxP = Math.max(maxP, z.top * 1.01);
        if (z.bottom < minP) minP = Math.min(minP, z.bottom * 0.99);
      }
    }

    const pad = (maxP - minP) * 0.10 || 1;
    this.baseMinPrice = minP - pad;
    this.baseMaxPrice = maxP + pad;

    if (this.autoPriceScale) {
      this.minPrice = this.baseMinPrice;
      this.maxPrice = this.baseMaxPrice;
      this.priceScaleMultiplier = 1.0;
      this.priceCenterOffset = 0;
    } else {
      const baseSpan = Math.max(0.5, this.baseMaxPrice - this.baseMinPrice);
      const currentSpan = Math.max(0.2, baseSpan * this.priceScaleMultiplier);
      const mid = (this.baseMinPrice + this.baseMaxPrice) / 2 + this.priceCenterOffset;
      this.minPrice = mid - currentSpan / 2;
      this.maxPrice = mid + currentSpan / 2;
    }

    const plotWidth = w - this.rightMargin;
    const plotHeight = h - this.bottomMargin - this.topMargin;
    const plotBottom = h - this.bottomMargin;
    const candleSlot = plotWidth / visibleCandles.length;
    this.candleWidth = Math.max(1.5, Math.min(70, candleSlot * 0.72));
    this.candleSpacing = candleSlot - this.candleWidth;

    this.view = { startIndex, count: visibleCandles.length, slot: candleSlot, plotWidth, plotHeight };

    const intraday = this._isIntraday();
    const hoveredAbs = this._hoveredIndexAbs();
    const hoveredIdx = hoveredAbs >= 0 ? hoveredAbs - startIndex : -1;

    // ---------- Grid + axis labels ----------
    ctx.font = '11px Inter, sans-serif';
    const pStep = this._niceStep(this.maxPrice - this.minPrice, Math.max(3, Math.round(plotHeight / 55)));
    const firstTick = Math.ceil(this.minPrice / pStep) * pStep;
    const decimals = pStep >= 1 ? (pStep % 1 === 0 ? 0 : 1) : Math.min(4, Math.ceil(-Math.log10(pStep)) + 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.topMargin - 6, w, plotHeight + 12);
    ctx.clip();
    for (let p = firstTick; p <= this.maxPrice; p += pStep) {
      const y = Math.round(this.priceToY(p)) + 0.5;
      if (this.showGrid) {
        ctx.strokeStyle = opt.gridColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = opt.textColor;
      ctx.textAlign = 'left';
      ctx.fillText(`₹${p.toFixed(decimals)}`, plotWidth + 8, y + 4);
    }
    ctx.restore();

    // Time ticks (vertical grid + labels)
    const minLabelPx = intraday ? 68 : 80;
    const timeStep = Math.max(1, Math.ceil(minLabelPx / candleSlot));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let prevInfo = null;

    for (let i = 0; i < visibleCandles.length; i += timeStep) {
      const c = visibleCandles[i];
      const x = Math.round(i * candleSlot + candleSlot / 2) + 0.5;
      const info = this._getDateInfo(c.time);

      const isNewDay = !prevInfo || prevInfo.dayMonth !== info.dayMonth;
      const isNewMonth = !prevInfo || prevInfo.month !== info.month;
      const isNewYear = !prevInfo || prevInfo.year4 !== info.year4;

      if (this.showGrid) {
        ctx.strokeStyle = (intraday && isNewDay && prevInfo) ? (opt.axisLine || '#334155') : opt.gridColor;
        ctx.lineWidth = 1;
        ctx.setLineDash((intraday && isNewDay && prevInfo) ? [] : [2, 4]);
        ctx.beginPath();
        ctx.moveTo(x, this.topMargin);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Format bottom axis label
      if (this._isMonthlyOrHigher()) {
        const emphasize = isNewYear;
        ctx.font = emphasize ? 'bold 11px Inter, sans-serif' : '11px Inter, sans-serif';
        ctx.fillStyle = emphasize ? opt.tooltipText : opt.textColor;
        const textX = Math.max(30, Math.min(plotWidth - 30, x));
        ctx.fillText(info.monthYear, textX, h - this.bottomMargin / 2);
      } else if (intraday) {
        if (isNewDay) {
          // Day boundary: top line date (bold), bottom line time
          ctx.font = 'bold 10px Inter, sans-serif';
          ctx.fillStyle = opt.tooltipText;
          const textX = Math.max(26, Math.min(plotWidth - 26, x));
          ctx.fillText(info.dayMonth, textX, h - this.bottomMargin + 9);
          ctx.font = '10px Inter, sans-serif';
          ctx.fillStyle = opt.textColor;
          ctx.fillText(info.time, textX, h - this.bottomMargin + 21);
        } else {
          ctx.font = '11px Inter, sans-serif';
          ctx.fillStyle = opt.textColor;
          const textX = Math.max(20, Math.min(plotWidth - 20, x));
          ctx.fillText(info.time, textX, h - this.bottomMargin / 2);
        }
      } else {
        // Daily / Weekly
        const emphasize = isNewYear || isNewMonth || !prevInfo;
        ctx.font = emphasize ? 'bold 11px Inter, sans-serif' : '11px Inter, sans-serif';
        ctx.fillStyle = emphasize ? opt.tooltipText : opt.textColor;
        const label = (isNewYear || !prevInfo) ? info.dayMonthYear : info.dayMonth;
        const labelW = ctx.measureText(label).width;
        const textX = Math.max(labelW / 2 + 4, Math.min(plotWidth - labelW / 2 - 4, x));
        ctx.fillText(label, textX, h - this.bottomMargin / 2);
      }

      prevInfo = info;
    }

    // Axis lines
    ctx.strokeStyle = opt.axisLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotWidth + 0.5, 0);
    ctx.lineTo(plotWidth + 0.5, plotBottom);
    ctx.moveTo(0, plotBottom + 0.5);
    ctx.lineTo(w, plotBottom + 0.5);
    ctx.stroke();

    // ---------- Clipped plot content ----------
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotWidth, plotBottom);
    ctx.clip();

    // Hover column spotlight (under everything else)
    if (this.showCandleSpotlight && hoveredIdx >= 0) {
      ctx.fillStyle = opt.spotlight;
      ctx.fillRect(hoveredIdx * candleSlot, this.topMargin, candleSlot, plotHeight);
    }

    this.drawZones(ctx, plotWidth);
    this.drawIndicators(ctx, startIndex, visibleCandles, candleSlot);

    // Candles & volume
    const volMax = plotHeight * 0.18;
    visibleCandles.forEach((c, idx) => {
      const cx = idx * candleSlot + candleSlot / 2;
      const isBull = c.close >= c.open;
      const color = isBull ? opt.bullishColor : opt.bearishColor;
      const isHover = idx === hoveredIdx;

      // Volume bar
      const volHeight = maxVol > 0 ? Math.max(1, (c.volume / maxVol) * volMax) : 0;
      ctx.fillStyle = isBull ? opt.volumeBullish : opt.volumeBearish;
      ctx.fillRect(Math.round(cx - this.candleWidth / 2), plotBottom - volHeight, Math.max(1, Math.round(this.candleWidth)), volHeight);

      // Wick (pixel-aligned)
      const wickWidth = this.candleWidth >= 10 ? 2 : 1;
      const wx = Math.round(cx - wickWidth / 2 + 0.0001) + (wickWidth % 2 ? 0.5 : 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = wickWidth;
      ctx.beginPath();
      ctx.moveTo(wx, Math.round(this.priceToY(c.high)));
      ctx.lineTo(wx, Math.round(this.priceToY(c.low)));
      ctx.stroke();

      // Body (pixel-aligned)
      const openY = this.priceToY(c.open);
      const closeY = this.priceToY(c.close);
      const bodyW = Math.max(1, Math.round(this.candleWidth));
      const bodyX = Math.round(cx - bodyW / 2);
      const bodyTop = Math.round(Math.min(openY, closeY));
      const bodyH = Math.max(2, Math.round(Math.abs(closeY - openY)));

      ctx.fillStyle = color;
      ctx.fillRect(bodyX, bodyTop, bodyW, bodyH);

      // Crisp edge so adjacent bars stay distinct when zoomed in
      if (bodyW >= 6) {
        ctx.strokeStyle = isBull ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(bodyX + 0.5, bodyTop + 0.5, bodyW - 1, Math.max(1, bodyH - 1));
      }

      // Doji crossbar
      if (Math.abs(closeY - openY) < 1.5) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bodyX, Math.round(openY) + 0.5);
        ctx.lineTo(bodyX + bodyW, Math.round(openY) + 0.5);
        ctx.stroke();
      }

      // Hover inspector: outline + open/close ticks
      if (isHover) {
        const hiY = Math.round(this.priceToY(c.high));
        const loY = Math.round(this.priceToY(c.low));
        ctx.strokeStyle = opt.tooltipText;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.strokeRect(bodyX - 1.5, bodyTop - 1.5, bodyW + 3, bodyH + 3);
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(cx - candleSlot * 0.5) + 1.5, hiY - 3, Math.max(4, candleSlot - 3), Math.max(6, loY - hiY + 6));

        const tick = Math.max(4, Math.min(10, this.candleWidth * 0.6));
        ctx.lineWidth = 2;
        ctx.strokeStyle = opt.tooltipText;
        ctx.beginPath();
        ctx.moveTo(bodyX - tick, Math.round(openY) + 0.5); // open tick (left)
        ctx.lineTo(bodyX, Math.round(openY) + 0.5);
        ctx.moveTo(bodyX + bodyW, Math.round(closeY) + 0.5); // close tick (right)
        ctx.lineTo(bodyX + bodyW + tick, Math.round(closeY) + 0.5);
        ctx.stroke();
      }
    });

    // High / Low markers
    if (this.showHighLowMarkers && visibleCandles.length > 3) {
      let hiIdx = 0, loIdx = 0, hiVal = -Infinity, loVal = Infinity;
      visibleCandles.forEach((c, idx) => {
        if (c.high > hiVal) { hiVal = c.high; hiIdx = idx; }
        if (c.low < loVal) { loVal = c.low; loIdx = idx; }
      });
      this.drawPeakMarker(ctx, hiIdx * candleSlot + candleSlot / 2, this.priceToY(hiVal), hiVal, true);
      this.drawPeakMarker(ctx, loIdx * candleSlot + candleSlot / 2, this.priceToY(loVal), loVal, false);
    }

    // CMP laser line
    let cmpBadge = null;
    if (this.showCmpLaser) {
      const latest = this.candles[this.candles.length - 1];
      const prev = this.candles.length > 1 ? this.candles[this.candles.length - 2] : latest;
      const cmp = latest.close;
      const cmpY = Math.round(this.priceToY(cmp)) + 0.5;
      const laserColor = cmp >= prev.close ? opt.bullishColor : opt.bearishColor;
      if (cmpY >= this.topMargin && cmpY <= plotBottom) {
        ctx.strokeStyle = laserColor;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, cmpY);
        ctx.lineTo(plotWidth, cmpY);
        ctx.stroke();
        ctx.setLineDash([]);
        if (this.offsetIndex === 0) {
          ctx.fillStyle = laserColor;
          ctx.beginPath();
          ctx.arc(plotWidth - 5, cmpY, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        cmpBadge = { y: cmpY, color: laserColor, price: cmp };
      }
    }

    // Crosshair + spotlight tooltip
    if (this.hoverPoint && this.hoverPoint.x >= 0 && this.hoverPoint.x <= plotWidth && this.hoverPoint.y <= plotBottom) {
      this.drawCrosshairLines(ctx, plotWidth, plotBottom);
    }
    ctx.restore();

    // ---------- Axis badges (outside clip) ----------
    if (cmpBadge) {
      const badgeW = this.rightMargin - 6, badgeH = 20;
      const badgeX = plotWidth + 3, badgeY = cmpBadge.y - badgeH / 2;
      ctx.fillStyle = cmpBadge.color;
      this._rr(ctx, badgeX, badgeY, badgeW, badgeH, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(this._fmtPrice(cmpBadge.price), badgeX + badgeW / 2, badgeY + 14);
    }

    // O/H/L/C guides on the price axis for the hovered candle
    if (hoveredIdx >= 0) {
      const c = visibleCandles[hoveredIdx];
      const items = [
        ['H', c.high, '#f59e0b'], ['L', c.low, '#38bdf8'],
        ['O', c.open, opt.textColor], ['C', c.close, c.close >= c.open ? opt.bullishColor : opt.bearishColor]
      ];
      ctx.font = 'bold 9.5px Inter, sans-serif';
      ctx.textAlign = 'left';
      for (const [tag, val, col] of items) {
        const y = this.priceToY(val);
        if (y < this.topMargin || y > plotBottom) continue;
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.max(0, hoveredIdx * candleSlot - 6), Math.round(y) + 0.5);
        ctx.lineTo(plotWidth, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.fillText(`${tag}`, plotWidth + 3, y + 3.5);
      }
    }

    // Crosshair axis pills
    if (this.hoverPoint && this.hoverPoint.x >= 0 && this.hoverPoint.x <= plotWidth && this.hoverPoint.y <= plotBottom && hoveredIdx >= 0) {
      this.drawCrosshairPills(ctx, plotWidth, h, visibleCandles[hoveredIdx], intraday);
      if (this.lastHoveredIndex !== hoveredIdx) {
        this.lastHoveredIndex = hoveredIdx;
        this.updateLegendWithCandle(visibleCandles[hoveredIdx]);
      }
      if (this.showTooltip && !this.isDragging) {
        this.drawTooltip(ctx, plotWidth, plotBottom, hoveredIdx, visibleCandles, candleSlot, startIndex, intraday);
      }
    }

    // [AUTO] button
    const autoBoxX = plotWidth + 6, autoBoxY = h - this.bottomMargin + 5;
    const autoBoxW = this.rightMargin - 12, autoBoxH = this.bottomMargin - 10;
    ctx.fillStyle = this.autoPriceScale ? 'rgba(30, 41, 59, 0.7)' : 'rgba(59, 130, 246, 0.25)';
    ctx.strokeStyle = this.autoPriceScale ? '#334155' : '#3b82f6';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    this._rr(ctx, autoBoxX, autoBoxY, autoBoxW, autoBoxH, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = this.autoPriceScale ? '#94a3b8' : '#60a5fa';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('AUTO', autoBoxX + autoBoxW / 2, autoBoxY + autoBoxH / 2 + 3.5);
  }

  drawPeakMarker(ctx, x, y, price, isHigh) {
    const label = `${isHigh ? '▼ H:' : '▲ L:'} ₹${price.toFixed(2)}`;
    ctx.font = 'bold 10px Inter, sans-serif';
    const textWidth = ctx.measureText(label).width;
    const boxW = textWidth + 12, boxH = 18;
    const maxX = this.width - this.rightMargin - boxW - 4;
    const boxX = Math.max(4, Math.min(maxX, x - boxW / 2));
    let boxY = isHigh ? y - boxH - 8 : y + 8;
    boxY = Math.max(this.topMargin - 2, Math.min(this.height - this.bottomMargin - boxH - 2, boxY));
    const col = isHigh ? '#f43f5e' : '#10b981';

    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, isHigh ? boxY + boxH : boxY);
    ctx.stroke();

    ctx.fillStyle = this.options.theme === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(15, 23, 42, 0.88)';
    this._rr(ctx, boxX, boxY, boxW, boxH, 4);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.stroke();

    ctx.fillStyle = isHigh ? '#fb7185' : '#34d399';
    ctx.textAlign = 'center';
    ctx.fillText(label, boxX + boxW / 2, boxY + 13);
  }

  drawZones(ctx, plotWidth) {
    const cmp = this.candles.length ? this.candles[this.candles.length - 1].close : null;
    const plotTop = this.topMargin;
    const plotBottom = this.height - this.bottomMargin;

    for (const z of this.zones) {
      const yTop = this.priceToY(z.top);
      const yBottom = this.priceToY(z.bottom);
      const zMin = Math.min(yTop, yBottom), zMax = Math.max(yTop, yBottom);
      if (zMax < plotTop || zMin > plotBottom) continue; // fully off-screen

      const isDemand = z.type === 'demand';
      const isSelected = this.selectedZone && this.selectedZone.id === z.id;
      const fillColor = isDemand ? this.options.demandColor : this.options.supplyColor;
      const strokeColor = isDemand ? this.options.demandBorder : this.options.supplyBorder;

      ctx.fillStyle = isSelected ? (isDemand ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)') : fillColor;
      ctx.fillRect(0, zMin, plotWidth, Math.max(1, zMax - zMin));

      // Proximal (dotted)
      const proximalY = Math.round(this.priceToY(z.proximal)) + 0.5;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isSelected ? 2 : 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, proximalY);
      ctx.lineTo(plotWidth, proximalY);
      ctx.stroke();

      // Distal (solid)
      const distalY = Math.round(this.priceToY(z.distal)) + 0.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, distalY);
      ctx.lineTo(plotWidth, distalY);
      ctx.stroke();

      let distanceTag = '';
      if (cmp != null) {
        if (cmp >= z.bottom && cmp <= z.top) {
          distanceTag = ' · ★ IN ZONE ★';
        } else {
          const diffPct = ((cmp - z.proximal) / cmp) * 100;
          distanceTag = ` · ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
        }
      }

      const scoreStr = z.score ? ` · ${z.score.toFixed(1)}` : '';
      const decScoreStr = z.decisionScore ? ` (Dec ${z.decisionScore.toFixed(1)})` : '';
      const tagText = `${isDemand ? 'DZ' : 'SZ'} ${z.pattern || 'RBR'}${scoreStr}${decScoreStr}${distanceTag}`;

      ctx.font = 'bold 10px Inter, sans-serif';
      const tw = ctx.measureText(tagText).width + 14;
      // keep tag inside the visible plot vertically
      const midY = Math.max(plotTop + 12, Math.min(plotBottom - 12, (zMin + zMax) / 2));

      ctx.fillStyle = isDemand ? '#064e3b' : '#7f1d1d';
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      this._rr(ctx, plotWidth - tw - 8, midY - 10, tw, 20, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(tagText, plotWidth - tw / 2 - 8, midY + 3.5);
    }
  }

  drawIndicators(ctx, startIndex, visibleCandles, candleSlot) {
    const drawLine = (data, color, label) => {
      if (!data || !data.length) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      let started = false, lastX = 0, lastY = 0;
      for (let i = 0; i < visibleCandles.length; i++) {
        const val = data[startIndex + i];
        if (val == null) continue;
        const x = i * candleSlot + candleSlot / 2;
        const y = this.priceToY(val);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastX = x; lastY = y;
      }
      ctx.stroke();
      if (started) {
        ctx.font = 'bold 9.5px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = color;
        ctx.fillText(label, lastX - 6, lastY - 5);
      }
    };

    if (this.indicators.ema20) drawLine(this.emaData.ema20, '#3b82f6', 'EMA 20');
    if (this.indicators.ema50) drawLine(this.emaData.ema50, '#f97316', 'EMA 50');
    if (this.indicators.ema100) drawLine(this.emaData.ema100, '#a855f7', 'EMA 100');
    if (this.indicators.ema200) drawLine(this.emaData.ema200, '#eab308', 'EMA 200');
  }

  drawCrosshairLines(ctx, plotWidth, plotBottom) {
    const snapX = Math.round(this.hoverPoint.x) + 0.5;
    const snapY = Math.round(this.hoverPoint.y) + 0.5;
    ctx.strokeStyle = this.options.crosshairColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, snapY);
    ctx.lineTo(plotWidth, snapY);
    ctx.moveTo(snapX, 0);
    ctx.lineTo(snapX, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawCrosshairPills(ctx, plotWidth, h, candle, intraday) {
    const opt = this.options;
    const rawY = this.hoverPoint.y;
    const snapX = Math.round(this.hoverPoint.x) + 0.5;
    const price = this.yToPrice(rawY);

    // Price pill
    ctx.fillStyle = opt.pillBg;
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.fillRect(plotWidth + 2, Math.round(rawY - 10), this.rightMargin - 4, 20);
    ctx.strokeRect(plotWidth + 2.5, Math.round(rawY - 10) + 0.5, this.rightMargin - 5, 19);
    ctx.fillStyle = opt.pillText;
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(this._fmtPrice(price), plotWidth + 6, Math.round(rawY + 4));

    // Date pill
    const info = this._getDateInfo(candle.time);
    let dateStr = info.dayMonthYear;
    if (intraday) {
      dateStr = `${info.dayMonthYear} ${info.time}`;
    } else if (this._isMonthlyOrHigher()) {
      dateStr = info.monthYear;
    }
    ctx.font = 'bold 11px Inter, sans-serif';
    const tbW = ctx.measureText(dateStr).width + 16;
    const tbX = Math.max(4, Math.min(plotWidth - tbW - 4, snapX - tbW / 2));
    const tbY = h - this.bottomMargin + 5;
    ctx.fillStyle = opt.pillBg;
    ctx.strokeStyle = '#38bdf8';
    this._rr(ctx, tbX, tbY, tbW, 20, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = opt.pillText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dateStr, tbX + tbW / 2, tbY + 10);
  }

  drawTooltip(ctx, plotWidth, plotBottom, idx, visibleCandles, slot, startIndex, intraday) {
    const opt = this.options;
    const c = visibleCandles[idx];
    const prev = startIndex + idx > 0 ? this.candles[startIndex + idx - 1] : null;
    const isUp = c.close >= c.open;
    const change = c.close - c.open;
    const pct = c.open > 0 ? (change / c.open) * 100 : 0;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const bodyPct = range > 0 ? Math.round((body / range) * 100) : 0;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const gap = prev ? c.open - prev.close : null;
    const info = this._getDateInfo(c.time);
    const head = `${info.fullDate}${intraday ? '  ' + info.time : ''}`;
    const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
    const accent = isUp ? opt.bullishColor : opt.bearishColor;

    const rows = [
      ['Open', this._fmtPrice(c.open), null],
      ['High', this._fmtPrice(c.high), null],
      ['Low', this._fmtPrice(c.low), null],
      ['Close', this._fmtPrice(c.close), accent],
      ['Change', `${sgn(change)} (${sgn(pct)}%)`, accent],
      ['Range', this._fmtPrice(range), null],
      ['Body', `${bodyPct}%`, null],
      ['Wicks', `▲ ${upperWick.toFixed(2)}   ▼ ${lowerWick.toFixed(2)}`, null],
      ['Volume', this._fmtVol(c.volume), null]
    ];
    if (gap !== null && Math.abs(gap) > 0.0001) rows.splice(5, 0, ['Gap', sgn(gap), gap >= 0 ? opt.bullishColor : opt.bearishColor]);

    const rowH = 17, padX = 12, padY = 10, headH = 20;
    ctx.font = 'bold 11px Inter, sans-serif';
    let maxLabel = 0, maxVal = 0;
    for (const [l, v] of rows) {
      maxLabel = Math.max(maxLabel, ctx.measureText(l).width);
      maxVal = Math.max(maxVal, ctx.measureText(v).width);
    }
    const headW = ctx.measureText(head).width;
    const boxW = Math.max(headW, maxLabel + 18 + maxVal) + padX * 2;
    const boxH = padY * 2 + headH + rows.length * rowH;

    // Place right of the candle, flip left if no room
    const cx = idx * slot + slot / 2;
    const gapPx = Math.max(16, slot * 0.6 + 8);
    let bx = cx + gapPx;
    if (bx + boxW > plotWidth - 4) bx = cx - gapPx - boxW;
    bx = Math.max(4, Math.min(plotWidth - boxW - 4, bx));
    let by = this.hoverPoint.y - boxH / 2;
    by = Math.max(this.topMargin, Math.min(plotBottom - boxH - 4, by));

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = opt.tooltipBg;
    this._rr(ctx, bx, by, boxW, boxH, 8);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = opt.tooltipBorder;
    ctx.lineWidth = 1;
    this._rr(ctx, bx + 0.5, by + 0.5, boxW - 1, boxH - 1, 8);
    ctx.stroke();

    // Accent strip
    ctx.fillStyle = accent;
    this._rr(ctx, bx, by + 8, 3, boxH - 16, 2);
    ctx.fill();

    // Header
    ctx.textAlign = 'left';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillStyle = opt.tooltipText;
    ctx.fillText(head, bx + padX, by + padY + 11);
    ctx.strokeStyle = opt.tooltipBorder;
    ctx.beginPath();
    ctx.moveTo(bx + padX, by + padY + headH - 2.5);
    ctx.lineTo(bx + boxW - padX, by + padY + headH - 2.5);
    ctx.stroke();

    // Rows
    let y = by + padY + headH + 12;
    for (const [label, value, col] of rows) {
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = opt.tooltipMuted;
      ctx.fillText(label, bx + padX, y);
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = col || opt.tooltipText;
      ctx.fillText(value, bx + boxW - padX, y);
      y += rowH;
    }
  }
}

window.FinancialChart = FinancialChart;