import { Injectable, inject } from '@angular/core';
import { openDB, IDBPDatabase } from 'idb';
import { OpLog } from '../log';
import { SnackService } from '../snack/snack.service';
import { T } from '../../t.const';

// Database constants - must match PFAPI's storage
const DB_NAME = 'pf';
const DB_STORE_NAME = 'main';
const DB_VERSION = 1;
const CLIENT_ID_KEY = '__client_id_';

/**
 * Service for managing the sync client ID.
 *
 * Reads/writes directly to IndexedDB to preserve existing client IDs
 * and avoid dependency on PfapiService.
 *
 * Uses the same database name ('pf') and key ('__client_id_') as the
 * legacy MetaModelCtrl to ensure backward compatibility.
 */
@Injectable({
  providedIn: 'root',
})
export class ClientIdService {
  private _snackService = inject(SnackService, { optional: true });
  private _db: IDBPDatabase | null = null;
  private _cachedClientId: string | null = null;

  /**
   * Loads the client ID.
   *
   * Uses caching to avoid repeated IndexedDB reads. Rotation paths bypass or
   * refresh the cache when they need cross-context freshness.
   *
   * @returns The client ID, or null if not yet generated
   */
  async loadClientId(): Promise<string | null> {
    if (this._cachedClientId) {
      return this._cachedClientId;
    }

    const clientId = await this._readPersistedValidClientId({ warnOnInvalid: true });

    if (clientId) {
      this._cachedClientId = clientId;
      OpLog.normal('ClientIdService.loadClientId() loaded');
    }
    return clientId;
  }

  /**
   * Generates a new client ID and saves it.
   *
   * Format: {platform}_{4-char-base62}
   * Examples: "B_a7Kx", "E_m2Pq", "A_x9Yz"
   *
   * @returns The newly generated client ID
   */
  async generateNewClientId(): Promise<string> {
    const newClientId = this._generateClientId();

    const db = await this._getDb();
    await db.put(DB_STORE_NAME, newClientId, CLIENT_ID_KEY);

    this._cachedClientId = newClientId;
    OpLog.normal('ClientIdService.generateNewClientId() generated');
    return newClientId;
  }

  /**
   * Persists an existing client ID (e.g., from legacy migration).
   *
   * Validates the format before writing to prevent invalid IDs from
   * being stored. loadClientId() treats an invalid stored ID as missing
   * and returns null, causing the caller to regenerate a fresh clientId.
   */
  async persistClientId(clientId: string): Promise<void> {
    if (!this._isValidClientIdFormat(clientId)) {
      throw new Error(`Cannot persist invalid clientId: ${clientId}`);
    }
    const db = await this._getDb();
    await db.put(DB_STORE_NAME, clientId, CLIENT_ID_KEY);
    this._cachedClientId = clientId;
    OpLog.normal('ClientIdService.persistClientId() persisted');
  }

  /**
   * Returns the existing client ID, or generates and persists a new one if
   * none is stored or the stored value is invalid.
   *
   * This is the preferred entry point for callers that always need a valid ID.
   */
  async getOrGenerateClientId(): Promise<string> {
    return (await this.loadClientId()) ?? (await this.generateNewClientId());
  }

  /**
   * Clears the cached client ID.
   *
   * Used for testing or when the client ID storage needs to be re-read.
   */
  clearCache(): void {
    this._cachedClientId = null;
  }

  /**
   * Rotate the clientId for the duration of `fn`. Captures the prior id,
   * generates and persists a new one, runs `fn(newClientId)`. If `fn` throws,
   * the prior id is restored so the `pf` database stays consistent with any
   * caller-side state that didn't get updated.
   *
   * Edge case: if there was no prior clientId (wholly fresh device), the new
   * id is intentionally left in `pf` on failure — there is nothing to restore
   * to. If the restore itself throws, the original `fn` error is propagated
   * and the restore failure is logged at critical level for forensics.
   *
   * `logPrefix` is used to tag the critical-log entry on rollback failure so
   * forensics can attribute it to the caller (e.g. `'[CleanSlate]'`).
   */
  async withRotation<T>(
    logPrefix: string,
    fn: (newClientId: string) => Promise<T>,
  ): Promise<T> {
    const priorClientId = await this._readPersistedValidClientId();
    const newClientId = await this.generateNewClientId();
    try {
      return await fn(newClientId);
    } catch (e) {
      if (priorClientId) {
        try {
          await this._restorePriorClientIdIfCurrentMatches(priorClientId, newClientId);
        } catch (rollbackErr) {
          OpLog.critical(
            `${logPrefix} Failed to roll back clientId rotation after failure`,
            {
              hadPriorClientId: true,
              originalErrorName: this._errorName(e),
              rollbackErrorName: this._errorName(rollbackErr),
            },
          );
        }
      }
      throw e;
    }
  }

  /**
   * Returns true if the clientId matches a known valid format.
   * Old format: any string of length >= 10 (legacy IDs).
   * New format: {platform}_{4-char-base62} e.g. "B_a7Kx".
   */
  private _isValidClientIdFormat(clientId: string): boolean {
    return clientId.length >= 10 || /^[BEAI]_[a-zA-Z0-9]{4}$/.test(clientId);
  }

  private async _readPersistedValidClientId(
    options: { warnOnInvalid?: boolean } = {},
  ): Promise<string | null> {
    const db = await this._getDb();
    const clientId = await db.get(DB_STORE_NAME, CLIENT_ID_KEY);

    if (typeof clientId !== 'string') {
      return null;
    }

    if (!this._isValidClientIdFormat(clientId)) {
      if (options.warnOnInvalid) {
        // Unrecognized format — log but treat as missing rather than throwing.
        // Throwing here permanently blocks sync (issue #6197: "Invalid clientId loaded: B_H8AR").
        // Returning null causes the caller to generate a fresh clientId, which unblocks sync.
        // Length only — the literal clientId value is sensitive (vector-clock
        // key) and log history is user-exportable (CLAUDE.md sync rule 9).
        OpLog.critical(
          'ClientIdService.loadClientId() Invalid clientId format, will regenerate:',
          {
            length: clientId.length,
          },
        );
        this._snackService?.open({
          msg: T.F.SYNC.S.WARN_CLIENT_ID_REGENERATED,
          type: 'WARNING',
        });
      }
      return null;
    }

    return clientId;
  }

  private async _restorePriorClientIdIfCurrentMatches(
    priorClientId: string,
    expectedCurrentClientId: string,
  ): Promise<void> {
    const db = await this._getDb();
    const tx = db.transaction(DB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(DB_STORE_NAME);
    const currentClientId = await store.get(CLIENT_ID_KEY);

    if (currentClientId === expectedCurrentClientId) {
      await store.put(priorClientId, CLIENT_ID_KEY);
      await tx.done;
      this._cachedClientId = priorClientId;
      return;
    }

    await tx.done;
    this._cachedClientId =
      typeof currentClientId === 'string' && this._isValidClientIdFormat(currentClientId)
        ? currentClientId
        : null;
  }

  private _errorName(error: unknown): string {
    return error instanceof Error ? error.name : typeof error;
  }

  /**
   * Gets or opens the IndexedDB database.
   */
  private async _getDb(): Promise<IDBPDatabase> {
    if (this._db) {
      return this._db;
    }

    this._db = await openDB(DB_NAME, DB_VERSION, {
      upgrade: (db) => {
        if (!db.objectStoreNames.contains(DB_STORE_NAME)) {
          db.createObjectStore(DB_STORE_NAME);
        }
      },
    });

    return this._db;
  }

  /**
   * Generates a compact 6-char client ID.
   * Format: {platform}_{4-char-base62-random}
   */
  private _generateClientId(): string {
    const prefix = this._getEnvironmentId();
    const randomPart = this._generateBase62(4);
    return `${prefix}_${randomPart}`;
  }

  /**
   * Returns a single-character platform identifier for compact client IDs.
   * B = Browser, E = Electron, A = Android, I = iOS
   */
  private _getEnvironmentId(): string {
    // Detect Electron
    const isElectron =
      typeof process !== 'undefined' && (process as any).versions?.electron;
    if (isElectron) {
      return 'E';
    }

    // Detect Android WebView
    if (/Android/.test(navigator.userAgent) && /wv/.test(navigator.userAgent)) {
      return 'A';
    }

    // Detect iOS
    if (
      navigator.userAgent.includes('iOS') ||
      navigator.userAgent.includes('iPhone') ||
      navigator.userAgent.includes('iPad')
    ) {
      return 'I';
    }

    // Default: Browser
    return 'B';
  }

  /**
   * Generates a random base62 string of the specified length.
   * Uses crypto.getRandomValues() for non-predictable randomness.
   */
  private _generateBase62(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }
}
