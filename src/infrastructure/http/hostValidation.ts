import { validateHostHeader, validateOriginHeader } from '@modelcontextprotocol/server';
import type express from 'express';

/** Nombres de loopback: el proxy inverso puede pasar la petición sin reenviar el Host público. */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Hosts admitidos en `/mcp`: el del recurso público o uno de loopback. Un navegador engañado por
 * DNS rebinding manda el Host del dominio atacante, nunca estos, así que la protección sigue
 * activa aunque el proceso escuche en 127.0.0.1 detrás de un proxy inverso.
 */
export function allowedMcpHostnames(publicUrl: string): string[] {
  return [...new Set([new URL(publicUrl).hostname, ...LOOPBACK_HOSTNAMES])];
}

function forbidden(res: express.Response, message: string): void {
  res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export interface McpHostPolicy {
  publicUrl: string;
}

/**
 * Validación del Host (DNS rebinding) y del `Origin` (el transporte MCP lo exige) con las
 * funciones del SDK, como sus middlewares de `@modelcontextprotocol/express` pero tipada con el
 * Express de este paquete. Sin `Origin` se pasa: los clientes MCP remotos (Claude, ChatGPT)
 * llaman desde sus servidores y no lo envían. Con uno (también `null`), el mismo 403 JSON-RPC que
 * el SDK: `/mcp` no emite cabeceras CORS ni atiende el preflight antes de la autenticación, así que
 * un navegador nunca podría usarlo aunque se admitiera su Origin.
 */
export function mcpHostValidation(policy: McpHostPolicy): express.RequestHandler {
  const hosts = allowedMcpHostnames(policy.publicUrl);
  return (req, res, next) => {
    const host = validateHostHeader(req.headers.host, hosts);
    if (!host.ok) {
      forbidden(res, host.message);
      return;
    }
    const origin = validateOriginHeader(req.headers.origin, []);
    if (!origin.ok) {
      forbidden(res, origin.message);
      return;
    }
    next();
  };
}
