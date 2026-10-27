/**
 * Test de la configuración de PM2 (sin dependencias): `npm run test:deploy`.
 * Para cada caso crea un APP_DIR temporal con su `package.json`, fija las variables de entorno,
 * carga el fichero en limpio y comprueba nombre, puerto, instancias y límites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, 'ecosystem.config.cjs');
const VARIABLES = [
  'PM2_APP_DIR',
  'MCP_PM2_NAME',
  'MCP_PORT',
  'MCP_APP_ENVIRONMENT',
  'MCP_INSTANCES',
  'MCP_SERVICE_NAME',
];
const BASE = { MCP_PM2_NAME: 'example-mcp', MCP_PORT: '4100', MCP_APP_ENVIRONMENT: 'production' };

function load(env) {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ecosystem-'));
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const previous = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of VARIABLES) delete process.env[name];
  Object.assign(process.env, { PM2_APP_DIR: appDir }, env);
  delete require.cache[CONFIG_PATH];
  try {
    const { apps } = require(CONFIG_PATH);
    assert.equal(apps.length, 1, 'un único proceso por entorno');
    return { app: apps[0], appDir };
  } finally {
    for (const name of VARIABLES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    delete require.cache[CONFIG_PATH];
    fs.rmSync(appDir, { recursive: true, force: true });
  }
}

test('nombre, puerto y entorno salen de las variables; cluster de 1 instancia por defecto', () => {
  const { app } = load(BASE);
  assert.equal(app.name, 'example-mcp');
  assert.equal(app.exec_mode, 'cluster');
  assert.equal(app.instances, 1);
  assert.equal(app.env.PORT, 4100);
  assert.equal(app.env.APP_ENVIRONMENT, 'production');
  assert.equal(app.env.DD_ENV, 'production');
});

test('staging y número de instancias', () => {
  const { app } = load({ ...BASE, MCP_APP_ENVIRONMENT: 'staging', MCP_INSTANCES: '3' });
  assert.equal(app.env.APP_ENVIRONMENT, 'staging');
  assert.equal(app.env.DD_ENV, 'staging');
  assert.equal(app.instances, 3);
});

test('sin una variable obligatoria falla en vez de usar un valor por defecto', () => {
  for (const name of ['MCP_PM2_NAME', 'MCP_PORT', 'MCP_APP_ENVIRONMENT']) {
    const env = { ...BASE, [name]: '' };
    assert.throws(() => load(env), new RegExp(`${name} is required|${name} must be`));
  }
});

test('valores inválidos fallan: entorno desconocido, puerto o instancias que no son enteros', () => {
  assert.throws(() => load({ ...BASE, MCP_APP_ENVIRONMENT: 'development' }), /MCP_APP_ENVIRONMENT/);
  for (const bad of ['abc', '0', '-1', '1.5', '70000']) {
    assert.throws(() => load({ ...BASE, MCP_PORT: bad }), /MCP_PORT/);
  }
  for (const bad of ['abc', '0', '-1', '1.5']) {
    assert.throws(() => load({ ...BASE, MCP_INSTANCES: bad }), /MCP_INSTANCES/);
  }
});

test('el nombre de servicio de los logs: MCP_SERVICE_NAME o, si falta, el del proceso', () => {
  assert.equal(load(BASE).app.env.SERVICE_NAME, 'example-mcp');
  const { app } = load({ ...BASE, MCP_SERVICE_NAME: 'example-service' });
  assert.equal(app.env.SERVICE_NAME, 'example-service');
  assert.equal(app.env.DD_SERVICE, 'example-service');
});

test('las líneas de log salen como JSON puro, sin prefijo de fecha de PM2', () => {
  const { app } = load(BASE);
  assert.equal(app.log_date_format, undefined);
  // `time: true` es otra forma de poner el prefijo y `log_type: 'json'` envuelve cada línea.
  assert.equal(app.time, undefined);
  assert.equal(app.log_type, undefined);
});

test('límites de memoria coherentes, .env.local y logs en APP_DIR, versión de package.json', () => {
  const { app, appDir } = load(BASE);
  assert.equal(app.cwd, appDir);
  assert.equal(app.max_memory_restart, '256M');
  assert.match(app.node_args, /--max-old-space-size=256\b/);
  assert.match(app.node_args, /--enable-source-maps/);
  assert.ok(app.node_args.includes(`--env-file-if-exists=${path.join(appDir, '.env.local')}`));
  assert.equal(app.error_file, path.join(appDir, 'logs', 'mcp-error.log'));
  assert.equal(app.out_file, path.join(appDir, 'logs', 'mcp-out.log'));
  assert.equal(app.env.DD_VERSION, '9.8.7');
  assert.equal(app.env.NODE_ENV, 'production');
});

test('arranca el bundle desplegado; en cluster no fija `interpreter` (PM2 usa el Node del daemon)', () => {
  const { app } = load(BASE);
  assert.equal(app.script, 'server.mjs');
  // En modo cluster PM2 lo ignoraría: no se declara para no aparentar que elige el Node.
  assert.equal(app.interpreter, undefined);
});

test('pm2 espera a que termine una confirmación larga antes de matar el proceso', () => {
  // El servidor cierra con gracia en 55 s (SHUTDOWN_GRACE_MS, src/server.ts): una confirmación de
  // 10 cambios con el backend lento cabe; pm2 espera un poco más antes del SIGKILL.
  assert.equal(load(BASE).app.kill_timeout, 60000);
});
