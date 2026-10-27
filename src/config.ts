import { z } from 'zod';
import { APP_VERSION } from './version.js';

export type Environment = 'production' | 'staging' | 'development' | 'test';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface McpServerConfig {
  /** Interfaz en la que escucha el proceso (HOST); por defecto solo loopback, detrás de un proxy. */
  host: string;
  /** Puerto en el que escucha el proceso (el proxy inverso le pasa las peticiones). */
  port: number;
  /** URL pública exacta del recurso MCP (audience de los tokens), sin barra final. */
  publicUrl: string;
  /** Origen de la API de PatrolTech, sin barra final y sin `/api`. */
  apiBaseUrl: string;
  /** `iss` esperado en los access tokens. */
  oauthIssuer: string;
  /** JWKS con el que se verifican los access tokens. */
  jwksUrl: string;
  dashboardUrl: string;
  appBaseUrl: string;
  redisUrl?: string;
  /** Prefijo de claves en el Redis compartido: REDIS_NAMESPACE, luego APP_ENVIRONMENT. */
  redisNamespace: string;
  environment: Environment;
  logLevel: LogLevel;
  /** Nombre del servicio en cada línea de log (`service`), con el que se filtran y alertan. */
  serviceName: string;
  version: string;
  /**
   * Token de verificación del dominio que pide OpenAI para publicar la app en el directorio de
   * ChatGPT (`/.well-known/openai-apps-challenge`); sin él, esa ruta responde 404.
   */
  openAiAppsChallenge?: string;
}

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

const absoluteUrl = z.url({ protocol: /^https?$/ }).transform(trimTrailingSlashes);

/** Una dirección o nombre en el que escuchar: IPv4, IPv6 sin corchetes o un hostname suelto. */
const LISTEN_HOST =
  /^([0-9a-f:.]+|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/i;

/** Un nombre de servicio para los logs: letras, números, `.`, `_` y `-`. */
const SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** ASCII imprimible sin espacios: el token se sirve tal cual como `text/plain`. */
const PRINTABLE_ASCII_WITHOUT_WHITESPACE = /^[\x21-\x7E]+$/;

const envSchema = z
  .object({
    HOST: z
      .string()
      .regex(LISTEN_HOST, 'must be an address or hostname to listen on (no scheme or port)')
      .default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3110),
    MCP_PUBLIC_URL: absoluteUrl,
    API_BASE_URL: absoluteUrl,
    // Sin transformar: el issuer debe coincidir byte a byte con el `iss` de los tokens.
    OAUTH_ISSUER: z.url({ protocol: /^https?$/ }),
    OAUTH_JWKS_URL: z.url({ protocol: /^https?$/ }).optional(),
    DASHBOARD_URL: absoluteUrl,
    APP_BASE_URL: absoluteUrl,
    REDIS_URL: z.string().min(1).optional(),
    REDIS_NAMESPACE: z.string().min(1).optional(),
    APP_ENVIRONMENT: z.enum(['production', 'staging', 'development', 'test']),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    SERVICE_NAME: z
      .string()
      .max(100)
      .regex(SERVICE_NAME, 'must be letters, digits, dots, underscores or dashes')
      .default('mcp-server'),
    OPENAI_APPS_CHALLENGE: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(PRINTABLE_ASCII_WITHOUT_WHITESPACE, 'must be printable ASCII without whitespace')
      .optional(),
  })
  // La exclusión de las propuestas tiene que valer para todos los workers: en los entornos
  // desplegados no hay respaldo en memoria.
  .refine((vars) => !['production', 'staging'].includes(vars.APP_ENVIRONMENT) || !!vars.REDIS_URL, {
    path: ['REDIS_URL'],
    message: 'required when APP_ENVIRONMENT is production or staging',
  });

/** Las variables vacías (`FOO=`) cuentan como ausentes. */
function withoutEmptyValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''
  );
  return Object.fromEntries(entries);
}

/**
 * Lee y valida la configuración del entorno. Falla de una vez con un Error cuyo mensaje
 * lista cada variable inválida o ausente, para no arrancar a medias.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const parsed = envSchema.safeParse(withoutEmptyValues(env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `- ${issue.path.join('.') || '(env)'}: ${issue.message}`
    );
    throw new Error(`Invalid MCP server configuration:\n${problems.join('\n')}`);
  }

  const vars = parsed.data;
  return {
    host: vars.HOST,
    port: vars.PORT,
    publicUrl: vars.MCP_PUBLIC_URL,
    apiBaseUrl: vars.API_BASE_URL,
    oauthIssuer: vars.OAUTH_ISSUER,
    jwksUrl: vars.OAUTH_JWKS_URL ?? `${vars.API_BASE_URL}/oauth/jwks.json`,
    dashboardUrl: vars.DASHBOARD_URL,
    appBaseUrl: vars.APP_BASE_URL,
    redisUrl: vars.REDIS_URL,
    redisNamespace: vars.REDIS_NAMESPACE ?? vars.APP_ENVIRONMENT,
    environment: vars.APP_ENVIRONMENT,
    logLevel: vars.LOG_LEVEL,
    serviceName: vars.SERVICE_NAME,
    version: APP_VERSION.version,
    openAiAppsChallenge: vars.OPENAI_APPS_CHALLENGE,
  };
}
