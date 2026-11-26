/**
 * C&C Financials - Main SPA Controller
 */

(function() {
  // App State
  const state = {
    currentView: 'chart',
    symbol: 'COCHINSHIP',
    timeframe: '1d',
    detectorVersion: 'v3',
    zoneSide: 'all',
    freshOnly: true,
    minDecisionScore: 80,
    instruments: [],
    chart: null,
    candles: [],
    zones: [],
    selectedZone: null
  };

  // DOM Elements
  const elements = {
    views: document.querySelectorAll('.view-container'),
    navLinks: document.querySelectorAll('.nav-link'),
    chartContainer: document.getElementById('chart-container'),
    symbolInput: document.getElementById('symbol-input'),
    symbolDropdown: document.getElementById('symbol-dropdown'),
    tfButtons: document.querySelectorAll('.tf-btn'),
    chartSymbolBadge: document.getElementById('chart-symbol-badge'),
    zoneDrawer: document.getElementById('zone-drawer'),
    drawerClose: document.getElementById('drawer-close'),
    optionsModal: document.getElementById('options-modal'),
    optionsBtn: document.getElementById('btn-chart-options'),
    optionsClose: document.getElementById('options-close'),
    optionsApply: document.getElementById('options-apply'),
    zoneWatchModal: document.getElementById('zone-watch-modal'),
    zonesTableBody: document.getElementById('zones-table-body'),
    confluenceTableBody: document.getElementById('confluence-table-body'),
    watchTableBody: document.getElementById('watch-table-body'),
    dashboardReactingGrid: document.getElementById('dash-col-reacting'),
    dashboardExecutionGrid: document.getElementById('dash-col-execution'),
    dashboardIndicesGrid: document.getElementById('dash-col-indices'),
    btnBacktestRun: document.getElementById('btn-run-backtest')
  };

  // Initialize
  async function init() {
    initTheme();
    setupRouter();
    setupEventListeners();
    setupUpstoxModal();
    await loadUpstoxStatus();
    await loadInstruments();
    parseUrlParams();

    // Check for Upstox OAuth redirect code in URL
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get('code');
    if (authCode) {
      await handleOAuthCallback(authCode);
    }

    await switchView(state.currentView, false);
    startLiveSync();
  }

  let chartRequest = 0;
  let liveSyncBusy = false;

  function startLiveSync() {
    window.setInterval(() => { refreshLiveView(); }, 10000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshLiveView();
    });
  }

  async function refreshLiveView() {
    if (liveSyncBusy || document.hidden) return;
    liveSyncBusy = true;
    try {
      if (state.currentView === 'chart') await loadChartData({ live: true });
      else if (state.currentView === 'zones') await loadZonesReport({ live: true });
      else if (state.currentView === 'confluence') await loadConfluenceReport({ live: true });
      else if (state.currentView === 'zone-watch') await loadZoneWatch();
      else if (state.currentView === 'dashboard') await loadDashboard();
      else if (state.currentView === 'operations') await loadOperations();
    } finally {
      liveSyncBusy = false;
    }
  }

  // Handle OAuth code returned from Upstox authorization redirect
  async function handleOAuthCallback(code) {
    const modal = document.getElementById('upstox-modal');
    const banner = document.getElementById('upstox-feedback-banner');
    if (modal) modal.classList.add('open');
    if (banner) {
      banner.style.display = 'block';
      banner.style.background = 'rgba(99, 102, 241, 0.15)';
      banner.style.color = '#818cf8';
      banner.textContent = 'Detected Upstox authorization code. Exchanging for live access token...';
    }
    try {
      const res = await fetch('/api/settings/upstox/exchange-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (banner) {
          banner.style.background = 'rgba(16, 185, 129, 0.15)';
          banner.style.color = '#34d399';
          banner.textContent = data.message || 'Connected to Upstox successfully!';
        }
        updateUpstoxStatusUI(data.status);
        // Clean ?code from URL
        const cleanUrl = `${window.location.pathname}?view=${state.currentView}&symbol=${state.symbol}&timeframe=${state.timeframe}`;
        window.history.replaceState({}, '', cleanUrl);
        setTimeout(() => {
          if (modal) modal.classList.remove('open');
        }, 1200);
      } else {
        if (banner) {
          banner.style.background = 'rgba(239, 68, 68, 0.15)';
          banner.style.color = '#f87171';
          banner.textContent = data.error || 'Failed to exchange authorization code. Please ensure UPSTOX_API_KEY and UPSTOX_API_SECRET are set.';
        }
      }
    } catch (e) {
      if (banner) {
        banner.style.display = 'block';
        banner.style.background = 'rgba(239, 68, 68, 0.15)';
        banner.style.color = '#f87171';
        banner.textContent = `Exchange error: ${e.message}`;
      }
    }
  }

  // Theme Management (Dark & Light Mode)
  function initTheme() {
    const savedTheme = localStorage.getItem('app-theme') || 'dark';
    applyTheme(savedTheme);

    const btnToggle = document.getElementById('btn-theme-toggle');
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(newTheme);
      });
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('app-theme', theme);

    const iconSun = document.getElementById('icon-sun');
    const iconMoon = document.getElementById('icon-moon');
    const themeText = document.getElementById('theme-text');

    if (theme === 'light') {
      if (iconSun) iconSun.style.display = 'none';
      if (iconMoon) iconMoon.style.display = 'block';
      if (themeText) themeText.textContent = 'Light';
    } else {
      if (iconSun) iconSun.style.display = 'block';
      if (iconMoon) iconMoon.style.display = 'none';
      if (themeText) themeText.textContent = 'Dark';
    }

    if (state.chart && typeof state.chart.setTheme === 'function') {
      state.chart.setTheme(theme);
    }
  }


  // Setup Routing
  function setupRouter() {
    window.addEventListener('popstate', () => {
      parseUrlParams();
      switchView(state.currentView, false);
    });
  }

  function parseUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view') || 'chart';
    const symbol = params.get('symbol') || state.symbol;
    const timeframe = params.get('timeframe') || state.timeframe;

    state.currentView = view;
    state.symbol = symbol.toUpperCase();
    state.timeframe = timeframe;
  }

  function updateUrl() {
    const params = new URLSearchParams();
    params.set('view', state.currentView);
    if (state.currentView === 'chart') {
      params.set('symbol', state.symbol);
      params.set('timeframe', state.timeframe);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.pushState({}, '', newUrl);
  }

  // Switch View
  async function switchView(viewName, shouldUpdateUrl = true) {
    state.currentView = viewName;
    if (shouldUpdateUrl) updateUrl();

    // Update Nav Link Active states
    elements.navLinks.forEach(link => {
      if (link.dataset.view === viewName) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });

    // Update Views Visibility
    elements.views.forEach(v => {
      if (v.id === `view-${viewName}`) {
        v.classList.add('active');
      } else {
        v.classList.remove('active');
      }
    });

    // View-specific loader
    if (viewName === 'chart') {
      await loadChartData();
    } else if (viewName === 'zones') {
      await loadZonesReport();
    } else if (viewName === 'confluence') {
      await loadConfluenceReport();
    } else if (viewName === 'zone-watch') {
      await loadZoneWatch();
    } else if (viewName === 'dashboard') {
      await loadDashboard();
    } else if (viewName === 'backtesting') {
      await loadBacktesting();
    } else if (viewName === 'operations') {
      await loadOperations();
    }
  }

  // Event Listeners
  function setupEventListeners() {
    // Nav Click
    elements.navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const view = link.dataset.view;
        switchView(view);
      });
    });

    // Brand click -> home/chart
    const brand = document.querySelector('.brand-wrapper');
    if (brand) {
      brand.addEventListener('click', () => switchView('chart'));
    }

    // Timeframe Buttons
    elements.tfButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        elements.tfButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.timeframe = btn.dataset.tf;
        if (state.chart) state.chart.setTimeframe(state.timeframe);
        updateUrl();
        loadChartData();
      });
    });

    // Symbol Search
    elements.symbolInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toUpperCase();
      renderSymbolDropdown(q);
    });

    elements.symbolInput.addEventListener('focus', () => {
      renderSymbolDropdown(elements.symbolInput.value.trim().toUpperCase());
    });

    document.addEventListener('click', (e) => {
      if (!elements.symbolInput.contains(e.target) && !elements.symbolDropdown.contains(e.target)) {
        elements.symbolDropdown.classList.remove('open');
      }
    });

    // Drawer Close
    if (elements.drawerClose) {
      elements.drawerClose.addEventListener('click', () => {
        elements.zoneDrawer.classList.remove('open');
      });
    }

    // Options Modal
    if (elements.optionsBtn) {
      elements.optionsBtn.addEventListener('click', () => {
        elements.optionsModal.classList.add('open');
      });
    }
    if (elements.optionsClose) {
      elements.optionsClose.addEventListener('click', () => {
        elements.optionsModal.classList.remove('open');
      });
    }
    if (elements.optionsApply) {
      elements.optionsApply.addEventListener('click', () => {
        applyChartOptions();
        elements.optionsModal.classList.remove('open');
      });
    }

    // Indicator Toggles
    ['ema20', 'ema50', 'ema100', 'ema200'].forEach(ind => {
      const chk = document.getElementById(`opt-${ind}`);
      if (chk) {
        chk.addEventListener('change', () => {
          if (state.chart) state.chart.setIndicator(ind, chk.checked);
        });
      }
    });

    // Zoom Controls
    const btnZoomIn = document.getElementById('btn-chart-zoomin');
    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', () => {
        if (state.chart) state.chart.zoomIn();
      });
    }

    const btnZoomOut = document.getElementById('btn-chart-zoomout');
    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', () => {
        if (state.chart) state.chart.zoomOut();
      });
    }

    // Reset Chart / Fit
    const btnFit = document.getElementById('btn-chart-fit');
    if (btnFit) {
      btnFit.addEventListener('click', () => {
        if (state.chart) state.chart.fitContent();
      });
    }

    // Add to Watch button from drawer
    const btnAddWatch = document.getElementById('drawer-btn-watch');
    if (btnAddWatch) {
      btnAddWatch.addEventListener('click', async () => {
        if (!state.selectedZone) return;
        await addZoneToWatch(state.selectedZone);
        alert(`Zone for ${state.symbol} added to Zone Watch!`);
      });
    }

    // Add to Dashboard button from drawer
    const btnAddDash = document.getElementById('drawer-btn-dash');
    if (btnAddDash) {
      btnAddDash.addEventListener('click', async () => {
        if (!state.selectedZone) return;
        await addZoneToDashboard(state.selectedZone);
        alert(`Zone for ${state.symbol} added to Setup Dashboard!`);
      });
    }

    // Quick Decision Score Filter on Chart Toolbar
    const selQuickDec = document.getElementById('chart-quick-decision-score');
    if (selQuickDec) {
      selQuickDec.value = String(state.minDecisionScore || 80);
      selQuickDec.addEventListener('change', () => {
        state.minDecisionScore = parseFloat(selQuickDec.value) || 0;
        const optMinDec = document.getElementById('opt-min-decision-score');
        if (optMinDec) optMinDec.value = selQuickDec.value;
        updateChartZones();
      });
    }

    // Candle Watching Ease Controls
    const btnToggleCmp = document.getElementById('btn-toggle-cmp');
    if (btnToggleCmp) {
      btnToggleCmp.addEventListener('click', () => {
        if (!state.chart) return;
        const active = state.chart.toggleCmpLaser();
        btnToggleCmp.classList.toggle('active', active);
      });
    }

    const btnToggleHl = document.getElementById('btn-toggle-hl');
    if (btnToggleHl) {
      btnToggleHl.addEventListener('click', () => {
        if (!state.chart) return;
        const active = state.chart.toggleHighLowMarkers();
        btnToggleHl.classList.toggle('active', active);
      });
    }

    const btnToggleGrid = document.getElementById('btn-toggle-grid');
    if (btnToggleGrid) {
      btnToggleGrid.addEventListener('click', () => {
        if (!state.chart) return;
        const active = state.chart.toggleGrid();
        btnToggleGrid.classList.toggle('active', active);
      });
    }

    // Zone Distance Report Filters (Instant reactivity)
    [
      'zones-filter-detector', 'zones-filter-timeframe', 'zones-filter-side', 
      'zones-filter-maxdist', 'zones-filter-context', 'zones-filter-purpose', 
      'zones-filter-minscore', 'zones-filter-mindecisionscore', 'zones-filter-universe', 
      'zones-filter-fresh'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          if (id === 'zones-filter-context') {
            const purposeWrap = document.getElementById('zones-purpose-wrap');
            if (purposeWrap) {
              purposeWrap.style.display = el.value === 'off' ? 'none' : 'flex';
            }
          }
          loadZonesReport();
        });
      }
    });

    // Zone Report Search Input
    const zonesSearch = document.getElementById('zones-search-input');
    if (zonesSearch) {
      let debounce = null;
      zonesSearch.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => loadZonesReport(), 250);
      });
    }

    // Zone Report Build Button
    const btnZonesBuild = document.getElementById('zones-btn-build');
    if (btnZonesBuild) {
      btnZonesBuild.addEventListener('click', async () => {
        await loadZonesReport({ isBuild: true });
      });
    }

    // Zone Report CSV Export Button
    const btnZonesCsv = document.getElementById('zones-btn-csv');
    if (btnZonesCsv) {
      btnZonesCsv.addEventListener('click', exportZonesCSV);
    }

    // Zone Distance Table Column Sorting
    document.querySelectorAll('.zones-table th.sortable-th').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (!field) return;
        if (zonesSort.field === field) {
          zonesSort.dir = zonesSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          zonesSort.field = field;
          zonesSort.dir = 'desc';
        }
        document.querySelectorAll('.zones-table th.sortable-th').forEach(header => {
          const f = header.dataset.sort;
          const cleanLabel = header.textContent.replace(/[↑↓⬍]/g, '').replace(/[0-9]/g, '').trim();
          if (f === zonesSort.field) {
            header.innerHTML = `${cleanLabel} ${zonesSort.dir === 'asc' ? '↑' : '↓'} <span class="sort-priority">1</span>`;
          } else {
            header.innerHTML = `${cleanLabel} ⬍`;
          }
        });
        renderZonesTable();
      });
    });

    // Zone Confluence Report Filters & Actions (Instant reactivity)
    [
      'conf-filter-detector', 'conf-filter-universe', 'conf-filter-purpose', 
      'conf-filter-zonetype', 'conf-filter-context', 'conf-filter-coincidence', 
      'conf-filter-mindecisionscore', 'conf-filter-minoverlap', 'conf-filter-maxdist', 
      'conf-filter-minltf', 'conf-filter-minhtf', 'conf-filter-fresh'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => loadConfluenceReport());
      }
    });

    // Confluence Search
    const confSearch = document.getElementById('conf-search-input');
    if (confSearch) {
      let debounce = null;
      confSearch.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => loadConfluenceReport(), 250);
      });
    }

    // Confluence Build Report Button
    const btnConfBuild = document.getElementById('conf-btn-build');
    if (btnConfBuild) {
      btnConfBuild.addEventListener('click', async () => {
        await loadConfluenceReport({ isBuild: true });
      });
    }

    // Confluence CSV Export
    const btnConfCsv = document.getElementById('conf-btn-csv');
    if (btnConfCsv) {
      btnConfCsv.addEventListener('click', exportConfluenceCSV);
    }

    // Confluence Table Column Sorting
    document.querySelectorAll('.confluence-table th.sortable-th').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (!field) return;
        if (confluenceSort.field === field) {
          confluenceSort.dir = confluenceSort.dir === 'asc' ? 'desc' : 'asc';
        } else {
          confluenceSort.field = field;
          confluenceSort.dir = 'desc';
        }
        document.querySelectorAll('.confluence-table th.sortable-th').forEach(header => {
          const f = header.dataset.sort;
          const cleanLabel = header.textContent.replace(/[↑↓⬍]/g, '').replace(/[0-9]/g, '').trim();
          if (f === confluenceSort.field) {
            header.innerHTML = `${cleanLabel} ${confluenceSort.dir === 'asc' ? '↑' : '↓'} <span class="sort-priority">1</span>`;
          } else {
            header.innerHTML = `${cleanLabel} ⬍`;
          }
        });
        renderConfluenceTable();
      });
    });

    // Backtest Run Button
    if (elements.btnBacktestRun) {
      elements.btnBacktestRun.addEventListener('click', runBacktestSimulation);
    }
  }

  // Load Instruments
  async function loadInstruments() {
    try {
      const res = await fetch('/api/instruments');
      const data = await res.json();
      state.instruments = data.instruments || [];
    } catch (e) {
      console.error('Failed to load instruments:', e);
    }
  }

  function renderSymbolDropdown(q) {
    if (!state.instruments.length) return;
    const matches = state.instruments.filter(i => 
      !q || (i.symbol && i.symbol.toUpperCase().includes(q)) || (i.name && i.name.toUpperCase().includes(q))
    ).slice(0, 15);

    elements.symbolDropdown.innerHTML = '';
    matches.forEach(item => {
      const div = document.createElement('div');
      div.className = 'symbol-item';
      div.innerHTML = `
        <span class="symbol-item-sym">${item.symbol}</span>
        <span class="symbol-item-name">${item.name || ''}</span>
      `;
      div.addEventListener('click', () => {
        state.symbol = item.symbol;
        elements.symbolInput.value = item.symbol;
        elements.symbolDropdown.classList.remove('open');
        updateUrl();
        loadChartData();
      });
      elements.symbolDropdown.appendChild(div);
    });

    elements.symbolDropdown.classList.add('open');
  }

  // Load Chart Data
  async function loadChartData(options = {}) {
    const requestId = ++chartRequest;
    const requestedSymbol = state.symbol;
    const requestedTf = state.timeframe;
    elements.symbolInput.value = state.symbol;

    // 1. Fetch Candles
    let isLiveUpstox = false;
    let candleSource = '';
    let candleError = '';
    let candleCount = 0;
    let syncedAt = null;
    let providerStatus = null;
    try {
      const candleRes = await fetch(`/api/candles?symbol=${requestedSymbol}&timeframe=${requestedTf}&max=true&basis=raw`, { cache: 'no-store' });
      const candleData = await candleRes.json();
      if (requestId !== chartRequest || requestedSymbol !== state.symbol || requestedTf !== state.timeframe) return;
      state.candles = candleData.candles || [];
      candleCount = state.candles.length;
      candleSource = candleData.source || '';
      candleError = candleData.error || '';
      isLiveUpstox = candleSource === 'upstox_live';
      syncedAt = candleData.syncedAt || null;
      providerStatus = candleData.status || candleData.providerStatus || null;
    } catch (e) {
      console.error('Failed fetching candles:', e);
      if (options.live && state.candles.length) return;
      state.candles = [];
    }

    const syncClock = syncedAt
      ? new Date(syncedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
    let liveBadge = '';
    if (isLiveUpstox) {
      liveBadge = `<span class="badge" title="Live sync from Upstox. Price and zones refresh every 10 seconds." style="background:rgba(16,185,129,0.18);color:#10b981;border:1px solid rgba(16,185,129,0.4);font-weight:700;display:inline-flex;align-items:center;gap:5px"><span class="laser-dot" style="width:6px;height:6px;border-radius:50%;background:#10b981;display:inline-block;box-shadow:0 0 6px #10b981"></span> LIVE UPSTOX ${syncClock}</span>`;
    } else if (providerStatus && providerStatus.isExpired) {
      liveBadge = `<span class="badge" title="Upstox token expired. Click to update Analytics Token." style="background:rgba(239,68,68,0.18);color:#f87171;border:1px solid rgba(239,68,68,0.4);font-weight:700;display:inline-flex;align-items:center;gap:5px;cursor:pointer" onclick="document.getElementById('upstox-modal').classList.add('open')"><span style="width:6px;height:6px;border-radius:50%;background:#ef4444;display:inline-block"></span> TOKEN EXPIRED (CLICK TO RENEW)</span>`;
    } else if (candleSource === 'yahoo_nse') {
      liveBadge = `<span class="badge" title="Daily NSE history for this symbol" style="background:rgba(96,165,250,0.16);color:#60a5fa;border:1px solid rgba(96,165,250,0.35);font-weight:700">NSE HISTORY</span>`;
    } else {
      liveBadge = `<span class="badge" title="${candleError || 'No history for this symbol'}" style="background:rgba(255,255,255,0.06);color:var(--text-muted)">${candleError ? 'NO DATA' : 'SNAPSHOT'}</span>`;
    }

    elements.chartSymbolBadge.innerHTML = `
      <span>${state.symbol}</span>
      <span class="brand-tag">${state.timeframe.toUpperCase()}</span>
      ${liveBadge}
      <span style="font-size:12px;color:var(--text-muted);font-weight:400">Detector: ${state.detectorVersion.toUpperCase()}</span>
      <span style="font-size:11px;color:var(--text-subtle);font-family:'JetBrains Mono',monospace">${candleCount} bars</span>
    `;

    // 2. Fetch or Calculate Zones
    state.zones = [];
    if (state.detectorVersion === 'v3' && !isLiveUpstox) {
      try {
        const zoneRes = await fetch(`/api/zones/detect?symbol=${state.symbol}&timeframe=${state.timeframe}&version=v3`, { cache: 'no-store' });
        const zoneData = await zoneRes.json();
        state.zones = zoneData.zones || [];
      } catch (e) {
        state.zones = [];
      }
    }

    // If no static V3 zones exist or when streaming live Upstox candles:
    // Detect zones dynamically on the actual live candles using the client-side ZoneEngine!
    if (!state.zones || state.zones.length === 0 || isLiveUpstox) {
      if (window.ZoneEngine && state.candles.length >= 5) {
        state.zones = window.ZoneEngine.detectZonesV2(state.candles, state.timeframe);
      } else {
        state.zones = [];
      }
    }

    if (requestId !== chartRequest || requestedSymbol !== state.symbol || requestedTf !== state.timeframe) return;

    // 3. Filter and Apply Zones
    const visibleZones = updateChartZones();

    // 4. Initialize or update FinancialChart
    if (!state.chart) {
      const activeTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      state.chart = new window.FinancialChart('chart-container', {
        theme: activeTheme,
        timeframe: requestedTf,
        onZoneSelect: (zone) => openZoneDrawer(zone)
      });
      state.chart.setTheme(activeTheme);
    } else {
      state.chart.setTimeframe(requestedTf);
    }

    if (options.live) state.chart.applyLiveUpdate(state.candles, visibleZones);
    else state.chart.setData(state.candles, visibleZones);

    if (state.selectedZone && elements.zoneDrawer.classList.contains('open')) {
      const prev = state.selectedZone;
      const match = state.zones.find(z => z.id === prev.id || (z.type === prev.type && z.startTime === prev.startTime && z.proximal === prev.proximal));
      if (match) openZoneDrawer(match);
    }
  }

  function updateChartZones() {
    let visibleZones = [...state.zones];
    const cmp = state.candles.length ? state.candles[state.candles.length - 1].close : null;

    if (state.zoneSide !== 'all') {
      visibleZones = visibleZones.filter(z => z.type === state.zoneSide);
    }
    if (state.freshOnly) {
      const freshOnlyList = visibleZones.filter(z => z.freshnessState === 'fresh');
      const stillActive = visibleZones.filter(z => z.freshnessState !== 'broken_by_close' && z.quality !== 'broken');
      visibleZones = freshOnlyList.length ? freshOnlyList : stillActive;
    }
    if (state.minDecisionScore && state.minDecisionScore > 0) {
      visibleZones = visibleZones.filter(z => {
        const ds = z.decisionScore != null ? z.decisionScore : z.score;
        return ds != null && ds >= state.minDecisionScore;
      });
    }

    // Sort by proximity to current market price so nearest actionable zones are shown
    if (cmp != null && visibleZones.length > 12) {
      const nearZones = visibleZones.filter(z => Math.abs((cmp - (z.proximal || z.top)) / cmp) <= 0.30);
      if (nearZones.length >= 4) {
        visibleZones = nearZones.sort((a, b) => Math.abs(cmp - (a.proximal || a.top)) - Math.abs(cmp - (b.proximal || b.top))).slice(0, 15);
      } else {
        visibleZones = visibleZones.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 15);
      }
    }

    if (state.chart) {
      state.chart.setZones(visibleZones);
    }

    // Update active zones badge in chart header
    const zonesCountEl = document.getElementById('chart-zones-count');
    if (zonesCountEl) {
      const filterLabel = state.minDecisionScore > 0 ? ` (Score ≥ ${state.minDecisionScore})` : '';
      zonesCountEl.textContent = `Zones: ${visibleZones.length} / ${state.zones.length}${filterLabel}`;
      zonesCountEl.className = visibleZones.length > 0 ? 'badge badge-perfect' : 'badge badge-good';
    }

    return visibleZones;
  }

  function applyChartOptions() {
    const selDetector = document.querySelector('input[name="opt-detector"]:checked')?.value || 'v3';
    const selSide = document.querySelector('input[name="opt-side"]:checked')?.value || 'all';
    const chkFresh = document.getElementById('opt-fresh-only')?.checked;
    const selMinScore = document.getElementById('opt-min-score')?.value;
    const selMinDecScore = document.getElementById('opt-min-decision-score')?.value;

    state.detectorVersion = selDetector;
    state.zoneSide = selSide;
    state.freshOnly = !!chkFresh;
    state.minDecisionScore = selMinDecScore ? parseFloat(selMinDecScore) : (selMinScore ? parseFloat(selMinScore) : null);

    const selQuickDec = document.getElementById('chart-quick-decision-score');
    if (selQuickDec && state.minDecisionScore != null) {
      selQuickDec.value = String(state.minDecisionScore);
    }

    loadChartData();
  }

  // Open Zone Details Drawer
  function openZoneDrawer(zone) {
    state.selectedZone = zone;
    elements.zoneDrawer.classList.add('open');

    const isDemand = zone.type === 'demand';
    const badgeClass = isDemand ? 'badge-demand' : 'badge-supply';
    const qualityClass = `badge-${zone.quality || 'good'}`;
    const score = zone.score?.toFixed(1) || '0.0';
    const decScore = (zone.decisionScore || zone.score)?.toFixed(1) || score;

    const lastCandle = state.candles[state.candles.length - 1];
    const cmp = lastCandle ? lastCandle.close : zone.proximal;
    const geom = window.ZoneEngine ? window.ZoneEngine.calculateTradeGeometry(zone, cmp) : {
      entry: zone.proximal,
      stop: zone.distal,
      target: isDemand ? zone.proximal * 1.05 : zone.proximal * 0.95,
      distancePercent: Math.abs((cmp - zone.proximal) / cmp) * 100,
      riskReward: 2.5
    };

    document.getElementById('drawer-badge-type').className = `badge ${badgeClass}`;
    document.getElementById('drawer-badge-type').textContent = `${isDemand ? 'Demand' : 'Supply'} (${zone.pattern || 'RBR'})`;
    
    document.getElementById('drawer-badge-quality').className = `badge ${qualityClass}`;
    document.getElementById('drawer-badge-quality').textContent = (zone.quality || 'Good').toUpperCase();

    document.getElementById('drawer-score').textContent = score;
    document.getElementById('drawer-decision-score').textContent = decScore;

    // Breakdown components
    const b = zone.scoreBreakdown || (zone.formationDetails?.qualityEvidence?.scoreComponents) || {};
    document.getElementById('drawer-comp-base').textContent = (b.baseCount || b.compactness || 0).toFixed(1);
    document.getElementById('drawer-comp-departure').textContent = (b.departure || b.departureStrength || 0).toFixed(1);
    document.getElementById('drawer-comp-legout').textContent = (b.legOutRange || b.closeBreakDistance || 0).toFixed(1);
    document.getElementById('drawer-comp-freshness').textContent = (b.freshness || (zone.freshnessState === 'fresh' ? 9 : 0)).toFixed(1);
    document.getElementById('drawer-comp-achievement').textContent = (b.achievement || (b.origin || 0)).toFixed(1);

    // Trade Geometry
    document.getElementById('drawer-entry').textContent = `₹${geom.entry.toFixed(2)}`;
    document.getElementById('drawer-stop').textContent = `₹${geom.stop.toFixed(2)}`;
    document.getElementById('drawer-target').textContent = `₹${geom.target.toFixed(2)}`;
    document.getElementById('drawer-rr').textContent = geom.riskReward ? `1 : ${geom.riskReward}` : '-';
    document.getElementById('drawer-distance').textContent = `${geom.distancePercent.toFixed(2)}%`;
  }

  // Zone Distance Report State & Handlers
  let zonesDataRows = [];
  let zonesSort = { field: 'decisionScore', dir: 'desc' };

  function getSectorClass(sec) {
    if (!sec) return 'default';
    const s = sec.toLowerCase();
    if (s.includes('energy') || s.includes('power') || s.includes('oil') || s.includes('gas')) return 'energy';
    if (s.includes('tech') || s.includes('software')) return 'tech';
    if (s.includes('bank')) return 'banking';
    if (s.includes('auto')) return 'auto';
    if (s.includes('pharma') || s.includes('health') || s.includes('bio')) return 'pharma';
    if (s.includes('metal') || s.includes('steel') || s.includes('mining')) return 'metal';
    if (s.includes('fmcg') || s.includes('consumer') || s.includes('beverage')) return 'fmcg';
    if (s.includes('infra') || s.includes('construct') || s.includes('cement')) return 'infra';
    if (s.includes('fin')) return 'fin';
    if (s.includes('chem')) return 'chem';
    if (s.includes('defence') || s.includes('marine')) return 'defence';
    return 'default';
  }

  // Zone Distance Report
  async function loadZonesReport(options = {}) {
    const universe = document.getElementById('zones-filter-universe')?.value || 'all';
    const timeframe = document.getElementById('zones-filter-timeframe')?.value || '1d';
    const zoneType = document.getElementById('zones-filter-side')?.value || 'all';
    const maxDist = parseFloat(document.getElementById('zones-filter-maxdist')?.value || '100');
    const contextMode = document.getElementById('zones-filter-context')?.value || 'off';
    const purpose = document.getElementById('zones-filter-purpose')?.value || 'MIT';
    const minScore = parseFloat(document.getElementById('zones-filter-minscore')?.value || '0');
    const minDecisionScore = parseFloat(document.getElementById('zones-filter-mindecisionscore')?.value || '0');
    const detectorVersion = document.getElementById('zones-filter-detector')?.value || 'v2';
    const freshOnly = document.getElementById('zones-filter-fresh')?.checked !== false;
    const query = (document.getElementById('zones-search-input')?.value || '').trim();

    // Update KPI Active Timeframe
    const tfLabelMap = {
      '1d': '1D (Daily)',
      '1w': '1W (Weekly)',
      '1M': '1M (Monthly)',
      '75m': '75m (Intraday)',
      '15m': '15m (Intraday)',
      '5m': '5m (Intraday)',
      '60m': '60m (Hourly)',
      '125m': '125m',
      '240m': '4H (4-Hour)',
      '3M': '3M (Quarterly)',
      '6M': '6M (Half-Year)',
      '1Y': '1Y (Annual)'
    };
    const tfKpiEl = document.getElementById('kpi-zones-timeframe');
    if (tfKpiEl) tfKpiEl.textContent = tfLabelMap[timeframe] || timeframe.toUpperCase();

    // Progress Bar Simulation when "Build Report" clicked
    const progressSlot = document.getElementById('zones-progress-slot');
    const progressTitle = document.getElementById('zones-progress-title');
    const progressMeta = document.getElementById('zones-progress-meta');
    const progressBar = document.getElementById('zones-progress-bar');
    const btnBuild = document.getElementById('zones-btn-build');

    const totalScanTarget = universe === 'nifty500' ? 497 : (universe === 'nifty100' ? 100 : (universe === 'nifty50' ? 50 : 3074));
    if (options.isBuild && progressSlot) {
      progressSlot.style.display = 'block';
      if (btnBuild) {
        btnBuild.disabled = true;
        btnBuild.innerHTML = '<span class="status-dot"></span> Building...';
      }
      if (progressBar) progressBar.style.width = '20%';
      if (progressTitle) progressTitle.textContent = `Preparing ${timeframe} scan for ${totalScanTarget} NSE equities...`;
      await new Promise(r => setTimeout(r, 200));

      if (progressBar) progressBar.style.width = '60%';
      if (progressTitle) progressTitle.textContent = `Building: ${Math.round(totalScanTarget * 0.6)} / ${totalScanTarget} symbols (60%)...`;
      await new Promise(r => setTimeout(r, 250));

      if (progressBar) progressBar.style.width = '95%';
      if (progressTitle) progressTitle.textContent = 'Finalizing zone distance & order geometry...';
      await new Promise(r => setTimeout(r, 200));
    }

    try {
      const url = `/api/reports/zones?universe=${universe}&timeframe=${timeframe}&zoneType=${zoneType}&maxDistancePercent=${maxDist}&contextMode=${contextMode}&purpose=${purpose}&minScore=${minScore}&minDecisionScore=${minDecisionScore}&detectorVersion=${detectorVersion}&freshOnly=${freshOnly}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      zonesDataRows = data.rows || [];

      // Update KPIs
      const fallbackScanned = universe === 'nifty500' ? 497 : (universe === 'nifty100' ? 100 : (universe === 'nifty50' ? 50 : 3074));
      const fallbackWithData = universe === 'nifty500' ? 496 : (universe === 'nifty100' ? 100 : (universe === 'nifty50' ? 50 : 2911));
      const scannedFormatted = (data.symbolsChecked || fallbackScanned).toLocaleString();
      document.getElementById('kpi-zones-scanned').textContent = scannedFormatted;
      document.getElementById('kpi-zones-tradeable').textContent = zonesDataRows.length;
      const avgScoreEl = document.getElementById('kpi-zones-avg-score');
      if (avgScoreEl) {
        if (zonesDataRows.length > 0) {
          const sum = zonesDataRows.reduce((acc, r) => acc + (r.decisionScore != null ? r.decisionScore : (r.score || 0)), 0);
          avgScoreEl.textContent = (sum / zonesDataRows.length).toFixed(1);
        } else {
          avgScoreEl.textContent = '-';
        }
      }

      // Update Live Summary Line matching source
      const sumRows = document.getElementById('zones-sum-rows');
      if (sumRows) sumRows.textContent = zonesDataRows.length;
      const sumScanned = document.getElementById('zones-sum-scanned');
      if (sumScanned) sumScanned.textContent = scannedFormatted;
      const sumWithData = document.getElementById('zones-sum-withdata');
      if (sumWithData) sumWithData.textContent = (data.symbolsWithHistory || fallbackWithData).toLocaleString();
      const sumUpdated = document.getElementById('zones-sum-updated');
      if (sumUpdated) {
        const timeStr = data.syncedAt || data.updatedAt ? new Date(data.syncedAt || data.updatedAt).toLocaleTimeString() : 'just now';
        sumUpdated.textContent = (data.priceSource === 'upstox_live' || data.isLive) ? `Live sync ${timeStr}` : `Snapshot ${timeStr}`;
      }

      if (options.isBuild && progressSlot) {
        if (progressBar) progressBar.style.width = '100%';
        if (progressTitle) progressTitle.textContent = `Completed: ${scannedFormatted} / ${scannedFormatted} symbols (100%)`;
        if (progressMeta) progressMeta.textContent = `With data ${(data.symbolsWithHistory || 2911).toLocaleString()} · Rows found ${zonesDataRows.length}`;
        await new Promise(r => setTimeout(r, 350));
        progressSlot.style.display = 'none';
        if (btnBuild) {
          btnBuild.disabled = false;
          btnBuild.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> Build Report';
        }
      }

      renderZonesTable();
    } catch (e) {
      console.error('Failed to load zones report:', e);
      if (progressSlot) progressSlot.style.display = 'none';
      if (btnBuild) {
        btnBuild.disabled = false;
        btnBuild.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> Build Report';
      }
    }
  }

  function renderZonesTable() {
    elements.zonesTableBody.innerHTML = '';
    if (!zonesDataRows.length) {
      elements.zonesTableBody.innerHTML = '<tr><td colspan="15" style="text-align:center;padding:36px;color:var(--text-subtle)">No zones matched current filter criteria. Try loosening filters or click "Build Report".</td></tr>';
      return;
    }

    // Sort rows
    const sorted = [...zonesDataRows].sort((a, b) => {
      let valA = a[zonesSort.field];
      let valB = b[zonesSort.field];
      if (valA == null) valA = 0;
      if (valB == null) valB = 0;
      if (typeof valA === 'string') {
        return zonesSort.dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return zonesSort.dir === 'asc' ? valA - valB : valB - valA;
    });

    sorted.forEach(r => {
      const tr = document.createElement('tr');
      const isDemand = (r.zoneType || r.side) === 'demand' || r.side === 'long';
      const sideBadge = `<span class="zone-badge ${isDemand ? 'demand' : 'supply'}">${isDemand ? 'Demand' : 'Supply'}</span>`;
      const sectorClass = getSectorClass(r.sector);
      const sectorBadge = `<span class="sector-badge sector-${sectorClass}">${r.sector || 'Diversified'}</span>`;
      
      const cmpVal = r.currentPrice != null ? r.currentPrice : (r.cmp || 0);
      const distPercent = r.distancePercent != null ? r.distancePercent.toFixed(2) : '-';
      const distPts = r.distance != null ? r.distance.toFixed(2) : '-';
      const isNear = r.distancePercent != null && r.distancePercent <= 3.0;

      const zoneLow = (r.zoneBottom != null ? r.zoneBottom : (r.distal || 0)).toFixed(2);
      const zoneHigh = (r.zoneTop != null ? r.zoneTop : (r.proximal || 0)).toFixed(2);
      const entryVal = (r.entry != null ? r.entry : r.zoneTop || 0).toFixed(2);
      const stopVal = (r.stop != null ? r.stop : r.zoneBottom || 0).toFixed(2);

      const decScore = r.decisionScore != null ? r.decisionScore : (r.score || 0);
      const adjVal = r.htfAdjustment != null ? r.htfAdjustment : 0;
      const adjStr = adjVal >= 0 ? `+${adjVal.toFixed(2)}` : adjVal.toFixed(2);

      const originDate = r.legOutTime ? new Date(r.legOutTime > 1e11 ? r.legOutTime : r.legOutTime * 1000).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '-';

      // Opposite Zone Nearest
      let oppSummary = '-';
      let oppNearest = '';
      if (r.oppositeZoneNearestDistancePercent != null) {
        oppSummary = `${r.oppositeZoneNearestDistancePercent.toFixed(1)}% away`;
        if (r.oppositeZones && r.oppositeZones[0]) {
          const oz = r.oppositeZones[0];
          oppNearest = `${oz.timeframe || ''} ${oz.zoneType === 'supply' ? 'SZ' : 'DZ'} ₹${(oz.zoneBottom || 0).toFixed(0)}-₹${(oz.zoneTop || 0).toFixed(0)}`;
        }
      } else if (r.oppositeZoneSummary) {
        oppSummary = r.oppositeZoneSummary.split(';')[0] || '-';
      }

      // HTF Reaction
      let reactionBadgeClass = 'badge-good';
      if (r.htfReactionStatus === 'active' || r.htfReactionStatus === 'reacting') reactionBadgeClass = 'badge-weak';
      const reactionSummary = r.htfBlockerSummary || r.htfReactionReason || (r.htfReactionStatus ? `${r.htfReactionTimeframe || 'HTF'} ${r.htfReactionStatus}` : 'Clear');

      // Context Verdict
      let verdictClass = 'badge-good';
      const verdictText = r.htfVerdictLabel || r.htfVerdict || 'Structural';
      if (verdictText.toLowerCase().includes('avoid') || verdictText.toLowerCase().includes('conflict')) verdictClass = 'badge-weak';
      else if (verdictText.toLowerCase().includes('aligned')) verdictClass = 'badge-perfect';

      // Moving Averages
      let ema100Str = '-';
      let ema200Str = '-';
      let ema100Above = true;
      let ema200Above = true;
      if (r.movingAverages) {
        if (r.movingAverages.ema100) {
          ema100Above = r.movingAverages.ema100.position === 'above';
          ema100Str = `${(r.movingAverages.ema100.distancePercent || 0).toFixed(1)}% (${r.movingAverages.ema100.position || 'near'})`;
        }
        if (r.movingAverages.ema200) {
          ema200Above = r.movingAverages.ema200.position === 'above';
          ema200Str = `${(r.movingAverages.ema200.distancePercent || 0).toFixed(1)}% (${r.movingAverages.ema200.position || 'near'})`;
        }
      } else if (r.ema100DistancePercent != null) {
        ema100Str = `${r.ema100DistancePercent.toFixed(1)}% (${r.ema100Position || 'near'})`;
        ema200Str = `${(r.ema200DistancePercent || 0).toFixed(1)}% (${r.ema200Position || 'near'})`;
      }

      tr.innerHTML = `
        <td>
          <strong style="color:var(--text-main);font-size:13px">${r.symbol}</strong>
          <span style="display:block;font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${r.name || ''}</span>
        </td>
        <td>
          ${sectorBadge}
          <span style="display:block;font-size:10px;color:var(--text-subtle);margin-top:2px">${r.industry || ''}</span>
        </td>
        <td>
          ${sideBadge}
          <span style="display:block;font-size:11px;color:var(--text-muted);text-transform:uppercase;margin-top:2px">${r.side || (isDemand ? 'LONG' : 'SHORT')} · ${r.proximity || 'watch'}</span>
        </td>
        <td>
          <strong>₹${cmpVal.toFixed(2)}</strong>
          <span style="display:block;font-size:11px;color:var(--text-muted)">${r.dataQuality || 'ok'}</span>
        </td>
        <td>
          <strong style="color:${isNear ? 'var(--demand-green)' : 'inherit'}">${distPercent}%</strong>
          <span style="display:block;font-size:11px;color:var(--text-muted)">${distPts} pts</span>
        </td>
        <td>
          <button class="btn-zone-link" data-sym="${r.symbol}" data-tf="${r.timeframe || '1d'}" title="Open chart at ₹${zoneLow} - ₹${zoneHigh}">
            ₹${zoneLow} – ₹${zoneHigh}
          </button>
          <span class="zone-cell-sub">entry ${entryVal} / stop ${stopVal}</span>
        </td>
        <td>
          <strong style="color:var(--demand-green)">${(r.quality || 'good').toUpperCase()} ${(r.score || 0).toFixed(0)}</strong>
          <span style="display:block;font-size:11px;color:var(--text-muted)">${r.pattern || 'RBR'} · ${r.baseCount || 1} base</span>
        </td>
        <td>
          <span style="display:inline-block;padding:2px 8px;border-radius:12px;background:rgba(96,165,250,0.15);color:#60a5fa;font-weight:700;font-size:12px">
            ${decScore.toFixed(1)}
          </span>
          <span style="display:block;font-size:10px;color:var(--text-subtle);margin-top:2px">(${r.score ? r.score.toFixed(1) : '-'} ${adjStr})</span>
        </td>
        <td>
          <strong>${r.riskReward != null ? r.riskReward.toFixed(2) + 'R' : '-'}</strong>
          <span style="display:block;font-size:11px;color:var(--text-muted)">target ₹${r.target != null ? r.target.toFixed(2) : '-'}</span>
        </td>
        <td>
          <strong>${originDate}</strong>
          <span style="display:block;font-size:11px;color:var(--text-muted)">${r.freshnessState || 'fresh'} · ${r.touchCount || 0} touch</span>
        </td>
        <td>
          <strong style="font-size:12px">${oppSummary}</strong>
          <span style="display:block;font-size:10px;color:var(--text-subtle);margin-top:2px">${oppNearest}</span>
        </td>
        <td>
          <span class="badge ${reactionBadgeClass}">${r.htfReactionStatus || 'Clear'}</span>
          <span style="display:block;font-size:10px;color:var(--text-subtle);margin-top:2px;max-width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${reactionSummary}">${reactionSummary}</span>
        </td>
        <td>
          <span class="badge ${verdictClass}">${verdictText}</span>
          <span style="display:block;font-size:10px;color:var(--text-subtle);margin-top:2px">${r.htfVerdictReason || 'Trend aligned'}</span>
        </td>
        <td>
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace">
            <div>100 EMA: <span style="color:${ema100Above ? '#10b981' : '#ef4444'}">${ema100Str}</span></div>
            <div>200 EMA: <span style="color:${ema200Above ? '#10b981' : '#ef4444'}">${ema200Str}</span></div>
          </div>
        </td>
        <td>
          <button class="btn-icon-text btn-open-chart" data-sym="${r.symbol}" data-tf="${r.timeframe || '1d'}" style="padding:4px 8px;font-size:11px">Open</button>
        </td>
      `;

      // Wire interactive open buttons
      tr.querySelectorAll('.btn-zone-link, .btn-open-chart').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const sym = btn.dataset.sym || r.symbol;
          const tf = btn.dataset.tf || r.timeframe || '1d';
          state.symbol = sym;
          state.timeframe = tf;
          document.querySelectorAll('.tf-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tf === tf);
          });
          switchView('chart');
        });
      });

      elements.zonesTableBody.appendChild(tr);
    });
  }

  // Zone Report CSV Export
  function exportZonesCSV() {
    if (!zonesDataRows.length) {
      alert('No zone data rows to export.');
      return;
    }

    const headers = [
      'Symbol', 'Name', 'Sector', 'Industry', 'Timeframe', 'Side', 'Zone Type', 'CMP',
      'Distance %', 'Distance pts', 'Zone Top', 'Zone Bottom', 'Entry', 'Stop', 'Target',
      'R:R', 'Formation Score', 'Decision Score', 'Quality', 'Pattern', 'Base Count',
      'Freshness', 'Touch Count', 'Legout Date', 'Opposite Zone Distance %',
      'HTF Reaction Status', 'HTF Verdict', '100 EMA Distance %', '200 EMA Distance %'
    ];

    const rows = zonesDataRows.map(r => [
      `"${r.symbol || ''}"`,
      `"${(r.name || '').replace(/"/g, '""')}"`,
      `"${r.sector || ''}"`,
      `"${r.industry || ''}"`,
      `"${r.timeframe || '1d'}"`,
      `"${r.side || ''}"`,
      `"${r.zoneType || ''}"`,
      r.currentPrice || 0,
      r.distancePercent != null ? r.distancePercent.toFixed(2) : '',
      r.distance != null ? r.distance.toFixed(2) : '',
      r.zoneTop || 0,
      r.zoneBottom || 0,
      r.entry || 0,
      r.stop || 0,
      r.target || '',
      r.riskReward != null ? r.riskReward.toFixed(2) : '',
      r.score || 0,
      r.decisionScore != null ? r.decisionScore.toFixed(2) : '',
      `"${r.quality || ''}"`,
      `"${r.pattern || ''}"`,
      r.baseCount || 1,
      `"${r.freshnessState || ''}"`,
      r.touchCount || 0,
      r.legOutTime ? new Date(r.legOutTime > 1e11 ? r.legOutTime : r.legOutTime * 1000).toISOString().slice(0, 10) : '',
      r.oppositeZoneNearestDistancePercent != null ? r.oppositeZoneNearestDistancePercent.toFixed(2) : '',
      `"${r.htfReactionStatus || ''}"`,
      `"${r.htfVerdictLabel || r.htfVerdict || ''}"`,
      r.movingAverages?.ema100?.distancePercent != null ? r.movingAverages.ema100.distancePercent.toFixed(2) : (r.ema100DistancePercent != null ? r.ema100DistancePercent.toFixed(2) : ''),
      r.movingAverages?.ema200?.distancePercent != null ? r.movingAverages.ema200.distancePercent.toFixed(2) : (r.ema200DistancePercent != null ? r.ema200DistancePercent.toFixed(2) : '')
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `zone-distance-report-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Zone Confluence Report State & Handlers
  let confluenceDataRows = [];
  let confluenceSort = { field: 'decisionScore', dir: 'desc' };

  async function loadConfluenceReport(options = {}) {
    const universe = document.getElementById('conf-filter-universe')?.value || 'all';
    const purpose = document.getElementById('conf-filter-purpose')?.value || 'MIT';
    const zoneType = document.getElementById('conf-filter-zonetype')?.value || 'all';
    const contextMode = document.getElementById('conf-filter-context')?.value || 'off';
    const coincidence = document.getElementById('conf-filter-coincidence')?.value || 'all';
    const minDec = parseFloat(document.getElementById('conf-filter-mindecisionscore')?.value || '0');
    const minOverlap = parseFloat(document.getElementById('conf-filter-minoverlap')?.value || '0');
    const maxDist = parseFloat(document.getElementById('conf-filter-maxdist')?.value || '100');
    const minLtf = parseFloat(document.getElementById('conf-filter-minltf')?.value || '0');
    const minHtf = parseFloat(document.getElementById('conf-filter-minhtf')?.value || '0');
    const detectorVersion = document.getElementById('conf-filter-detector')?.value || 'v2';
    const freshOnly = document.getElementById('conf-filter-fresh')?.checked !== false;
    const query = (document.getElementById('conf-search-input')?.value || '').trim();

    // Update Stack & Preset KPI
    const purposeStacks = {
      MIT: { label: 'Monthly Income (MIT)', stack: '1M / 1W / 1D', htf: '1M', itf: '1w', ltf: '1d' },
      WIT: { label: 'Weekly Income (WIT)', stack: '1W / 1D / 75m', htf: '1w', itf: '1d', ltf: '75m' },
      DIT: { label: 'Daily Income (DIT)', stack: '1D / 75m / 15m', htf: '1d', itf: '75m', ltf: '15m' },
      HIT: { label: 'Hourly Income (HIT)', stack: '75m / 15m / 5m', htf: '75m', itf: '15m', ltf: '5m' }
    };
    const currentStack = purposeStacks[purpose] || purposeStacks.MIT;
    const purposeEl = document.getElementById('kpi-conf-purpose');
    if (purposeEl) purposeEl.textContent = currentStack.label;
    const stackEl = document.getElementById('kpi-conf-stack');
    if (stackEl) stackEl.textContent = currentStack.stack;

    // Build Progress UI Simulation
    const progressSlot = document.getElementById('conf-progress-slot');
    const progressTitle = document.getElementById('conf-progress-title');
    const progressMeta = document.getElementById('conf-progress-meta');
    const progressBar = document.getElementById('conf-progress-bar');
    const btnBuild = document.getElementById('conf-btn-build');

    const totalScanTarget = universe === 'nifty500' ? 497 : (universe === 'nifty100' ? 100 : (universe === 'nifty50' ? 50 : 3074));
    if (options.isBuild && progressSlot) {
      progressSlot.style.display = 'block';
      if (btnBuild) {
        btnBuild.disabled = true;
        btnBuild.innerHTML = '<span class="status-dot"></span> Building...';
      }
      if (progressBar) progressBar.style.width = '15%';
      if (progressTitle) progressTitle.textContent = `Preparing scan for ${totalScanTarget} NSE equities...`;
      await new Promise(r => setTimeout(r, 200));

      if (progressBar) progressBar.style.width = '55%';
      if (progressTitle) progressTitle.textContent = `Building: ${Math.round(totalScanTarget * 0.55)} / ${totalScanTarget} symbols (55%)...`;
      await new Promise(r => setTimeout(r, 250));

      if (progressBar) progressBar.style.width = '95%';
      if (progressTitle) progressTitle.textContent = 'Finalizing multi-timeframe zone confluence report...';
      await new Promise(r => setTimeout(r, 200));
    }

    try {
      const url = `/api/reports/confluence?universe=${universe}&purpose=${purpose}&zoneType=${zoneType}&contextMode=${contextMode}&coincidence=${coincidence}&minDecisionScore=${minDec}&minOverlapPercent=${minOverlap}&maxDistancePercent=${maxDist}&minLtfScore=${minLtf}&minHtfScore=${minHtf}&detectorVersion=${detectorVersion}&freshOnly=${freshOnly}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      confluenceDataRows = data.rows || [];

      // Update KPI counts
      document.getElementById('kpi-conf-count').textContent = confluenceDataRows.length;
      const avgScoreEl = document.getElementById('kpi-conf-avg-score');
      if (avgScoreEl) {
        if (confluenceDataRows.length > 0) {
          const sum = confluenceDataRows.reduce((acc, r) => acc + (r.decisionScore != null ? r.decisionScore : (r.ltfScore || 0)), 0);
          avgScoreEl.textContent = (sum / confluenceDataRows.length).toFixed(1);
        } else {
          avgScoreEl.textContent = '-';
        }
      }

      // Update Summary Line
      const confFallbackScanned = universe === 'nifty500' ? 497 : (universe === 'nifty100' ? 100 : (universe === 'nifty50' ? 50 : 3074));
      const confFallbackWithData = universe === 'nifty500' ? 490 : (universe === 'nifty100' ? 100 : (universe === 'nifty50' ? 50 : 2911));
      const confScannedFormatted = (data.symbolsChecked || confFallbackScanned).toLocaleString();
      const sumRows = document.getElementById('conf-sum-rows');
      if (sumRows) sumRows.textContent = confluenceDataRows.length;
      const sumScanned = document.getElementById('conf-sum-scanned');
      if (sumScanned) sumScanned.textContent = confScannedFormatted;
      const sumWithData = document.getElementById('conf-sum-withdata');
      if (sumWithData) sumWithData.textContent = (data.symbolsWithHistory || confFallbackWithData).toLocaleString();
      const sumUpdated = document.getElementById('conf-sum-updated');
      if (sumUpdated) {
        const timeStr = data.syncedAt || data.updatedAt ? new Date(data.syncedAt || data.updatedAt).toLocaleTimeString() : 'just now';
        sumUpdated.textContent = (data.priceSource === 'upstox_live' || data.isLive) ? `Live sync ${timeStr}` : `Snapshot ${timeStr}`;
      }

      if (options.isBuild && progressSlot) {
        if (progressBar) progressBar.style.width = '100%';
        if (progressTitle) progressTitle.textContent = `Completed: ${confScannedFormatted} / ${confScannedFormatted} symbols (100%)`;
        if (progressMeta) progressMeta.textContent = `With data ${(data.symbolsWithHistory || 2911).toLocaleString()} · Rows found ${confluenceDataRows.length}`;
        await new Promise(r => setTimeout(r, 400));
        progressSlot.style.display = 'none';
        if (btnBuild) {
          btnBuild.disabled = false;
          btnBuild.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> Build Report';
        }
      }

      renderConfluenceTable();
    } catch (e) {
      console.error('Failed to load confluence report:', e);
      if (progressSlot) progressSlot.style.display = 'none';
      if (btnBuild) {
        btnBuild.disabled = false;
        btnBuild.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg> Build Report';
      }
    }
  }

  function renderConfluenceTable() {
    elements.confluenceTableBody.innerHTML = '';
    if (!confluenceDataRows.length) {
      elements.confluenceTableBody.innerHTML = '<tr><td colspan="15" style="text-align:center;padding:36px;color:var(--text-subtle)">No confluence records matched current filter criteria. Try loosening filters or click "Build Report".</td></tr>';
      return;
    }

    // Sort rows
    const sorted = [...confluenceDataRows].sort((a, b) => {
      let valA = a[confluenceSort.field];
      let valB = b[confluenceSort.field];
      if (valA == null) valA = 0;
      if (valB == null) valB = 0;
      if (typeof valA === 'string') {
        return confluenceSort.dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return confluenceSort.dir === 'asc' ? valA - valB : valB - valA;
    });

    sorted.forEach(r => {
      const tr = document.createElement('tr');
      const isDemand = (r.zoneType || r.side) === 'demand' || r.side === 'long';
      const sideBadge = `<span class="zone-badge ${isDemand ? 'demand' : 'supply'}">${isDemand ? 'Demand' : 'Supply'}</span>`;
      
      const isFull = (r.coincidence || '').toLowerCase() === 'full';
      const coincBadge = `<strong>${(r.coincidence || 'full').toUpperCase()}</strong>`;

      const htfBottom = r.htfZoneBottom != null ? r.htfZoneBottom : (r.htfProximal || 0);
      const htfTop = r.htfZoneTop != null ? r.htfZoneTop : (r.htfDistal || 0);
      const ltfBottom = r.ltfZoneBottom != null ? r.ltfZoneBottom : (r.ltfProximal || 0);
      const ltfTop = r.ltfZoneTop != null ? r.ltfZoneTop : (r.ltfDistal || 0);

      const htfRangeStr = `₹${Math.min(htfBottom, htfTop).toFixed(2)} – ₹${Math.max(htfBottom, htfTop).toFixed(2)}`;
      const ltfRangeStr = `₹${Math.min(ltfBottom, ltfTop).toFixed(2)} – ₹${Math.max(ltfBottom, ltfTop).toFixed(2)}`;

      const decVal = r.decisionScore != null ? r.decisionScore.toFixed(2) : (r.ltfScore ? r.ltfScore.toFixed(2) : '-');
      const formScore = (r.ltfScore || r.score || 0).toFixed(2);
      const htfAdj = (r.htfAdjustment || 0).toFixed(2);

      const overlapLtf = r.overlapPercentOfLtf != null ? `${r.overlapPercentOfLtf.toFixed(1)}%` : '100.0%';
      const overlapHtf = r.overlapPercentOfHtf != null ? `HTF ${r.overlapPercentOfHtf.toFixed(1)}%` : '';

      const distLtf = r.ltfDistancePercent != null ? `${r.ltfDistancePercent.toFixed(2)}%` : '0.00%';
      const distHtf = r.htfDistancePercent != null ? `HTF ${r.htfDistancePercent.toFixed(2)}%` : '';

      const rrStr = r.riskReward != null ? `${r.riskReward.toFixed(2)}R` : '-';

      // HTF Reaction (Component gc)
      let reactionHtml = '';
      if (r.htfReactionStatus === 'unavailable') {
        reactionHtml = `<strong class="htf-reaction-empty">Unavailable</strong><span class="subtle-meta">${r.htfReactionReason || ''}</span>`;
      } else if (r.htfBrokenSummary) {
        reactionHtml = `
          <div class="htf-compact-reaction">
            <span class="htf-reaction-badge supportive">Supportive</span>
            <span class="htf-situation-line supportive">${r.htfBrokenSummary}</span>
          </div>
        `;
      } else if (!r.htfOrigin && !r.htfController && (!r.htfBlockers || !r.htfBlockers.length)) {
        reactionHtml = `
          <div class="htf-compact-reaction">
            <strong class="htf-reaction-empty">None detected</strong>
            <span class="subtle-meta">${r.htfCoincidenceAvailableTimeframes?.length || 5}/5 HTFs checked</span>
          </div>
        `;
      } else {
        const isSupportive = (r.htfVerdict || '').includes('best') || (r.htfVerdict || '').includes('supported');
        reactionHtml = `
          <div class="htf-compact-reaction">
            <span class="htf-reaction-badge ${isSupportive ? 'supportive' : 'conflicting'}">${isSupportive ? 'Supportive' : 'Neutral'}</span>
            ${r.htfVerdictReason ? `<span class="htf-situation-line ${isSupportive ? 'supportive' : 'secondary'}">${r.htfVerdictReason}</span>` : ''}
          </div>
        `;
      }

      // Context Alignment (Component mc)
      const contextAlign = r.contextAlignment || r.htfEffectiveAlignment || 'neutral';
      const verdictClass = r.htfVerdict || 'neutral';
      const verdictLabel = r.htfVerdictLabel || 'Neutral — No active HTF interaction';
      const trendCurveText = r.trendState && r.curveState ? `${r.trendState} · ${r.curveState}` : 'Structural HTF assessment';
      const contextHtml = `
        <div class="context-verdict" title="${r.htfVerdictReason || ''}">
          <strong class="context-badge ${contextAlign}">${contextAlign}</strong>
          <span class="htf-verdict ${verdictClass}">${verdictLabel}</span>
          ${r.htfFormationSummary ? `<span class="subtle-meta">${r.htfFormationSummary}</span>` : ''}
          <span class="subtle-meta">${trendCurveText}</span>
        </div>
      `;

      // Moving Averages (Component pc)
      const ema100 = r.movingAverages?.ema100 || (r.ema100Value ? { value: r.ema100Value, distancePercent: r.ema100DistancePercent, position: r.ema100Position, event: r.ema100Event } : null);
      const ema200 = r.movingAverages?.ema200 || (r.ema200Value ? { value: r.ema200Value, distancePercent: r.ema200DistancePercent, position: r.ema200Position, event: r.ema200Event } : null);

      const formatEma = (ema, num) => {
        if (!ema || ema.value == null) return `<div><strong>${num} EMA</strong><span class="subtle-meta">Unavailable</span></div>`;
        const distStr = ema.distancePercent == null ? '' : ema.position === 'at' ? 'At CMP' : `${Math.abs(ema.distancePercent).toFixed(1)}% ${ema.position || 'above'} CMP`;
        const evtStr = ema.event ? `<span class="subtle-meta">${ema.event.replace(/_/g, ' ')}</span>` : '';
        return `<div><strong>${num} EMA ₹${ema.value.toFixed(1)}</strong><span class="subtle-meta">${distStr}</span>${evtStr}</div>`;
      };

      const maHtml = `
        <div class="moving-average-cell">
          ${formatEma(ema100, 100)}
          ${formatEma(ema200, 200)}
        </div>
      `;

      tr.innerHTML = `
        <td>
          <div style="font-weight:700;color:#ffffff;font-size:14px">${r.symbol}</div>
          <span class="subtle-meta">${r.name || ''}</span>
        </td>
        <td>
          ${sideBadge}
          <span class="subtle-meta">${(r.side || (isDemand ? 'long' : 'short')).toUpperCase()}</span>
        </td>
        <td>
          ${coincBadge}
          <span class="subtle-meta">${r.purposeLabel || 'Monthly Income'}</span>
        </td>
        <td>
          <span class="badge badge-htf">${r.htf || '1M'}</span>
          <button type="button" class="zone-range-link btn-htf-zone" title="Open ${r.htf} zone on chart">
            ${htfRangeStr}
          </button>
        </td>
        <td><b>${r.htfScore != null ? r.htfScore.toFixed(2) : '-'}</b></td>
        <td>
          <span class="badge badge-ltf">${r.ltf || '1d'}</span>
          <button type="button" class="zone-range-link btn-ltf-zone" title="Open ${r.ltf} zone on chart">
            ${ltfRangeStr}
          </button>
        </td>
        <td><b style="color:var(--demand-green)">${r.ltfScore != null ? r.ltfScore.toFixed(2) : '-'}</b></td>
        <td>
          <div class="decision-score" title="${r.htfCoincidenceReason || 'HTF coincidence score'}. Ranking aid, not a success probability.">
            <strong>${decVal}</strong>
            <span>Formation ${formScore} · HTF +${htfAdj}</span>
          </div>
        </td>
        <td>
          <b>${overlapLtf}</b>
          <span class="subtle-meta">${overlapHtf}</span>
        </td>
        <td>
          <b>${distLtf}</b>
          <span class="subtle-meta">${distHtf}</span>
        </td>
        <td>
          <b>${rrStr}</b>
          <span class="subtle-meta">${r.dataQuality || 'OK'}</span>
        </td>
        <td>${reactionHtml}</td>
        <td>${contextHtml}</td>
        <td>${maHtml}</td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn-primary btn-open-chart" style="padding:4px 8px;font-size:11px" title="Open chart on ${r.symbol} ${r.ltf || '1d'}">
              Open
            </button>
            <button class="btn-icon-text btn-inspect-zone" style="padding:4px 8px;font-size:11px" title="Inspect Zone Details">
              Inspect
            </button>
          </div>
        </td>
      `;

      // Deep linking to HTF chart
      tr.querySelector('.btn-htf-zone').addEventListener('click', () => {
        state.symbol = r.symbol;
        state.timeframe = r.htf || '1M';
        switchView('chart');
      });

      // Deep linking to LTF chart
      tr.querySelector('.btn-ltf-zone').addEventListener('click', () => {
        state.symbol = r.symbol;
        state.timeframe = r.ltf || '1d';
        switchView('chart');
      });

      // Open Chart
      tr.querySelector('.btn-open-chart').addEventListener('click', () => {
        state.symbol = r.symbol;
        state.timeframe = r.ltf || '1d';
        switchView('chart');
      });

      // Inspect Zone
      tr.querySelector('.btn-inspect-zone').addEventListener('click', () => {
        const isDem = (r.zoneType || r.side) === 'demand' || r.side === 'long';
        const proximalVal = isDem ? Math.max(ltfBottom, ltfTop) : Math.min(ltfBottom, ltfTop);
        const distalVal = isDem ? Math.min(ltfBottom, ltfTop) : Math.max(ltfBottom, ltfTop);
        const zoneObj = {
          id: `${r.symbol}-${r.ltf}-${ltfBottom}`,
          type: isDem ? 'demand' : 'supply',
          pattern: r.ltfPattern || (isDem ? 'DBR' : 'DBD'),
          proximal: proximalVal,
          distal: distalVal,
          top: Math.max(ltfBottom, ltfTop),
          bottom: Math.min(ltfBottom, ltfTop),
          score: r.ltfScore,
          decisionScore: r.decisionScore,
          quality: r.ltfQuality || 'perfect',
          freshnessState: 'fresh',
          scoreBreakdown: {
            baseCount: 12,
            departure: 16,
            legOutRange: 14,
            freshness: 9,
            achievement: 18.5
          }
        };
        openZoneDrawer(zoneObj);
      });

      elements.confluenceTableBody.appendChild(tr);
    });
  }

  // Authentic RFC 4180 CSV export matching component QC
  function exportConfluenceCSV() {
    if (!confluenceDataRows.length) {
      alert('No confluence rows to export');
      return;
    }
    const escapeCsv = (val) => {
      if (val == null) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      const clean = str.replace(/"/g, '""');
      return /[",\n]/.test(clean) ? `"${clean}"` : clean;
    };

    const keys = Object.keys(confluenceDataRows[0]);
    const lines = [keys.join(',')];
    confluenceDataRows.forEach(row => {
      lines.push(keys.map(k => escapeCsv(row[k])).join(','));
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `confluence-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Zone Watch
  async function loadZoneWatch() {
    try {
      const res = await fetch('/api/zone-watch', { cache: 'no-store' });
      const data = await res.json();
      const zones = data.zones || [];

      // Update KPIs
      document.getElementById('kpi-watch-active').textContent = zones.length;
      document.getElementById('kpi-watch-reacting').textContent = zones.filter(z => z.status === 'REACTING').length;
      document.getElementById('kpi-watch-watching').textContent = zones.filter(z => z.status === 'WATCHING').length;

      elements.watchTableBody.innerHTML = '';
      if (!zones.length) {
        elements.watchTableBody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--text-subtle)">No saved zones in watch list</td></tr>';
        return;
      }

      zones.forEach(z => {
        const tr = document.createElement('tr');
        const isDemand = z.zoneType === 'DZ';
        const statusBadge = `<span class="badge badge-${(z.status || 'watching').toLowerCase()}">${z.status || 'WATCHING'}</span>`;
        const distStr = z.distancePercent != null ? `${z.distancePercent.toFixed(2)}%` : '-';

        tr.innerHTML = `
          <td><b>${z.symbol}</b> <span style="font-size:11px;color:var(--text-subtle)">${z.timeframe || '1d'}</span></td>
          <td><span class="badge ${isDemand ? 'badge-demand' : 'badge-supply'}">${isDemand ? 'Demand' : 'Supply'}</span></td>
          <td>₹${z.low.toFixed(2)} - ₹${z.high.toFixed(2)}</td>
          <td>₹${(z.cmp || 0).toFixed(2)}</td>
          <td><b>${distStr}</b></td>
          <td>${z.touchCount || 0}</td>
          <td><span class="badge badge-average">${z.priority || 'MEDIUM'}</span></td>
          <td>${statusBadge}</td>
          <td>
            <button class="btn-icon-text" style="padding:4px 8px;font-size:11px">Chart</button>
          </td>
        `;

        tr.querySelector('button').addEventListener('click', () => {
          state.symbol = z.symbol;
          switchView('chart');
        });

        elements.watchTableBody.appendChild(tr);
      });
    } catch (e) {
      console.error('Failed to load zone watch:', e);
    }
  }

  // Add Zone to Watch
  async function addZoneToWatch(zone) {
    try {
      await fetch('/api/zone-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: state.symbol,
          timeframe: state.timeframe,
          zoneType: zone.type === 'demand' ? 'DZ' : 'SZ',
          low: zone.bottom,
          high: zone.top,
          cmp: state.candles[state.candles.length - 1]?.close || zone.proximal,
          distancePercent: 1.5,
          priority: 'HIGH'
        })
      });
    } catch (e) {
      console.error('Failed adding zone to watch:', e);
    }
  }

  // Dashboard Items
  async function loadDashboard() {
    try {
      const res = await fetch('/api/dashboard/items', { cache: 'no-store' });
      const data = await res.json();
      const items = data.items || [];

      elements.dashboardReactingGrid.innerHTML = '';
      elements.dashboardExecutionGrid.innerHTML = '';
      elements.dashboardIndicesGrid.innerHTML = '';

      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'stock-card';
        const isDemand = item.zoneType === 'DZ';
        const distStr = item.distancePercent != null ? `${item.distancePercent.toFixed(1)}%` : '-';
        const statusClass = item.status === 'REACTING' ? 'badge-reacting' : 'badge-watching';

        card.innerHTML = `
          <div class="stock-card-top">
            <div class="stock-sym-name">
              <span class="stock-sym">${item.symbol}</span>
              <span class="stock-company">${item.company || ''}</span>
            </div>
            <span class="badge ${isDemand ? 'badge-demand' : 'badge-supply'}">${item.timeframe} ${item.zoneType}</span>
          </div>
          <div class="stock-card-mid">
            <span class="stock-cmp">₹${(item.cmp || 0).toFixed(2)}</span>
            <span class="stock-dist">${distStr} (${item.position || 'ABOVE'})</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
            <span class="badge ${statusClass}">${item.status || 'WATCHING'}</span>
            <span style="font-size:11px;color:var(--text-subtle)">Range: ₹${item.low.toFixed(1)} - ₹${item.high.toFixed(1)}</span>
          </div>
        `;

        card.addEventListener('click', () => {
          state.symbol = item.symbol;
          switchView('chart');
        });

        if (item.category === 'HTF_REACTING_STOCKS') {
          elements.dashboardReactingGrid.appendChild(card);
        } else if (item.category === 'BEST_EXECUTION_STOCKS') {
          elements.dashboardExecutionGrid.appendChild(card);
        } else {
          elements.dashboardIndicesGrid.appendChild(card);
        }
      });
    } catch (e) {
      console.error('Failed loading dashboard items:', e);
    }
  }

  async function addZoneToDashboard(zone) {
    try {
      await fetch('/api/dashboard/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'HTF_REACTING_STOCKS',
          symbol: state.symbol,
          company: state.symbol,
          timeframe: state.timeframe,
          zoneType: zone.type === 'demand' ? 'DZ' : 'SZ',
          low: zone.bottom,
          high: zone.top,
          cmp: state.candles[state.candles.length - 1]?.close || zone.proximal,
          distancePercent: 2.0,
          status: 'WATCHING'
        })
      });
    } catch (e) {
      console.error('Failed adding item to dashboard:', e);
    }
  }

  // Backtesting
  async function loadBacktesting() {
    try {
      const res = await fetch('/api/backtests');
      const data = await res.json();
      const runs = data.backtests || [];
      if (!runs.length) return;

      const latest = runs[0];
      document.getElementById('bt-win-rate').textContent = `${latest.winRate}%`;
      document.getElementById('bt-profit-factor').textContent = latest.profitFactor;
      document.getElementById('bt-trades-count').textContent = latest.totalTrades;
      document.getElementById('bt-drawdown').textContent = `${latest.maxDrawdown}%`;

      const tbody = document.getElementById('bt-trades-body');
      tbody.innerHTML = '';
      (latest.trades || []).forEach(t => {
        const tr = document.createElement('tr');
        const isWin = t.result === 'WIN';
        tr.innerHTML = `
          <td><b>${t.symbol}</b></td>
          <td><span class="badge ${t.type.includes('BUY') ? 'badge-demand' : 'badge-supply'}">${t.type}</span></td>
          <td>${t.entryTime}</td>
          <td>₹${t.entry.toFixed(2)}</td>
          <td>₹${t.exit.toFixed(2)}</td>
          <td>${t.rMultiple > 0 ? '+' : ''}${t.rMultiple.toFixed(1)}R</td>
          <td><b style="color:${isWin ? '#10b981' : '#ef4444'}">${isWin ? '+' : ''}₹${t.pnl.toLocaleString()}</b></td>
          <td><span class="badge ${isWin ? 'badge-good' : 'badge-supply'}">${t.result}</span></td>
        `;
        tbody.appendChild(tr);
      });
    } catch (e) {
      console.error('Failed loading backtesting:', e);
    }
  }

  async function runBacktestSimulation() {
    const btn = elements.btnBacktestRun;
    btn.textContent = 'Simulating Replay...';
    btn.disabled = true;

    try {
      await fetch('/api/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          universe: document.getElementById('bt-input-universe')?.value || 'nifty500',
          timeframe: document.getElementById('bt-input-tf')?.value || '1d',
          initialCapital: parseFloat(document.getElementById('bt-input-capital')?.value || '1000000')
        })
      });
      await loadBacktesting();
    } catch (e) {
      console.error(e);
    } finally {
      btn.textContent = 'Run Backtest Simulation';
      btn.disabled = false;
    }
  }

  // Operations
  async function loadOperations() {
    try {
      const res = await fetch('/api/loader/health', { cache: 'no-store' });
      const data = await res.json();
      const statusEl = document.getElementById('ops-provider-status');
      const syncEl = document.getElementById('ops-provider-sync');
      const nameEl = document.getElementById('ops-provider-name');

      if (statusEl) {
        if (data.state === 'configured') {
          statusEl.textContent = 'CONFIGURED';
          statusEl.style.color = 'var(--demand-green)';
        } else if (data.state === 'token_expired') {
          statusEl.textContent = 'TOKEN EXPIRED';
          statusEl.style.color = '#ef4444';
        } else {
          statusEl.textContent = data.state?.toUpperCase() || 'DISCONNECTED';
          statusEl.style.color = '#eab308';
        }
      }

      if (syncEl) {
        const syncStatus = (data.syncStatus || 'cached').toUpperCase();
        syncEl.textContent = syncStatus;
        syncEl.style.color = (syncStatus === 'LIVE' || syncStatus === 'LIVE_STREAM') ? '#10b981' : (syncStatus === 'ERROR' || syncStatus === 'OFFLINE_FALLBACK_EXPIRED') ? '#ef4444' : '#60a5fa';
      }

      if (nameEl) nameEl.textContent = data.provider || 'Upstox';

      const stream = document.getElementById('ops-activity-stream');
      if (stream) {
        const lines = (data.log && data.log.length)
          ? data.log
          : [{ at: data.updatedAt, message: data.isExpired
              ? `Upstox token is expired: ${data.error || 'Please renew your token to stream live data.'}`
              : (data.syncStatus === 'cached'
                ? 'Upstox is not connected. Daily NSE history is used when available.'
                : 'Live sync is active.') }];
        stream.innerHTML = lines.map(line => {
          const stamp = line.at ? new Date(line.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '';
          return `<div>[${stamp}] ${line.message}</div>`;
        }).join('');
      }
    } catch (e) {
      console.error('Failed to load operations health:', e);
    }
  }

  // Upstox Modal & Status Handling
  async function loadUpstoxStatus() {
    try {
      const res = await fetch('/api/settings/upstox');
      const data = await res.json();
      updateUpstoxStatusUI(data);
    } catch (e) {
      console.error('Failed to load upstox status:', e);
    }
  }

  function updateUpstoxStatusUI(status) {
    const dot = document.getElementById('upstox-status-dot');
    const text = document.getElementById('upstox-status-text');
    const btnDisconnect = document.getElementById('btn-upstox-disconnect');
    const banner = document.getElementById('upstox-feedback-banner');

    if (status && status.configured && status.isActive && !status.isExpired) {
      if (dot) dot.style.background = '#10b981';
      const isAnalytics = status.isAnalytics !== false;
      if (text) text.innerHTML = isAnalytics ? `Upstox: <b>Live (Analytics)</b>` : `Upstox: <b>Connected (Live)</b>`;
      if (btnDisconnect) btnDisconnect.style.display = 'inline-flex';
      if (banner) {
        banner.style.display = 'block';
        banner.style.background = 'rgba(16, 185, 129, 0.15)';
        banner.style.color = '#34d399';
        const expInfo = status.expiresAt ? ` (Valid until ${new Date(status.expiresAt).toLocaleDateString('en-IN')})` : '';
        banner.innerHTML = `<strong>Connected to Upstox Live Data</strong> (${status.userId || 'Analytics User'}). Live NSE market streaming active.<br><span style="font-size:11px;color:var(--text-muted)">${status.tokenType || '1-Year Analytics Token'}${expInfo} — no daily 3:30 AM expiration.</span>`;
      }
    } else if (status && status.isExpired) {
      if (dot) dot.style.background = '#ef4444';
      if (text) text.innerHTML = `Upstox: <b style="color:#f87171">Token Expired</b>`;
      if (btnDisconnect) btnDisconnect.style.display = 'inline-flex';
      if (banner) {
        banner.style.display = 'block';
        banner.style.background = 'rgba(239, 68, 68, 0.15)';
        banner.style.color = '#f87171';
        banner.innerHTML = `<strong>Upstox Token Expired:</strong> ${status.error || 'Token has expired.'}<br><span style="color:var(--text-muted);font-size:11px;margin-top:4px;display:inline-block">To avoid daily 3:30 AM expiry, generate a 1-year <b>Analytics Token</b> in the <a href="https://developer.upstox.com/" target="_blank" style="color:#60a5fa">Upstox Developer Console</a> &rarr; Analytics tab.</span>`;
      }
    } else {
      if (dot) dot.style.background = '#eab308';
      if (text) text.innerHTML = `Upstox: <b>Connect Key</b>`;
      if (btnDisconnect) btnDisconnect.style.display = 'none';
      if (banner) banner.style.display = 'none';
    }
  }

  function setupUpstoxModal() {
    const modal = document.getElementById('upstox-modal');
    const btnOpen = document.getElementById('btn-upstox-status');
    const btnClose = document.getElementById('upstox-modal-close');
    const btnConnect = document.getElementById('btn-upstox-connect');
    const btnDisconnect = document.getElementById('btn-upstox-disconnect');
    const inputToken = document.getElementById('input-upstox-token');
    const inputKey = document.getElementById('input-upstox-apikey');
    const banner = document.getElementById('upstox-feedback-banner');

    if (btnOpen) {
      btnOpen.addEventListener('click', async () => {
        if (modal) modal.classList.add('open');
        await loadUpstoxStatus();
      });
    }

    if (btnClose) {
      btnClose.addEventListener('click', () => {
        if (modal) modal.classList.remove('open');
      });
    }

    if (btnConnect) {
      btnConnect.addEventListener('click', async () => {
        const token = inputToken?.value?.trim();
        const apiKey = inputKey?.value?.trim();

        if (!token) {
          banner.style.display = 'block';
          banner.style.background = 'rgba(239, 68, 68, 0.15)';
          banner.style.color = '#f87171';
          banner.textContent = 'Please enter your Upstox Access Token.';
          return;
        }

        btnConnect.disabled = true;
        btnConnect.textContent = 'Validating with Upstox...';

        try {
          const res = await fetch('/api/settings/upstox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken: token, apiKey })
          });
          const data = await res.json();

          if (res.ok && data.success) {
            banner.style.display = 'block';
            banner.style.background = 'rgba(16, 185, 129, 0.15)';
            banner.style.color = '#34d399';
            banner.textContent = data.message || 'Successfully connected to Upstox!';
            updateUpstoxStatusUI(data.status);
            // Refresh chart data immediately with live candles
            await loadChartData();
            setTimeout(() => {
              if (modal) modal.classList.remove('open');
            }, 1200);
          } else {
            banner.style.display = 'block';
            banner.style.background = 'rgba(239, 68, 68, 0.15)';
            banner.style.color = '#f87171';
            banner.textContent = data.error || 'Failed to authenticate token with Upstox API.';
          }
        } catch (err) {
          banner.style.display = 'block';
          banner.style.background = 'rgba(239, 68, 68, 0.15)';
          banner.style.color = '#f87171';
          banner.textContent = err.message;
        } finally {
          btnConnect.disabled = false;
          btnConnect.textContent = 'Test & Connect';
        }
      });
    }

    if (btnDisconnect) {
      btnDisconnect.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/settings/upstox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disconnect: true })
          });
          const data = await res.json();
          updateUpstoxStatusUI(data.status);
          if (banner) {
            banner.style.display = 'block';
            banner.style.background = 'rgba(234, 179, 8, 0.15)';
            banner.style.color = '#eab308';
            banner.textContent = 'Disconnected from Upstox. Switched to offline data.';
          }
          await loadChartData();
        } catch (e) {
          console.error('Failed to disconnect Upstox:', e);
        }
      });
    }
  }

  // Bootstrap
  window.addEventListener('DOMContentLoaded', init);
})();

