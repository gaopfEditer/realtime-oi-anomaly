const API = process.env.API_URL || 'http://localhost:3001';

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const health = await request('/');
  assert(health.status === 200 && health.body.status === 'online', `health failed: ${JSON.stringify(health)}`);

  const coins = await request('/api/v1/coins');
  assert(coins.status === 200 && Array.isArray(coins.body.coins) && coins.body.coins.length > 0, `coins failed: ${JSON.stringify(coins)}`);

  const locked = await request('/api/v1/rankings');
  assert(locked.status === 403 && locked.body.error === 'VIP required', `rankings without token should be 403: ${JSON.stringify(locked)}`);

  const badLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nope@local.dev', password: 'wrong' }),
  });
  assert(badLogin.status === 400, `bad login should be 400: ${JSON.stringify(badLogin)}`);

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'demo@local.dev', password: 'demo123' }),
  });
  assert(login.status === 200 && login.body.token && login.body.vip === true, `login failed: ${JSON.stringify(login)}`);

  const vip = await request('/api/v1/rankings', {
    headers: { Authorization: `Bearer ${login.body.token}` },
  });
  assert(vip.status === 200 && Array.isArray(vip.body.rankings) && vip.body.rankings.length > 0, `vip rankings failed: ${JSON.stringify(vip)}`);

  console.log('verify ok');
  console.log(JSON.stringify({
    health: health.body,
    coins: coins.body.coins.map((c) => c.id),
    rankingsLocked: locked.body,
    rankings: vip.body.rankings.map((r) => r.id),
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
