#!/usr/bin/env node
/**
 * Prueba de humo del bundle desplegable del conector MCP (sin dependencias):
 *
 *   npm run smoke [-- ruta/al/server.mjs]
 *
 * Arranca el bundle (por defecto `dist/bundle/server.mjs`) como en producción
 * (`node --enable-source-maps`), con una configuración de prueba que no llega a ninguna API, y
 * exige en menos de 15 s:
 *   - `GET /health` → 200 con la versión de `package.json`;
 *   - `GET /.well-known/oauth-protected-resource/mcp` → 200 (los routers están montados);
 *   - `GET /.well-known/openai-apps-challenge` → 200 con el token de prueba, tal cual;
 *   - `GET /health/ready` → 503 (ni el JWKS ni el Redis de prueba responden: la sonda profunda
 *     funciona), con `mcp.not_ready` listando `redis` y sin caer a la memoria: el cliente de
 *     Redis empaquetado (ioredis, CJS), el que usan producción y staging, se construye de verdad.
 * Lo para al terminar. Cualquier fallo sale con código 1 y la salida del proceso: un `require`
 * sin shim, una dependencia que esbuild no resolvió o un fallo de interop ESM/CJS se ven aquí y
 * no tras recargar el proceso en el servidor.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = path.resolve(process.argv[2] || path.join(ROOT, 'dist/bundle/server.mjs'));
const EXPECTED_VERSION = require(path.join(ROOT, 'package.json')).version;
const DEADLINE_MS = 15_000;
const POLL_MS = 250;
const SMOKE_CHALLENGE = 'smoke-openai-apps-challenge';

/** Un puerto libre de loopback (lo elige el sistema y se libera al momento). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function status(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    return { status: 0, body: '' };
  }
}

async function main() {
  const port = await freePort();
  // Un puerto cerrado: nada responde ahí (readiness 503, sin tráfico fuera de la máquina).
  const deadApi = `http://127.0.0.1:${await freePort()}`;
  // Redis en otro puerto cerrado: se construye el cliente empaquetado (el camino de producción) y
  // la sonda de readiness lo da por caído; sin tráfico fuera de la máquina.
  const deadRedis = `redis://127.0.0.1:${await freePort()}`;
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    APP_ENVIRONMENT: 'test',
    PORT: String(port),
    MCP_PUBLIC_URL: `${base}/mcp`,
    API_BASE_URL: deadApi,
    OAUTH_ISSUER: deadApi,
    DASHBOARD_URL: 'https://dashboard.example.test',
    APP_BASE_URL: 'https://app.example.test',
    REDIS_URL: deadRedis,
    LOG_LEVEL: 'info',
    OPENAI_APPS_CHALLENGE: SMOKE_CHALLENGE,
  };

  const output = [];
  const child = spawn(process.execPath, ['--enable-source-maps', BUNDLE], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const fail = (reason) => {
    console.error(`::error::bundle smoke test failed: ${reason}`);
    console.error(output.join('') || '(no output from the bundle)');
    if (exited === null) child.kill('SIGKILL');
    process.exit(1);
  };

  const deadline = Date.now() + DEADLINE_MS;
  let health = { status: 0, body: '' };
  while (Date.now() < deadline) {
    if (exited !== null) fail(`the bundle exited early (${JSON.stringify(exited)})`);
    health = await status(`${base}/health`);
    if (health.status === 200) break;
    await sleep(POLL_MS);
  }
  if (health.status !== 200) fail(`GET /health never answered 200 within ${DEADLINE_MS} ms`);

  let version;
  try {
    version = JSON.parse(health.body).version;
  } catch {
    fail(`GET /health did not return JSON: ${health.body}`);
  }
  if (version !== EXPECTED_VERSION) {
    fail(`GET /health reports version ${version}, expected ${EXPECTED_VERSION}`);
  }

  const prm = await status(`${base}/.well-known/oauth-protected-resource/mcp`);
  if (prm.status !== 200)
    fail(`GET /.well-known/oauth-protected-resource/mcp answered ${prm.status}`);

  const challenge = await status(`${base}/.well-known/openai-apps-challenge`);
  if (challenge.status !== 200 || challenge.body !== SMOKE_CHALLENGE) {
    fail(`GET /.well-known/openai-apps-challenge answered ${challenge.status}: ${challenge.body}`);
  }

  const ready = await status(`${base}/health/ready`);
  if (ready.status !== 503) {
    fail(
      `GET /health/ready answered ${ready.status}; expected 503 with an unreachable JWKS and Redis`
    );
  }
  // El camino de producción y staging: el cliente de Redis empaquetado (ioredis, CJS) se ha
  // construido y la sonda lo ha usado (`failed` incluye `redis`), sin caer a la memoria.
  await sleep(100);
  const logs = output.join('');
  if (logs.includes('mcp.shared_state.memory_fallback')) {
    fail('the bundle fell back to in-memory shared state: the Redis path was not exercised');
  }
  const notReady = logs
    .split('\n')
    .filter((line) => line.includes('"mcp.not_ready"'))
    .map((line) => JSON.parse(line));
  if (!notReady.some((entry) => Array.isArray(entry.failed) && entry.failed.includes('redis'))) {
    fail('the readiness probe did not report the (unreachable) Redis as failed');
  }

  child.kill('SIGTERM');
  const stopDeadline = Date.now() + 5000;
  while (exited === null && Date.now() < stopDeadline) await sleep(50);
  if (exited === null) child.kill('SIGKILL');

  console.log(
    `bundle smoke test passed: ${path.relative(ROOT, BUNDLE)} v${version} (/health 200, PRM 200, challenge 200, /health/ready 503 with jwks+redis down)`
  );
}

main().catch((error) => {
  console.error(
    `::error::bundle smoke test crashed: ${error && error.stack ? error.stack : error}`
  );
  process.exit(1);
});
