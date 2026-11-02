import fs from 'fs';

const BASE_URL = 'https://landowner-outweigh-olive.ngrok-free.dev';

async function test() {
  console.log('Testing connection to', BASE_URL);
  
  // 1. Fetch bootstrap-status
  try {
    const res = await fetch(`${BASE_URL}/api/auth/bootstrap-status`, {
      headers: {
        'ngrok-skip-browser-warning': 'true'
      }
    });
    console.log('bootstrap-status status:', res.status);
    const data = await res.text();
    console.log('bootstrap-status body:', data.slice(0, 300));
  } catch (err) {
    console.error('Error fetching bootstrap-status:', err.message);
  }

  // 2. Fetch CSS
  try {
    const resCss = await fetch(`${BASE_URL}/assets/index-VzkoQAKI.css`, {
      headers: {
        'ngrok-skip-browser-warning': 'true'
      }
    });
    console.log('CSS status:', resCss.status);
    if (resCss.ok) {
      const css = await resCss.text();
      fs.writeFileSync('_cache/index.css', css);
      console.log('Saved CSS, size:', css.length);
    }
  } catch (err) {
    console.error('Error fetching CSS:', err.message);
  }

  // 3. Try login
  try {
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
    console.log('Login status:', loginRes.status);
    const cookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
    console.log('Set-Cookie:', cookies);
    const loginData = await loginRes.text();
    console.log('Login body:', loginData);

    const cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');

    // 4. Try auth/me
    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: {
        'Cookie': cookieHeader,
        'ngrok-skip-browser-warning': 'true'
      }
    });
    console.log('auth/me status:', meRes.status);
    console.log('auth/me body:', await meRes.text());
  } catch (err) {
    console.error('Error logging in:', err.message);
  }
}

test();
