import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@patroltech/mcp-server';

/**
 * La versión sale de `package.json`, la única fuente. Se busca hacia arriba desde este módulo, así
 * que vale igual en `src/` (tests y `npm run dev`), en `dist/`, en `dist/bundle/` y en el destino
 * del despliegue, donde `package.json` va junto al bundle. Se exige el nombre del paquete para no
 * leer por error el `package.json` de otro proyecto que lo contenga.
 */
function readPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // Sin package.json legible en este nivel: se sigue subiendo.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`${PACKAGE_NAME}: package.json not found next to or above ${dir}`);
    }
    dir = parent;
  }
}

export const APP_VERSION = { version: readPackageVersion() };
