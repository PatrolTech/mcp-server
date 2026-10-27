import { createHash } from 'node:crypto';
import type {
  SessionDirectory,
  UserPreferences,
} from '../../application/ports/SessionDirectory.js';

export interface CachingSessionDirectoryOptions {
  /** Cuánto vale lo leído. Por defecto, 60 s. */
  ttlMs?: number;
  /** Tope de sesiones en caché (LRU). Por defecto, 5000. */
  maxEntries?: number;
  /** Reloj en ms (inyectable en tests). */
  now?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 5000;

interface Entry {
  organizationNames?: { value: ReadonlyMap<string, string>; until: number };
  preferences?: { value: UserPreferences; until: number };
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * `SessionDirectory` que recuerda, por sesión de agente (hash del JWT, nunca el JWT) y durante
 * poco tiempo, los nombres de las organizaciones y las preferencias: sin ella cada llamada a una
 * herramienta (una petición HTTP) haría dos GET más. Solo es una optimización por proceso (con
 * varios workers cada uno tiene la suya): un cambio de nombre o de idioma se ve como mucho al
 * minuto. Los fallos no se recuerdan.
 */
export class CachingSessionDirectory implements SessionDirectory {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Map conserva el orden de inserción: la primera clave es la menos reciente. */
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly inner: SessionDirectory,
    options: CachingSessionDirectoryOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  async organizationNames(token: string): Promise<ReadonlyMap<string, string>> {
    const entry = this.entryFor(token);
    const cached = entry.organizationNames;
    if (cached && cached.until > this.now()) return cached.value;
    const value = await this.inner.organizationNames(token);
    entry.organizationNames = { value, until: this.now() + this.ttlMs };
    return value;
  }

  async preferences(token: string): Promise<UserPreferences> {
    const entry = this.entryFor(token);
    const cached = entry.preferences;
    if (cached && cached.until > this.now()) return cached.value;
    const value = await this.inner.preferences(token);
    entry.preferences = { value, until: this.now() + this.ttlMs };
    return value;
  }

  /** La entrada de la sesión, marcada como la más reciente (y la más vieja fuera si no cabe). */
  private entryFor(token: string): Entry {
    const key = hashToken(token);
    const entry = this.entries.get(key) ?? {};
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return entry;
  }
}
