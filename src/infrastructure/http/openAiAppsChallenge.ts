import express from 'express';

export const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge';

/**
 * Sirve el token con el que OpenAI verifica el dominio antes de publicar la app en el directorio
 * de ChatGPT: texto plano, exactamente el token, sin autenticación ni caché. Como `/health` y el
 * PRM, va antes de la puerta bearer y sin validar Host ni Origin (lo pide el rastreador de
 * OpenAI, no un cliente MCP). Sin token configurado no se monta nada y la ruta cae en el 404
 * común de la app.
 */
export function createOpenAiAppsChallengeRouter(token: string | undefined): express.Router {
  const router = express.Router();
  if (token === undefined) {
    return router;
  }

  router.get(OPENAI_APPS_CHALLENGE_PATH, (_req, res) => {
    res.status(200).set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(token);
  });

  return router;
}
