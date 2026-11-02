import fs from 'fs';

const BASE_URL = 'https://landowner-outweigh-olive.ngrok-free.dev';

async function extractAll() {
  console.log('Logging in...');
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true'
    },
    body: JSON.stringify({
      id: 'pradyumn.m',
      password: 'Pradyumn@123'
    })
  });

  const cookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
  const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
  console.log('Logged in successfully!');

  const headers = {
    'Cookie': cookieHeader,
    'ngrok-skip-browser-warning': 'true'
  };

  // Helper to fetch and save JSON
  async function fetchAndSave(url, filename) {
    try {
      console.log(`Fetching ${url}...`);
      const res = await fetch(`${BASE_URL}${url}`, { headers });
      if (!res.ok) {
        console.error(`Failed ${url}: ${res.status} ${res.statusText}`);
        return null;
      }
      const data = await res.json();
      fs.writeFileSync(`_cache/${filename}`, JSON.stringify(data, null, 2));
      console.log(`Saved _cache/${filename} (${(JSON.stringify(data).length / 1024).toFixed(1)} KB)`);
      return data;
    } catch (e) {
      console.error(`Error ${url}:`, e.message);
      return null;
    }
  }

  // 1. Report Universes
  await fetchAndSave('/api/report-universes', 'report-universes.json');

  // 2. Instruments
  const instData = await fetchAndSave('/api/instruments', 'instruments.json');

  // 3. User tool states
  await fetchAndSave('/api/user/tool-state', 'user-tool-state.json');

  // 4. Zone Watch
  await fetchAndSave('/api/zone-watch', 'zone-watch.json');

  // 5. Dashboard
  await fetchAndSave('/api/dashboard', 'dashboard.json');

  // 6. Reports: Zones (demand and supply)
  await fetchAndSave('/api/reports/zones?timeframe=1d&zoneType=demand&universe=nifty500&build=false&detectorVersion=v2&minScore=80&minDecisionScore=80', 'report-zones-demand.json');
  await fetchAndSave('/api/reports/zones?timeframe=1d&zoneType=supply&universe=nifty500&build=false&detectorVersion=v2&minScore=80&minDecisionScore=80', 'report-zones-supply.json');

  // 7. Reports: Confluence
  await fetchAndSave('/api/reports/confluence?universe=nifty500&detectorVersion=v2&build=false', 'report-confluence.json');

  // 8. Candles for key symbols (COCHINSHIP, RELIANCE, TATASTEEL, INOXWIND, TITAN, AARTIDRUGS)
  const symbols = ['COCHINSHIP', 'RELIANCE', 'TATASTEEL', 'INOXWIND', 'TITAN', 'AARTIDRUGS', 'ONESOURCE'];
  for (const sym of symbols) {
    await fetchAndSave(`/api/candles?symbol=${sym}&timeframe=1d&max=true&basis=raw`, `candles-${sym}-1d.json`);
    // also fetch zones detect for each
    await fetchAndSave(`/api/zones/detect?symbol=${sym}&timeframe=1d&version=v3`, `zones-v3-${sym}-1d.json`);
  }

  // 9. Operations health
  await fetchAndSave('/api/loader/health', 'loader-health.json');
  await fetchAndSave('/api/operations/jobs', 'operations-jobs.json');

  console.log('Extraction complete!');
}

extractAll();
