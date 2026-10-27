/**
 * Configuración de PM2 del conector MCP: un proceso por entorno, en modo cluster.
 *
 * No lleva ningún dato del servidor: nombre, puerto, entorno e instancias llegan por variables de
 * entorno al ejecutar `pm2 start|reload ecosystem.config.cjs` (las pone `deploy/remote-deploy.sh`
 * desde los secretos del entorno de GitHub). Sin las obligatorias, falla en vez de arrancar con
 * valores por defecto:
 *
 *   MCP_PM2_NAME         nombre del proceso en PM2 (obligatoria)
 *   MCP_PORT             puerto local en el que escucha (obligatoria)
 *   MCP_APP_ENVIRONMENT  production | staging (obligatoria; debe coincidir con `.env.local`)
 *   MCP_INSTANCES        número de instancias (opcional, 1 por defecto)
 *   MCP_SERVICE_NAME     nombre de servicio en los logs (opcional, el de MCP_PM2_NAME por defecto)
 *   PM2_APP_DIR          directorio de la aplicación (opcional, el actual por defecto)
 *
 * El resto de la configuración del servidor (MCP_PUBLIC_URL, API_BASE_URL, REDIS_URL…) la aporta
 * `<PM2_APP_DIR>/.env.local` con `--env-file-if-exists`. Lo que fija este fichero (PORT,
 * APP_ENVIRONMENT, NODE_ENV, SERVICE_NAME, DD_*) tiene prioridad, porque Node no pisa variables ya
 * definidas.
 *
 * Node: en modo cluster PM2 arranca los workers con el Node de SU daemon (un `interpreter` no
 * cuenta), y `--env-file-if-exists` necesita Node ≥ 22.9. El deploy lo comprueba en cada instancia.
 *
 * Uso: `pm2 start ecosystem.config.cjs` o `pm2 reload ecosystem.config.cjs --update-env` (sin
 * corte). Nunca `pm2 update`: reinicia el daemon y, con él, todas las apps que gestiona.
 */

const path = require('path');

const APP_DIR = process.env.PM2_APP_DIR || process.cwd();
const LOG_DIR = path.join(APP_DIR, 'logs');
const ENV_FILE = path.join(APP_DIR, '.env.local');
const ENVIRONMENTS = ['production', 'staging'];

/** Una variable obligatoria, sin espacios alrededor. */
function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new Error(`ecosystem.config.cjs: ${name} is required`);
  }
  return value;
}

/** Un entero positivo; `fallback` si falta, y error si viene pero no lo es. */
function positiveInteger(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (!raw && fallback !== undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ecosystem.config.cjs: ${name} must be a positive integer`);
  }
  return value;
}

/** package.json es lo que copia el deploy y lo que comprueba la puerta de versión posterior. */
function readVersion() {
  try {
    return require(path.join(APP_DIR, 'package.json')).version || undefined;
  } catch {
    return undefined;
  }
}

const NAME = required('MCP_PM2_NAME');
const PORT = positiveInteger('MCP_PORT');
if (PORT > 65535) {
  throw new Error('ecosystem.config.cjs: MCP_PORT must be a port number');
}
const APP_ENV = required('MCP_APP_ENVIRONMENT');
if (!ENVIRONMENTS.includes(APP_ENV)) {
  throw new Error(`ecosystem.config.cjs: MCP_APP_ENVIRONMENT must be ${ENVIRONMENTS.join(' or ')}`);
}
const INSTANCES = positiveInteger('MCP_INSTANCES', 1);
const SERVICE_NAME = (process.env.MCP_SERVICE_NAME || '').trim() || NAME;

// max_memory_restart (disparador de RSS de pm2) y --max-old-space-size (tope del heap de V8) van
// juntos: si solo se baja el primero, V8 se queda sin memoria antes de que pm2 recicle.
const MEMORY_LIMIT_MB = 256;

module.exports = {
  apps: [
    {
      name: NAME,
      script: 'server.mjs',
      cwd: APP_DIR,
      instances: INSTANCES,
      exec_mode: 'cluster',
      max_memory_restart: `${MEMORY_LIMIT_MB}M`,
      node_args: [
        `--max-old-space-size=${MEMORY_LIMIT_MB}`,
        '--enable-source-maps',
        `--env-file-if-exists=${ENV_FILE}`,
      ].join(' '),
      env: {
        NODE_ENV: 'production',
        PORT,
        APP_ENVIRONMENT: APP_ENV,
        SERVICE_NAME,
        // El logger JSON del servidor ya escribe service/env/version en cada línea; DD_* se fija
        // igualmente para que cualquier instrumentación automática segmente igual.
        DD_SERVICE: SERVICE_NAME,
        DD_ENV: APP_ENV,
        DD_VERSION: readVersion(),
      },
      error_file: path.join(LOG_DIR, 'mcp-error.log'),
      out_file: path.join(LOG_DIR, 'mcp-out.log'),
      // Sin `log_date_format`: cada línea ya es JSON con `timestamp`, y un prefijo de fecha impide
      // que un colector de logs la parsee como JSON.
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      // El servidor cierra con gracia en 55 s (SHUTDOWN_GRACE_MS): deja terminar una confirmación
      // de 10 cambios con el backend lento (cada llamada hasta 10 s). pm2 espera un poco más.
      kill_timeout: 60000,
      listen_timeout: 15000,
      shutdown_with_message: false,
      watch: false,
    },
  ],
};
