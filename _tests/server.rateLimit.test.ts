import request from 'supertest';
import { buildApp } from '@server/app';
import { LIMITS } from '@server/middleware/rateLimit';

// The limiters run before auth, so unauthenticated calls (401/400) still count; a 429 means the
// limiter, not the route, answered. No Mongo or wallet: every call stops at a guard or validator.

type App = ReturnType<typeof buildApp>;

async function hit(app: App, n: number, send: (app: App) => request.Test) {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await send(app)).status);
  return statuses;
}

afterEach(() => { delete process.env.CLIENT_IP_HEADER; });

test('login has its own limit', async () => {
  const statuses = await hit(buildApp(), LIMITS.login + 1, (app) => request(app).post('/api/login').send({}));
  expect(statuses[LIMITS.login - 1]).not.toBe(429);
  expect(statuses[LIMITS.login]).toBe(429);
});

test('a 429 carries the JSON error shape and rate-limit headers', async () => {
  const app = buildApp();
  await hit(app, LIMITS.login, (a) => request(a).post('/api/login').send({}));
  const res = await request(app).post('/api/login').send({});
  expect(res.status).toBe(429);
  expect(res.body.error).toMatch(/too many/i);
  expect(res.headers.ratelimit).toBeDefined();
});

test('all /api routes share the general limit', async () => {
  const app = buildApp();
  await hit(app, LIMITS.api, (a) => request(a).get('/api/inventory/get'));
  expect((await request(app).get('/api/player-stats')).status).toBe(429);
});

test('routes that receive an already-broadcast payment get the general limit only', async () => {
  // A tighter limit here would strand the client's broadcast payment.
  const app = buildApp();
  for (const path of ['/api/items/mint-and-transfer', '/api/crafting/mint-and-transfer', '/api/marketplace/purchase-listing']) {
    const statuses = await hit(app, LIMITS.login + 1, (a) => request(a).post(path).send({}));
    expect(statuses).not.toContain(429);
  }
});

test('non-/api paths are not limited', async () => {
  const statuses = await hit(buildApp(), LIMITS.api + 1, (app) => request(app).get('/some/spa/route'));
  expect(statuses).not.toContain(429);
});

test('with CLIENT_IP_HEADER set, clients are told apart by that header', async () => {
  process.env.CLIENT_IP_HEADER = 'cf-connecting-ip';
  const app = buildApp();
  await hit(app, LIMITS.login, (a) => request(a).post('/api/login').set('CF-Connecting-IP', '203.0.113.1').send({}));
  const other = await request(app).post('/api/login').set('CF-Connecting-IP', '203.0.113.2').send({});
  expect(other.status).not.toBe(429);
  const same = await request(app).post('/api/login').set('CF-Connecting-IP', '203.0.113.1').send({});
  expect(same.status).toBe(429);
});

test('a CLIENT_IP_HEADER value that is not a single IP falls back to the socket IP', async () => {
  process.env.CLIENT_IP_HEADER = 'x-forwarded-for';
  const app = buildApp();
  let i = 0;
  const statuses = await hit(app, LIMITS.login + 1, (a) => request(a).post('/api/login').set('X-Forwarded-For', `203.0.113.${++i}, 10.0.0.1`).send({}));
  expect(statuses[LIMITS.login]).toBe(429);
});

test('without CLIENT_IP_HEADER, a spoofed CF-Connecting-IP does not reset the limit', async () => {
  const app = buildApp();
  let i = 0;
  const statuses = await hit(app, LIMITS.login + 1, (a) => request(a).post('/api/login').set('CF-Connecting-IP', `203.0.113.${++i}`).send({}));
  expect(statuses[LIMITS.login]).toBe(429);
});
