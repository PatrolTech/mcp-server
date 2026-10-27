// Empaqueta el servidor en un único fichero ESM autocontenido, con todas sus dependencias:
// `dist/bundle/server.mjs` + su sourcemap. Se despliega tal cual, junto a `package.json` (de donde
// sale la versión), sin `npm install` ni node_modules en el destino. Uso: `npm run bundle`.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Algunas dependencias CJS llaman a `require(...)` de módulos nativos de Node; en un bundle ESM
// no existe, así que se declara aquí con createRequire.
const requireShim =
  "import { createRequire as __createRequire } from 'node:module'; " +
  'const require = __createRequire(import.meta.url);';

await build({
  absWorkingDir: root,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/bundle/server.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  legalComments: 'none',
  banner: { js: requireShim },
  logLevel: 'info',
});
