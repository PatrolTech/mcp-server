import type { FixedTextLanguage } from '@patroltech/agent-capabilities';

/**
 * Sin preferencia guardada, español (el idioma por defecto del producto). El `Accept-Language`
 * de la petición no sirve: lo pone el cliente MCP (un servidor de Anthropic u OpenAI), no el
 * usuario.
 */
export const DEFAULT_LANGUAGE: FixedTextLanguage = 'es';
export const DEFAULT_TIMEZONE = 'Europe/Madrid';

const SUPPORTED: readonly FixedTextLanguage[] = ['es', 'en', 'fr'];

/** Idioma de los textos fijos a partir de la preferencia del usuario (`en-US` → `en`). */
export function languageFrom(preference: string | null | undefined): FixedTextLanguage {
  const base = (preference ?? '').split(/[-_]/)[0].toLowerCase();
  return SUPPORTED.find((language) => language === base) ?? DEFAULT_LANGUAGE;
}

function isValidTimezone(candidate: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate });
    return true;
  } catch {
    return false;
  }
}

/** La primera zona IANA válida de las candidatas (en orden de preferencia), o la de Madrid. */
export function timezoneFrom(...candidates: (string | null | undefined)[]): string {
  return candidates.find((tz): tz is string => !!tz && isValidTimezone(tz)) ?? DEFAULT_TIMEZONE;
}
