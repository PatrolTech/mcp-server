import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';
import express from 'express';
import type { McpServerConfig } from '../../config.js';

export const SUPPORTED_SCOPES = ['read', 'write'] as const;

const WELL_KNOWN_ROOT = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

type AuthUrls = Pick<McpServerConfig, 'publicUrl' | 'oauthIssuer'>;

/** Documento RFC 9728 de este recurso. */
export function buildProtectedResourceMetadata(config: AuthUrls): ProtectedResourceMetadata {
  return {
    resource: config.publicUrl,
    authorization_servers: [config.oauthIssuer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/** Path del endpoint MCP, tomado de la URL pública (`/mcp`): ruta montada y audience coinciden. */
export function mcpEndpointPath(config: Pick<McpServerConfig, 'publicUrl'>): string {
  return new URL(config.publicUrl).pathname;
}

/** URL del documento con el path del recurso: `${origen}/.well-known/oauth-protected-resource/mcp`. */
export function protectedResourceMetadataUrl(config: Pick<McpServerConfig, 'publicUrl'>): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(config.publicUrl));
}

/** Rutas del documento: la que lleva el path del recurso y la raíz. */
function metadataPaths(config: Pick<McpServerConfig, 'publicUrl'>): string[] {
  const withResourcePath = new URL(protectedResourceMetadataUrl(config)).pathname;
  return [...new Set([withResourcePath, WELL_KNOWN_ROOT])];
}

/** Sirve el documento; público, cacheable y solo GET/HEAD, con preflight CORS. */
export function createProtectedResourceMetadataRouter(config: AuthUrls): express.Router {
  const metadata = buildProtectedResourceMetadata(config);
  const router = express.Router();

  const allowCrossOrigin: express.RequestHandler = (_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    next();
  };

  const preflight: express.RequestHandler = (req, res) => {
    const requestedHeaders = req.get('Access-Control-Request-Headers');
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    if (requestedHeaders) {
      res.set('Access-Control-Allow-Headers', requestedHeaders);
    }
    res.vary('Access-Control-Request-Headers').status(204).end();
  };

  const serve: express.RequestHandler = (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').status(200).json(metadata);
  };

  const methodNotAllowed: express.RequestHandler = (_req, res) => {
    res.set('Allow', 'GET, HEAD, OPTIONS').status(405).json({ error: 'method_not_allowed' });
  };

  for (const path of metadataPaths(config)) {
    router.route(path).all(allowCrossOrigin).options(preflight).get(serve).all(methodNotAllowed);
  }

  return router;
}
