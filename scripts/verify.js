const API = process.env.API_URL || 'http://localhost:3101';

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

  const cfg = await request('/api/v1/config');
  assert(cfg.status === 200 && cfg.body.watch, `config failed: ${JSON.stringify(cfg)}`);
  assert(Array.isArray(cfg.body.watch.stages) && cfg.body.watch.stages.length === 8, 'watch stages missing');

  const coins = await request('/api/v1/coins');
  assert(coins.status === 200 && Array.isArray(coins.body.coins) && coins.body.coins.length > 0, `coins failed: ${JSON.stringify(coins)}`);

  const rankings = await request('/api/v1/rankings');
  if (cfg.body.vipRequired) {
    assert(rankings.status === 403, `rankings without token should be 403: ${JSON.stringify(rankings)}`);
  } else {
    assert(rankings.status === 200 && Array.isArray(rankings.body.rankings), `rankings failed: ${JSON.stringify(rankings)}`);
  }

  const watch = await request('/api/v1/watchlist?stage=active');
  assert(watch.status === 200 && Array.isArray(watch.body.entries), `watchlist failed: ${JSON.stringify(watch)}`);
  assert(watch.body.meta && watch.body.meta.tickMs > 0 && watch.body.meta.ttlHours === 6, 'watchlist meta failed');

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
    dataSource: health.body.dataSource,
    coins: coins.body.coins.map((c) => c.id),
    vipRequired: cfg.body.vipRequired,
    rankings: vip.body.rankings.map((r) => r.id),
    watch: {
      active: watch.body.meta.counts.active,
      stages: cfg.body.watch.stages.map((s) => s.key),
      tickMs: cfg.body.watch.tickMs,
      ttlHours: cfg.body.watch.ttlHours,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
