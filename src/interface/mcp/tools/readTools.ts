import type { McpServer } from '@modelcontextprotocol/server';
import {
  argsFromEnglish,
  englishFields,
  englishInputSchema,
  type CatalogRead,
} from '@patroltech/agent-capabilities';
import {
  READ_ONLY_ANNOTATIONS,
  READ_RATE_LIMIT,
  registerCapabilityTool,
  type ToolBinding,
} from '../registerCapabilityTool.js';
import { describeCapability, organizationInput } from './toolDescriptions.js';
import { toolNameFor } from './toolNaming.js';
import { isRefusal } from '../../../application/ToolOutcome.js';

/**
 * Una herramienta MCP por lectura del catálogo `mcp`: nombre del id, título y descripción en
 * inglés del catálogo, sus parámetros (en inglés) más `organization`, y la capacidad ejecutada
 * con el contexto de sesión del usuario; los campos de sus datos salen en inglés.
 */
export function registerReadTools(
  server: McpServer,
  binding: ToolBinding,
  reads: readonly CatalogRead[]
): void {
  for (const { meta, read } of reads) {
    registerCapabilityTool(
      server,
      binding,
      {
        name: toolNameFor(meta.id),
        title: meta.title.en,
        description: describeCapability(meta),
        inputSchema: {
          ...englishInputSchema(meta.id, read.params),
          organization: organizationInput,
        },
        annotations: READ_ONLY_ANNOTATIONS,
        operation: 'read',
        rateLimit: READ_RATE_LIMIT,
      },
      async (args, call) => {
        const { organization, ...params } = args;
        const context = await call.capabilityContext(
          typeof organization === 'string' ? organization : undefined
        );
        if (isRefusal(context)) return context;
        const result = await read.call(context, argsFromEnglish(read.params, params));
        return result.ok ? { ...result, data: englishFields(result.data) } : result;
      }
    );
  }
}
