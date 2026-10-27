/**
 * Test del script de despliegue remoto (sin dependencias): `npm run test:deploy`.
 * Ejecuta `deploy/remote-deploy.sh` con bash en un APP_DIR temporal y con dobles de `pm2`, `curl`
 * y `sleep` en el PATH, y comprueba qué hace y, sobre todo, qué escribe: solo líneas `DEPLOY: …`,
 * nunca la salida de pm2 ni ningún valor de las variables.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'remote-deploy.sh');
const NOISE = 'NOISE-FROM-PM2-THAT-MUST-NOT-LEAK';
const VERSION = '9.8.7';

const PM2_STUB = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/pm2.calls"
# Como el pm2 real, todo menos jlist (JSON puro) escribe texto que no debe salir del servidor.
[ "$1" = jlist ] || echo "${NOISE} $*"
case "$1" in
  describe) [ -f "$FAKE_DIR/registered" ]; exit $? ;;
  list) printf '%s\\n' "\${FAKE_PM2_LIST:-}" ;;
  reload)
    n=$(cat "$FAKE_DIR/reloads" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_DIR/reloads"
    if [ "$n" -le "\${FAKE_RELOAD_REJECTIONS:-0}" ]; then echo "[PM2][ERROR] Reload already in progress"; fi ;;
  jlist) cat "$FAKE_DIR/jlist.json" ;;
esac
exit 0
`;
const CURL_STUB = `#!/usr/bin/env bash
echo "${NOISE}"
exit "\${FAKE_CURL_EXIT:-0}"
`;
const SLEEP_STUB = '#!/usr/bin/env bash\nexit 0\n';

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function setup({ envLocal = 'APP_ENVIRONMENT=staging\n', registered = true, jlist } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-remote-deploy-'));
  const appDir = path.join(root, 'app');
  const fakeDir = path.join(root, 'fake');
  const binDir = path.join(root, 'bin');
  for (const dir of [appDir, fakeDir, binDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(appDir, 'server.mjs'), '// bundle\n');
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: VERSION }));
  fs.copyFileSync(
    path.join(__dirname, 'ecosystem.config.cjs'),
    path.join(appDir, 'ecosystem.config.cjs')
  );
  if (envLocal !== null) fs.writeFileSync(path.join(appDir, '.env.local'), envLocal);
  if (registered) fs.writeFileSync(path.join(fakeDir, 'registered'), '');
  const instance = {
    name: 'example-mcp',
    pm2_env: { status: 'online', version: VERSION, node_version: 'v24.1.0' },
  };
  fs.writeFileSync(path.join(fakeDir, 'jlist.json'), JSON.stringify(jlist ?? [instance, instance]));
  writeExecutable(path.join(binDir, 'pm2'), PM2_STUB);
  writeExecutable(path.join(binDir, 'curl'), CURL_STUB);
  writeExecutable(path.join(binDir, 'sleep'), SLEEP_STUB);
  return { root, appDir, fakeDir, binDir };
}

function run(ctx, overrides = {}) {
  const env = {
    PATH: `${ctx.binDir}${path.delimiter}${process.env.PATH}`,
    FAKE_DIR: ctx.fakeDir,
    DEPLOY_ENV: 'staging',
    APP_DIR: ctx.appDir,
    EXPECTED_VERSION: VERSION,
    MCP_PM2_NAME: 'example-mcp',
    MCP_PORT: '4100',
    MCP_INSTANCES: '2',
    HEALTH_URL: 'http://127.0.0.1:4100/health/ready',
    PM2_BIN: path.join(ctx.binDir, 'pm2'),
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const result = spawnSync('bash', [SCRIPT], { env, encoding: 'utf8' });
  const calls = fs.existsSync(path.join(ctx.fakeDir, 'pm2.calls'))
    ? fs.readFileSync(path.join(ctx.fakeDir, 'pm2.calls'), 'utf8').trim().split('\n')
    : [];
  fs.rmSync(ctx.root, { recursive: true, force: true });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function assertOnlyDeployLines({ stdout, stderr }) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.ok(lines.length > 0, 'escribe al menos una línea');
  for (const line of lines) assert.match(line, /^DEPLOY: /);
  assert.ok(
    !stdout.includes(NOISE) && !stderr.includes(NOISE),
    'nunca deja pasar la salida de pm2'
  );
  for (const value of ['example-mcp', '4100', '127.0.0.1', 'mcp-remote-deploy-']) {
    assert.ok(!stdout.includes(value), `no escribe el valor ${value}`);
  }
}

test('recarga el proceso, guarda, pasa la sonda y la puerta de versión, y solo escribe DEPLOY', () => {
  const result = run(setup());
  assert.equal(result.code, 0, result.stdout);
  assertOnlyDeployLines(result);
  assert.match(result.stdout, /reload ok/);
  assert.match(result.stdout, /readiness ok/);
  assert.match(result.stdout, /versión ok/);
  assert.ok(result.calls.some((c) => c.startsWith('reload ecosystem.config.cjs --update-env')));
  assert.ok(result.calls.includes('save'));
  assert.ok(!result.calls.some((c) => c.startsWith('update')), 'nunca pm2 update');
});

test('un proceso que aún no existe se arranca con start', () => {
  const instance = {
    name: 'example-mcp',
    pm2_env: { status: 'online', version: VERSION, node_version: 'v22.9.0' },
  };
  const result = run(setup({ registered: false, jlist: [instance] }), { MCP_INSTANCES: undefined });
  assert.equal(result.code, 0, result.stdout);
  assert.ok(result.calls.includes('start ecosystem.config.cjs'));
  assert.ok(!result.calls.some((c) => c.startsWith('reload')));
});

test('reintenta un reload rechazado por el daemon', () => {
  const result = run(setup(), { FAKE_RELOAD_REJECTIONS: '2' });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.calls.filter((c) => c.startsWith('reload')).length, 3);
  assertOnlyDeployLines(result);
});

test('falla si el daemon nunca acepta el reload', () => {
  const result = run(setup(), { FAKE_RELOAD_REJECTIONS: '99' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fallo: pm2 no aceptó el reload/);
  assert.ok(!result.calls.includes('save'));
});

test('falla sin una variable obligatoria y la nombra', () => {
  const result = run(setup(), { HEALTH_URL: '' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^DEPLOY: fallo: falta la variable HEALTH_URL$/m);
  assert.deepEqual(result.calls, []);
});

test('falla si .env.local falta o es de otro entorno', () => {
  assert.match(run(setup({ envLocal: null })).stdout, /fallo: falta \.env\.local/);
  const other = run(setup({ envLocal: 'APP_ENVIRONMENT=production\n' }));
  assert.equal(other.code, 1);
  assert.match(other.stdout, /fallo: \.env\.local no tiene APP_ENVIRONMENT=staging/);
});

test('falla si la versión subida no es la esperada', () => {
  const result = run(setup(), { EXPECTED_VERSION: '0.0.1' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fallo: la versión subida no es la esperada/);
});

test('con desfase entre daemon y CLI de PM2 falla sin recargar ni actualizar', () => {
  const result = run(setup(), { FAKE_PM2_LIST: 'In-memory PM2 version is out-of-date' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fallo: el daemon de PM2 y el CLI tienen versiones distintas/);
  assert.ok(!result.calls.some((c) => c.startsWith('reload') || c.startsWith('update')));
});

test('falla si la sonda de readiness no responde', () => {
  const result = run(setup(), { FAKE_CURL_EXIT: '22' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fallo: la sonda de readiness/);
  assertOnlyDeployLines(result);
});

test('la puerta de versión falla si una instancia sigue con la versión anterior', () => {
  const online = { status: 'online', version: VERSION, node_version: 'v24.1.0' };
  const jlist = [
    { name: 'example-mcp', pm2_env: online },
    { name: 'example-mcp', pm2_env: { ...online, version: '9.8.6' } },
  ];
  const result = run(setup({ jlist }));
  assert.equal(result.code, 1);
  assert.match(result.stdout, /fallo: alguna instancia sigue con otra versión/);
});

test('la puerta de versión falla si faltan instancias o el Node del daemon es antiguo', () => {
  const online = { status: 'online', version: VERSION, node_version: 'v24.1.0' };
  const missing = run(setup({ jlist: [{ name: 'example-mcp', pm2_env: online }] }));
  assert.match(missing.stdout, /fallo: faltan instancias/);
  const old = { ...online, node_version: 'v22.8.0' };
  const oldNode = run(setup({ jlist: [{ name: 'example-mcp', pm2_env: old }] }), {
    MCP_INSTANCES: '1',
  });
  assert.match(oldNode.stdout, /fallo: el daemon de PM2 usa un Node anterior a 22\.9/);
});

const hasFlock = spawnSync('bash', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;

test('con DEPLOY_LOCK_FILE recarga dentro del lock compartido', { skip: !hasFlock }, () => {
  const ctx = setup();
  const lockFile = path.join(ctx.fakeDir, 'deploy.lock');
  const result = run(ctx, { DEPLOY_LOCK_FILE: lockFile });
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /reload ok/);
});
