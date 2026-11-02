/**
 * C&C Financials - Interactive Financial Chart Engine
 * High-performance Canvas Candlestick, Volume, Moving Averages, and Zone Overlay
 */

class FinancialChart {
  constructor(canvasContainerId, options = {}) {
    this.container = document.getElementById(canvasContainerId);
    if (!this.container) throw new Error(`Container #${canvasContainerId} not found`);

    this.options = {
      theme: 'dark',
      bullishColor: '#089981',
      bearishColor: '#f23645',
      volumeBullish: 'rgba(8, 153, 129, 0.25)',
      volumeBearish: 'rgba(242, 54, 69, 0.25)',
      demandColor: 'rgba(16, 185, 129, 0.18)',
      demandBorder: '#10b981',
      supplyColor: 'rgba(239, 68, 68, 0.18)',
      supplyBorder: '#ef4444',
      gridColor: '#1e2430',
      textColor: '#94a3b8',
      crosshairColor: 'rgba(148, 163, 184, 0.6)',
      ...options
    };

    this.candles = [];
    this.zones = [];
    this.indicators = {
      ema20: false,
      ema50: false,
      ema100: false,
      ema200: false
    };

    // Canvas setup
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.container.innerHTML = '';
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    // Chart Dimensions & Margins
    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 500;
    this.rightMargin = 75; // Price scale
    this.bottomMargin = 30; // Time scale
    this.topMargin = 20;

    // Viewport state
    this.candleWidth = 8;
    this.candleSpacing = 4;
    this.offsetIndex = 0; // index of first visible candle from right
    this.visibleCount = 60;
    this.isDragging = false;
    this.dragStartX = 0;
    this.hoverPoint = null;
    this.selectedZone = null;
    this.onZoneSelect = options.onZoneSelect || null;
    // Price & Time Scale Stretch State
    this.autoPriceScale = true;
    this.priceScaleMultiplier = 1.0;
    this.priceCenterOffset = 0;
    this.baseMinPrice = 0;
    this.baseMaxPrice = 100;
    this.isDraggingPriceScale = false;
    this.isDraggingTimeScale = false;
    this.initialScaleMultiplier = 1.0;
    this.initialVisibleCount = 60;
    this.initialCenterOffset = 0;

    // Enhanced Candle Watching Features
    this.showCmpLaser = true;
    this.showHighLowMarkers = true;
    this.showGrid = true;
    this.showCandleSpotlight = true;

    this.initEvents();
    this.resize();
  }

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

  setTheme(themeName) {
    this.options.theme = themeName;
    if (themeName === 'light') {
      this.options.gridColor = 'rgba(226, 232, 240, 0.85)';
      this.options.textColor = '#475569';
      this.options.crosshairColor = 'rgba(71, 85, 105, 0.45)';
      this.options.demandColor = 'rgba(5, 150, 105, 0.16)';
      this.options.demandBorder = '#059669';
      this.options.supplyColor = 'rgba(225, 29, 72, 0.16)';
      this.options.supplyBorder = '#e11d48';
      this.options.bullishColor = '#059669';
      this.options.bearishColor = '#dc2626';
    } else {
      this.options.gridColor = '#1e2430';
      this.options.textColor = '#94a3b8';
      this.options.crosshairColor = 'rgba(148, 163, 184, 0.6)';
      this.options.demandColor = 'rgba(16, 185, 129, 0.18)';
      this.options.demandBorder = '#10b981';
      this.options.supplyColor = 'rgba(244, 63, 94, 0.18)';
      this.options.supplyBorder = '#f43f5e';
      this.options.bullishColor = '#089981';
      this.options.bearishColor = '#f23645';
    }
    this.requestRender();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;

    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    this.ctx.resetTransform();
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

  updateLegendWithCandle(candle) {
    const infoEl = document.getElementById('chart-legend-ohlc');
    if (!infoEl || !candle) return;
    const change = candle.close - candle.open;
    const pct = candle.open > 0 ? (change / candle.open) * 100 : 0;
    const isUp = change >= 0;
    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    const bodyPct = range > 0 ? Math.round((body / range) * 100) : 0;
    const d = new Date(candle.time * 1000);
    const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

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
    this.visibleCount = Math.min(this.candles.length, Math.floor((this.width - this.rightMargin) / 12));
    this.offsetIndex = 0; // rightmost
    this.resetPriceScale();
    this.requestRender();
  }

  initEvents() {
    window.addEventListener('resize', () => this.resize());

    // Mouse down handles Price Scale Drag, Time Scale Drag, Auto Button, or Chart Drag
    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotWidth = this.width - this.rightMargin;

      // 1. Click on [AUTO] button in bottom-right corner
      if (x >= plotWidth && y >= this.height - this.bottomMargin) {
        this.resetPriceScale();
        return;
      }

      // 2. Click on Price Scale (Y-axis on right side) to stretch/compress price
      if (x >= plotWidth) {
        this.isDraggingPriceScale = true;
        this.dragStartY = e.clientY;
        this.initialScaleMultiplier = this.priceScaleMultiplier;
        return;
      }

      // 3. Click on Time Scale (X-axis on bottom) to stretch/compress timeline
      if (y >= this.height - this.bottomMargin) {
        this.isDraggingTimeScale = true;
        this.dragStartX = e.clientX;
        this.initialVisibleCount = this.visibleCount;
        return;
      }

      // 4. Click on main chart area
      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;
      this.dragStartOffset = this.offsetIndex;
      this.initialCenterOffset = this.priceCenterOffset;
      this.checkZoneClick(e);
    });

    // Hover is tracked strictly on the canvas with dynamic cursors
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotWidth = this.width - this.rightMargin;

      // Dynamic cursor based on hover zone
      if (x >= plotWidth && y >= this.height - this.bottomMargin) {
        this.canvas.style.cursor = 'pointer'; // AUTO button
      } else if (x >= plotWidth) {
        this.canvas.style.cursor = 'ns-resize'; // Stretch price axis!
      } else if (y >= this.height - this.bottomMargin) {
        this.canvas.style.cursor = 'ew-resize'; // Stretch time axis!
      } else {
        this.canvas.style.cursor = 'crosshair';
      }

      this.hoverPoint = { x, y };
      this.requestRender();
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoverPoint = null;
      this.lastHoveredIndex = -1;
      if (this.candles.length) {
        this.updateLegendWithCandle(this.candles[this.candles.length - 1]);
      }
      this.requestRender();
    });

    // Window handles mousemove while dragging
    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingPriceScale) {
        const dy = e.clientY - this.dragStartY;
        this.autoPriceScale = false;
        // Exponential scaling for natural, ultra-smooth stretching feel
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
        const candleStep = this.candleWidth + this.candleSpacing;
        const shiftCandles = Math.round(dx / candleStep);
        this.offsetIndex = Math.max(0, Math.min(this.candles.length - this.visibleCount, this.dragStartOffset + shiftCandles));

        // When price scale is unlinked from auto, allow vertical panning!
        if (!this.autoPriceScale) {
          const chartHeight = this.height - this.bottomMargin - this.topMargin;
          const priceSpan = this.maxPrice - this.minPrice;
          const pricePerPx = priceSpan / (chartHeight || 1);
          this.priceCenterOffset = this.initialCenterOffset + dy * pricePerPx;
        }

        this.requestRender();
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.isDraggingPriceScale = false;
      this.isDraggingTimeScale = false;
    });

    // Double-click resets scale
    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plotWidth = this.width - this.rightMargin;

      if (x >= plotWidth) {
        // Double-click on price scale resets price scale!
        this.resetPriceScale();
      } else if (y >= this.height - this.bottomMargin) {
        // Double-click on time scale fits timeline!
        this.fitContent();
      } else {
        // Double-click on chart resets both!
        this.resetPriceScale();
        this.fitContent();
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const factor = e.deltaY < 0 ? 0.8 : 1.25;
      this.zoomAt(mouseX, factor);
    }, { passive: false });
  }

  zoomAt(mouseX, factor) {
    if (!this.candles.length) return;
    const plotWidth = this.width - this.rightMargin;
    const clampedMouseX = Math.max(0, Math.min(plotWidth, mouseX != null ? mouseX : plotWidth / 2));
    const ratio = clampedMouseX / plotWidth;

    const oldVisible = this.visibleCount;
    // Allow zooming down to 4 candles for extreme close-up inspection!
    const newVisible = Math.max(4, Math.min(this.candles.length, Math.round(oldVisible * factor)));
    if (newVisible === oldVisible) return;

    const total = this.candles.length;
    const oldEndIndex = total - this.offsetIndex;
    const oldStartIndex = Math.max(0, oldEndIndex - oldVisible);
    
    // Anchor candle index under mouse cursor
    const anchorIndex = oldStartIndex + ratio * oldVisible;
    
    // New start index keeping anchor candle at the same visual position
    const newStartIndex = Math.round(anchorIndex - ratio * newVisible);
    const newEndIndex = newStartIndex + newVisible;
    
    this.visibleCount = newVisible;
    this.offsetIndex = Math.max(0, Math.min(total - newVisible, total - newEndIndex));
    this.render();
  }

  zoomIn() {
    this.zoomAt((this.width - this.rightMargin) / 2, 0.75);
  }

  zoomOut() {
    this.zoomAt((this.width - this.rightMargin) / 2, 1.33);
  }


  checkZoneClick(e) {
    if (!this.hoverPoint || !this.zones.length) return;
    const { y } = this.hoverPoint;
    const chartAreaHeight = this.height - this.bottomMargin;
    
    // Find clicked zone
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
      this.render();
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

  render() {
    if (!this.ctx || !this.candles.length) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    // Compute Visible Slice
    const total = this.candles.length;
    const endIndex = Math.max(0, total - this.offsetIndex);
    const startIndex = Math.max(0, endIndex - this.visibleCount);
    const visibleCandles = this.candles.slice(startIndex, endIndex);

    if (!visibleCandles.length) return;

    // Price Bounds
    let minP = Infinity;
    let maxP = -Infinity;
    let maxVol = 0;

    for (const c of visibleCandles) {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
    }

    // Include Visible Zones in scale only if reasonably close to visible price action
    const candleSpan = maxP - minP;
    for (const z of this.zones) {
      if (z.top && z.bottom && z.top >= minP - candleSpan * 0.35 && z.bottom <= maxP + candleSpan * 0.35) {
        if (z.top > maxP) maxP = Math.max(maxP, z.top * 1.01);
        if (z.bottom < minP) minP = Math.min(minP, z.bottom * 0.99);
      }
    }

    const pad = (maxP - minP) * 0.08 || 1;
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
    const candleSlot = plotWidth / visibleCandles.length;
    this.candleWidth = Math.max(2, candleSlot * 0.68);
    this.candleSpacing = candleSlot * 0.32;

    // 1. Draw Grid
    if (this.showGrid) {
      ctx.strokeStyle = this.options.gridColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);

      const priceSteps = 6;
      for (let i = 0; i <= priceSteps; i++) {
        const y = this.topMargin + (plotHeight / priceSteps) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();

        // Price Label on Right Margin
        const p = this.yToPrice(y);
        ctx.fillStyle = this.options.textColor;
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`₹${p.toFixed(2)}`, plotWidth + 8, y + 4);
      }
      ctx.setLineDash([]);
    }

    // 2. Draw Zones with Distance and Decision Score
    this.drawZones(ctx, plotWidth);

    // 3. Draw Indicators
    this.drawIndicators(ctx, startIndex, visibleCandles, candleSlot);

    // 4. Draw Candlesticks & Volume
    visibleCandles.forEach((c, idx) => {
      const x = idx * candleSlot + candleSlot / 2;
      const isBull = c.close >= c.open;
      const color = isBull ? this.options.bullishColor : this.options.bearishColor;
      const borderColor = isBull ? '#067a67' : '#cf222e';
      const volColor = isBull ? this.options.volumeBullish : this.options.volumeBearish;

      // Volume bar
      const volHeight = maxVol > 0 ? (c.volume / maxVol) * (plotHeight * 0.18) : 0;
      const volY = h - this.bottomMargin - volHeight;
      ctx.fillStyle = volColor;
      ctx.fillRect(x - this.candleWidth / 2, volY, this.candleWidth, volHeight);

      // Candlestick Wick (scales nicely with candle width)
      const wickWidth = Math.min(3, Math.max(1.2, this.candleWidth * 0.07));
      ctx.strokeStyle = color;
      ctx.lineWidth = wickWidth;
      ctx.beginPath();
      ctx.moveTo(x, this.priceToY(c.high));
      ctx.lineTo(x, this.priceToY(c.low));
      ctx.stroke();

      // Candlestick Body
      const openY = this.priceToY(c.open);
      const closeY = this.priceToY(c.close);
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(2, Math.abs(closeY - openY));

      // Fill Body
      ctx.fillStyle = color;
      ctx.fillRect(x - this.candleWidth / 2, bodyTop, this.candleWidth, bodyHeight);

      // Stroke crisp border around candle body when zoomed in
      if (this.candleWidth >= 5) {
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - this.candleWidth / 2, bodyTop, this.candleWidth, bodyHeight);
      }

      // If Doji (open === close), draw prominent crossbar
      if (Math.abs(closeY - openY) < 1.5) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, wickWidth);
        ctx.beginPath();
        ctx.moveTo(x - this.candleWidth / 2, openY);
        ctx.lineTo(x + this.candleWidth / 2, openY);
        ctx.stroke();
      }
    });

    // 5. Draw Range High & Low Markers
    if (this.showHighLowMarkers && visibleCandles.length > 3) {
      let hiIdx = 0, loIdx = 0;
      let hiVal = -Infinity, loVal = Infinity;
      visibleCandles.forEach((c, idx) => {
        if (c.high > hiVal) { hiVal = c.high; hiIdx = idx; }
        if (c.low < loVal) { loVal = c.low; loIdx = idx; }
      });
      const hiX = hiIdx * candleSlot + candleSlot / 2;
      const hiY = this.priceToY(hiVal);
      this.drawPeakMarker(ctx, hiX, hiY, hiVal, true);

      const loX = loIdx * candleSlot + candleSlot / 2;
      const loY = this.priceToY(loVal);
      this.drawPeakMarker(ctx, loX, loY, loVal, false);
    }

    // 6. Draw CMP Laser Line with Glowing Live Badge
    if (this.showCmpLaser && this.candles.length > 0) {
      const latestCandle = this.candles[this.candles.length - 1];
      const prevCandle = this.candles.length > 1 ? this.candles[this.candles.length - 2] : latestCandle;
      const cmp = latestCandle.close;
      const cmpY = Math.round(this.priceToY(cmp)) + 0.5;
      const isUp = cmp >= prevCandle.close;
      const laserColor = isUp ? '#089981' : '#f23645';

      if (cmpY >= this.topMargin && cmpY <= h - this.bottomMargin) {
        // Laser horizontal line across plot
        ctx.strokeStyle = laserColor;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, cmpY);
        ctx.lineTo(plotWidth, cmpY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Pulsing live dot
        ctx.fillStyle = laserColor;
        ctx.beginPath();
        ctx.arc(plotWidth - 5, cmpY, 3.5, 0, Math.PI * 2);
        ctx.fill();

        // CMP Badge on Right Price Scale
        const badgeW = this.rightMargin - 6;
        const badgeH = 20;
        const badgeX = plotWidth + 3;
        const badgeY = cmpY - badgeH / 2;

        ctx.fillStyle = laserColor;
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`₹${cmp.toFixed(2)}`, badgeX + badgeW / 2, badgeY + 14);
      }
    }

    // 7. Draw Time Axis Labels
    ctx.fillStyle = this.options.textColor;
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    const timeStep = Math.max(1, Math.floor(visibleCandles.length / 6));
    for (let i = 0; i < visibleCandles.length; i += timeStep) {
      const c = visibleCandles[i];
      const x = i * candleSlot + candleSlot / 2;
      const d = new Date(c.time * 1000);
      const dateStr = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })}`;
      ctx.fillText(dateStr, x, h - 8);
    }

    // 8. Crosshair & Hover Spotlight / Tooltip
    if (this.hoverPoint && this.hoverPoint.x >= 0 && this.hoverPoint.x <= plotWidth) {
      this.drawCrosshair(ctx, plotWidth, h, candleSlot, visibleCandles);
    }

    // 9. Draw [AUTO] Button in bottom-right corner of Price Scale
    const autoBoxX = plotWidth + 6;
    const autoBoxY = h - this.bottomMargin + 5;
    const autoBoxW = this.rightMargin - 12;
    const autoBoxH = this.bottomMargin - 10;

    ctx.fillStyle = this.autoPriceScale ? 'rgba(30, 41, 59, 0.7)' : 'rgba(59, 130, 246, 0.25)';
    ctx.strokeStyle = this.autoPriceScale ? '#334155' : '#3b82f6';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.roundRect(autoBoxX, autoBoxY, autoBoxW, autoBoxH, 4);
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
    const boxW = textWidth + 12;
    const boxH = 18;
    const boxX = Math.max(4, Math.min(this.width - this.rightMargin - boxW - 4, x - boxW / 2));
    const boxY = isHigh ? y - boxH - 6 : y + 6;

    // Small connector line
    ctx.strokeStyle = isHigh ? '#f43f5e' : '#10b981';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, isHigh ? boxY + boxH : boxY);
    ctx.stroke();

    // Box background
    ctx.fillStyle = isHigh ? 'rgba(244, 63, 94, 0.18)' : 'rgba(16, 185, 129, 0.18)';
    ctx.strokeStyle = isHigh ? '#f43f5e' : '#10b981';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 4);
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = isHigh ? '#fca5a5' : '#86efac';
    ctx.textAlign = 'center';
    ctx.fillText(label, boxX + boxW / 2, boxY + 13);
  }

  drawZones(ctx, plotWidth) {
    const cmp = this.candles.length ? this.candles[this.candles.length - 1].close : null;

    for (const z of this.zones) {
      const yTop = this.priceToY(z.top);
      const yBottom = this.priceToY(z.bottom);
      const isDemand = z.type === 'demand';
      const isSelected = this.selectedZone && this.selectedZone.id === z.id;

      const fillColor = isDemand ? this.options.demandColor : this.options.supplyColor;
      const strokeColor = isDemand ? this.options.demandBorder : this.options.supplyBorder;

      ctx.fillStyle = isSelected ? (isDemand ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)') : fillColor;
      ctx.fillRect(0, Math.min(yTop, yBottom), plotWidth, Math.abs(yTop - yBottom));

      // Proximal Boundary (Dotted line)
      const proximalY = this.priceToY(z.proximal);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = isSelected ? 2 : 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, proximalY);
      ctx.lineTo(plotWidth, proximalY);
      ctx.stroke();

      // Distal Boundary (Solid line)
      const distalY = this.priceToY(z.distal);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, distalY);
      ctx.lineTo(plotWidth, distalY);
      ctx.stroke();

      // Calculate distance from CMP
      let distanceTag = '';
      if (cmp != null) {
        if (cmp >= z.bottom && cmp <= z.top) {
          distanceTag = ' · ★ IN ZONE ★';
        } else {
          const diffPct = ((cmp - z.proximal) / cmp) * 100;
          distanceTag = ` · ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%`;
        }
      }

      // Zone Badge Tag with Pattern, Score, Decision Score & Distance
      const midY = (yTop + yBottom) / 2;
      const scoreStr = z.score ? ` · ${z.score.toFixed(1)}` : '';
      const decScoreStr = z.decisionScore ? ` (Dec ${z.decisionScore.toFixed(1)})` : '';
      const tagText = `${isDemand ? 'DZ' : 'SZ'} ${z.pattern || 'RBR'}${scoreStr}${decScoreStr}${distanceTag}`;
      
      ctx.font = 'bold 10px Inter, sans-serif';
      const tw = ctx.measureText(tagText).width + 14;
      
      // Tag background
      ctx.fillStyle = isDemand ? '#064e3b' : '#7f1d1d';
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(plotWidth - tw - 8, midY - 10, tw, 20, 4);
      ctx.fill();
      ctx.stroke();

      // Tag text
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(tagText, plotWidth - tw / 2 - 8, midY + 4);
    }
  }

  drawIndicators(ctx, startIndex, visibleCandles, candleSlot) {
    const drawLine = (data, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < visibleCandles.length; i++) {
        const val = data[startIndex + i];
        if (val == null) continue;
        const x = i * candleSlot + candleSlot / 2;
        const y = this.priceToY(val);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    };

    if (this.indicators.ema20 && this.emaData.ema20) drawLine(this.emaData.ema20, '#3b82f6');
    if (this.indicators.ema50 && this.emaData.ema50) drawLine(this.emaData.ema50, '#f97316');
    if (this.indicators.ema100 && this.emaData.ema100) drawLine(this.emaData.ema100, '#a855f7');
    if (this.indicators.ema200 && this.emaData.ema200) drawLine(this.emaData.ema200, '#eab308');
  }

  drawCrosshair(ctx, plotWidth, h, candleSlot, visibleCandles) {
    if (!this.hoverPoint) return;
    const rawX = this.hoverPoint.x;
    const rawY = this.hoverPoint.y;

    const hoveredIdx = Math.min(visibleCandles.length - 1, Math.max(0, Math.floor(rawX / candleSlot)));
    const candle = visibleCandles[hoveredIdx];

    // 1. Hover Candle Focus Column / Spotlight
    if (this.showCandleSpotlight && hoveredIdx >= 0) {
      const colLeft = hoveredIdx * candleSlot;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.fillRect(colLeft, this.topMargin, candleSlot, h - this.bottomMargin - this.topMargin);
    }

    // 2. Pixel-snap crosshairs to prevent antialiasing blur and visual vibration
    const snapX = Math.round(rawX) + 0.5;
    const snapY = Math.round(rawY) + 0.5;

    ctx.strokeStyle = this.options.crosshairColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(0, snapY);
    ctx.lineTo(plotWidth, snapY);
    ctx.stroke();

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(snapX, 0);
    ctx.lineTo(snapX, h - this.bottomMargin);
    ctx.stroke();
    ctx.setLineDash([]);

    // 3. Hovered Candle Data
    if (candle) {
      const price = this.yToPrice(rawY);

      // High-contrast Price Pill on Right Axis
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(plotWidth + 2, Math.round(rawY - 10), this.rightMargin - 4, 20);
      ctx.strokeStyle = '#38bdf8';
      ctx.strokeRect(plotWidth + 2, Math.round(rawY - 10), this.rightMargin - 4, 20);
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`₹${price.toFixed(2)}`, plotWidth + 6, Math.round(rawY + 4));

      // High-contrast Date Pill on Bottom Time Axis
      const d = new Date(candle.time * 1000);
      const dateStr = `${d.getDate()} ${d.toLocaleString('en-US', { month: 'short' })} '${String(d.getFullYear()).slice(-2)}`;
      ctx.font = 'bold 11px Inter, sans-serif';
      const timeBadgeW = ctx.measureText(dateStr).width + 16;
      const timeBadgeX = Math.max(4, Math.min(plotWidth - timeBadgeW - 4, snapX - timeBadgeW / 2));
      const timeBadgeY = h - this.bottomMargin + 3;

      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(timeBadgeX, timeBadgeY, timeBadgeW, 20, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.fillText(dateStr, timeBadgeX + timeBadgeW / 2, timeBadgeY + 14);

      // Update Top Status Bar ONLY when candle index actually changes
      if (this.lastHoveredIndex !== hoveredIdx) {
        this.lastHoveredIndex = hoveredIdx;
        this.updateLegendWithCandle(candle);
      }
    }
  }
}

window.FinancialChart = FinancialChart;
