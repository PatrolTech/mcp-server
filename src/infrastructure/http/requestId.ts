import { randomUUID } from 'node:crypto';
import type express from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Un id entrante solo se reutiliza si es un token corto y seguro (sin espacios ni control). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** El id de la petición: el entrante si es seguro, o uno nuevo. */
export function requestIdFor(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

/** El id que `requestIdMiddleware` asignó a esta petición. */
export function requestIdOf(res: express.Response): string {
  const id: unknown = res.locals.requestId;
  return typeof id === 'string' ? id : randomUUID();
}

/** Asigna el id de la petición (y lo devuelve en la respuesta) antes de cualquier otra puerta. */
export function requestIdMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    const id = requestIdFor(req.headers['x-request-id']);
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
