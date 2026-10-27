#!/usr/bin/env bash
# Se ejecuta EN el servidor, por SSH (`bash -s`), después de subir el bundle, package.json y
# ecosystem.config.cjs al directorio de la aplicación. Recarga el proceso de PM2 sin corte y
# comprueba que todas sus instancias sirven la versión nueva.
#
# No lleva ningún dato del servidor: todo llega por variables de entorno (ver «Inputs»). Tampoco
# imprime nada del servidor: la salida de pm2, curl y node se descarta, y solo se escriben líneas
# `DEPLOY: …` con textos fijos, que son las únicas que el workflow deja pasar a su log.
#
# Inputs (obligatorias):
#   DEPLOY_ENV           production | staging; debe coincidir con APP_ENVIRONMENT de .env.local
#   APP_DIR              directorio de la aplicación (bundle, .env.local, logs/)
#   EXPECTED_VERSION     versión de package.json que se acaba de subir
#   MCP_PM2_NAME         nombre del proceso en PM2
#   MCP_PORT             puerto local del proceso
#   HEALTH_URL           URL local de /health/ready (p. ej. http://127.0.0.1:<puerto>/health/ready)
# Inputs (opcionales):
#   MCP_INSTANCES        número de instancias (1 por defecto)
#   MCP_SERVICE_NAME     nombre de servicio en los logs (el del proceso por defecto)
#   DEPLOY_HOME          HOME con el que se habla con el daemon de PM2 (define su PM2_HOME)
#   NODE_BIN_DIR         directorio del Node con el que se ejecutan pm2 y las comprobaciones
#   PM2_BIN              ruta del CLI de pm2 (por defecto, el del PATH)
#   DEPLOY_LOCK_FILE     fichero de lock (flock) compartido con los despliegues de otras apps
#                        del mismo daemon de PM2: con él, dos reloads nunca se cruzan
#   FILE_OWNER           `usuario:grupo` que debe tener APP_DIR tras el despliegue
#
# Reglas: nunca `pm2 update` (reinicia el daemon y todas las apps que gestiona); si el daemon y el
# CLI no tienen la misma versión, se falla y lo decide una persona.
set -uo pipefail

say() { printf 'DEPLOY: %s\n' "$*"; }
fail() {
  say "fallo: $*"
  exit 1
}

for name in DEPLOY_ENV APP_DIR EXPECTED_VERSION MCP_PM2_NAME MCP_PORT HEALTH_URL; do
  [ -n "${!name:-}" ] || fail "falta la variable $name"
done
case "$DEPLOY_ENV" in
  production | staging) ;;
  *) fail "DEPLOY_ENV debe ser production o staging" ;;
esac

if [ -n "${NODE_BIN_DIR:-}" ]; then
  [ -x "$NODE_BIN_DIR/node" ] || fail "NODE_BIN_DIR no contiene un ejecutable node"
  export PATH="$NODE_BIN_DIR:$PATH"
fi
if [ -n "${DEPLOY_HOME:-}" ]; then
  export HOME="$DEPLOY_HOME"
fi
command -v node > /dev/null 2>&1 || fail "no hay node en el PATH"

if [ -n "${PM2_BIN:-}" ]; then
  [ -x "$PM2_BIN" ] || fail "PM2_BIN no es un ejecutable"
  PM2="$PM2_BIN"
else
  PM2="$(command -v pm2 || true)"
  [ -n "$PM2" ] || fail "no encuentro pm2 en el PATH"
fi
pm2q() { "$PM2" "$@" > /dev/null 2>&1; }

cd "$APP_DIR" 2> /dev/null || fail "APP_DIR no existe"
for file in server.mjs package.json ecosystem.config.cjs; do
  [ -s "$file" ] || fail "no se ha subido $file"
done
UPLOADED_VERSION="$(node -p "require('./package.json').version" 2> /dev/null)" ||
  fail "package.json no se puede leer"
[ "$UPLOADED_VERSION" = "$EXPECTED_VERSION" ] || fail "la versión subida no es la esperada"

# El .env.local se crea una vez a mano (secretos fuera de git y del rsync). Sin él el servidor no
# arranca: mejor un error claro que un bucle de reinicios.
[ -s .env.local ] || fail "falta .env.local en APP_DIR: hay que provisionar el entorno"
grep -Eq "^APP_ENVIRONMENT[[:space:]]*=[[:space:]]*${DEPLOY_ENV}[[:space:]]*$" .env.local ||
  fail ".env.local no tiene APP_ENVIRONMENT=${DEPLOY_ENV}"

mkdir -p logs || fail "no se puede crear logs/"
if [ -n "${FILE_OWNER:-}" ]; then
  # Nunca falla el despliegue: sin permiso, se queda como estaba.
  chown -R "$FILE_OWNER" "$APP_DIR" > /dev/null 2>&1 || say "aviso: chown omitido"
  chmod 755 "$APP_DIR" > /dev/null 2>&1 || say "aviso: chmod omitido"
fi

export PM2_APP_DIR="$APP_DIR" MCP_APP_ENVIRONMENT="$DEPLOY_ENV"
export MCP_PM2_NAME MCP_PORT MCP_INSTANCES="${MCP_INSTANCES:-}" MCP_SERVICE_NAME="${MCP_SERVICE_NAME:-}"
EXPECTED_INSTANCES="$(node -p "require('./ecosystem.config.cjs').apps[0].instances" 2> /dev/null)" ||
  fail "ecosystem.config.cjs no se puede evaluar con estas variables"

# Desfase entre el daemon de PM2 y el CLI: NO se resincroniza aquí. `pm2 update` reiniciaría el
# daemon y todas sus apps; lo decide una persona en una ventana de mantenimiento.
if "$PM2" list 2>&1 | grep -qi "out-of-date\|In-memory PM2 version"; then
  fail "el daemon de PM2 y el CLI tienen versiones distintas (no se hace pm2 update)"
fi

# Lock compartido con los despliegues de otras apps del mismo daemon: el daemon solo admite un
# reload a la vez y rechaza el resto con «Reload already in progress».
if [ -n "${DEPLOY_LOCK_FILE:-}" ]; then
  command -v flock > /dev/null 2>&1 || fail "DEPLOY_LOCK_FILE necesita flock"
  # Se comprueba antes: un `exec` con una redirección que falla cierra el shell sin mensaje.
  (: >> "$DEPLOY_LOCK_FILE") 2> /dev/null || fail "no se puede abrir DEPLOY_LOCK_FILE"
  exec 9>> "$DEPLOY_LOCK_FILE"
  flock -w 900 9 || fail "no se obtuvo el lock de despliegue en 15 minutos"
fi

if pm2q describe "$MCP_PM2_NAME"; then
  # Aun con el lock, otro proceso puede tener el reload del daemon: se reintenta y, si nunca
  # entra, se falla en voz alta (el código nuevo NO estaría activo).
  RELOADED=0
  for attempt in $(seq 1 10); do
    if OUT="$("$PM2" reload ecosystem.config.cjs --update-env 2>&1)" &&
      ! grep -qi "\[PM2\]\[ERROR\]" <<< "$OUT"; then
      RELOADED=1
      break
    fi
    say "reload rechazado (intento $attempt/10); se reintenta en 20 s"
    sleep 20
  done
  unset OUT
  [ "$RELOADED" = 1 ] || fail "pm2 no aceptó el reload en 10 intentos: el código nuevo no está activo"
else
  pm2q start ecosystem.config.cjs || fail "pm2 no pudo arrancar el proceso"
fi
pm2q save || fail "pm2 save"
if [ -n "${DEPLOY_LOCK_FILE:-}" ]; then
  flock -u 9
fi
say "reload ok"

# Sonda profunda: /health/ready comprueba el JWKS de la API y Redis. Un 503 suele ser la API caída
# u OAuth sin configurar en el backend, no este servicio.
READY=0
for _ in $(seq 1 10); do
  if curl -sf -o /dev/null --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 3
done
[ "$READY" = 1 ] || fail "la sonda de readiness no respondió 200 tras el reload"
say "readiness ok"

# Puerta de versión: la sonda no prueba que el código nuevo esté activo (puede contestar el viejo).
# Cada instancia debe estar `online`, con la versión de package.json y con Node ≥ 22.9: en modo
# cluster los workers usan el Node del DAEMON, y `--env-file-if-exists` necesita esa versión.
GATE_CHECK='
  const { PM2_NAME: name, EXPECTED_VERSION: version, EXPECTED_INSTANCES: instances } = process.env;
  let list;
  try { list = JSON.parse(require("fs").readFileSync(0, "utf8")); } catch { process.exit(2); }
  const atLeast = (v, major, minor) => {
    const [a, b] = String(v).replace(/^v/, "").split(".").map(Number);
    return a > major || (a === major && b >= minor);
  };
  const procs = list.filter((p) => p.name === name).map((p) => p.pm2_env || {});
  if (procs.length < Number(instances)) process.exit(3);
  if (procs.some((p) => p.status !== "online")) process.exit(4);
  if (procs.some((p) => p.version !== version)) process.exit(5);
  if (procs.some((p) => !atLeast(p.node_version, 22, 9))) process.exit(6);
'
GATE=1
for _ in $(seq 1 20); do
  "$PM2" jlist 2> /dev/null |
    PM2_NAME="$MCP_PM2_NAME" EXPECTED_INSTANCES="$EXPECTED_INSTANCES" node -e "$GATE_CHECK" \
      > /dev/null 2>&1
  GATE=$?
  [ "$GATE" = 0 ] && break
  sleep 15
done
case "$GATE" in
  0) say "versión ok: todas las instancias online con la versión nueva" ;;
  3) fail "faltan instancias registradas en pm2" ;;
  4) fail "alguna instancia no está online (¿bucle de reinicios?)" ;;
  5) fail "alguna instancia sigue con otra versión: el reload no entró" ;;
  6) fail "el daemon de PM2 usa un Node anterior a 22.9: .env.local no se cargaría" ;;
  *) fail "no se pudo leer el estado de pm2" ;;
esac
