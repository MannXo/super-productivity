import { inject, Injectable } from '@angular/core';
import { uuidv7 } from '../../util/uuid-v7';
import { StateSnapshotService } from '../backup/state-snapshot.service';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { ClientIdService } from '../../core/util/client-id.service';
import { OpLog } from '../../core/log';
import { Operation, OpType, SyncImportReason } from '../core/operation.types';
import { ActionType } from '../core/action-types.enum';
import { CURRENT_SCHEMA_VERSION } from '../persistence/schema-migration.service';
import { extractEntityKeysFromState } from '../persistence/extract-entity-keys';
import { OperationWriteFlushService } from '../sync/operation-write-flush.service';
import { LockService } from '../sync/lock.service';
import { LOCK_NAMES } from '../core/operation-log.const';

/**
 * Reason a clean-slate was triggered. Logged for diagnostic correlation
 * (so a future sync-stuck incident can be tied to the cause without
 * forensic recovery).
 */
export type CleanSlateReason = 'ENCRYPTION_CHANGE' | 'MANUAL';

/**
 * Service for performing "clean slate" operations on the sync state.
 *
 * Atomically replaces the local op-log + state_cache + vector_clock with a
 * fresh baseline derived from current state. Used by encryption-password
 * changes (which need a fresh sync baseline) and by user-initiated sync
 * recovery.
 *
 * Atomicity within `SUP_OPS` is guaranteed by
 * `OperationLogStoreService.runDestructiveStateReplacement`; cross-DB
 * rotation of the clientId (which lives in `pf`) is rolled back on failure
 * — see issue #7709.
 *
 * @example
 * ```typescript
 * await cleanSlateService.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');
 * await syncService.triggerSync();
 * ```
 */
@Injectable({
  providedIn: 'root',
})
export class CleanSlateService {
  private stateSnapshotService = inject(StateSnapshotService);
  private opLogStore = inject(OperationLogStoreService);
  private clientIdService = inject(ClientIdService);
  private operationWriteFlushService = inject(OperationWriteFlushService);
  private lockService = inject(LockService);

  /**
   * Creates a clean slate by resetting local operation log and preparing
   * a fresh SYNC_IMPORT operation for upload.
   *
   * The destructive sequence (clear OPS, append SYNC_IMPORT, write vector
   * clock, write state_cache) runs as a single atomic transaction. On
   * failure, the rotated clientId is rolled back so `pf` and `SUP_OPS` stay
   * consistent.
   *
   * Does NOT upload to the server — that happens on the next sync, with the
   * `isCleanSlate=true` flag, which makes the server delete its operations
   * and accept the new baseline. Other clients then re-sync from the new
   * baseline.
   *
   * @throws If state snapshot cannot be retrieved or operations cannot be stored.
   */
  async createCleanSlate(
    reason: CleanSlateReason,
    syncImportReason: SyncImportReason,
  ): Promise<void> {
    await this.operationWriteFlushService.flushPendingWrites();

    let result: { syncImportId: string; newClientId: string } | null = null;

    await this.lockService.request(LOCK_NAMES.OPERATION_LOG, async () => {
      // Diagnostic snapshot of state about to be wiped. Captured before any
      // mutation. Lets a future sync-stuck incident be correlated to the local
      // op-log shape that preceded the destructive recovery (count of unsynced
      // user work, prior vector-clock entries) without forensic recovery.
      const priorClock = await this.opLogStore.getVectorClock();
      const priorUnsynced = await this.opLogStore.getUnsynced();
      const priorOpTypeBreakdown = priorUnsynced.reduce<Record<string, number>>(
        (acc, entry) => {
          const key = entry.op.opType;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        },
        {},
      );
      OpLog.normal('[CleanSlate] Starting clean slate process', {
        reason,
        syncImportReason,
        priorUnsyncedCount: priorUnsynced.length,
        priorUnsyncedByOpType: priorOpTypeBreakdown,
        priorClockSize: priorClock ? Object.keys(priorClock).length : 0,
      });

      // 1. Get current application state (includes all features + archives).
      // IMPORTANT: must use the async version to load real archives from
      // IndexedDB. The sync getStateSnapshot() returns DEFAULT_ARCHIVE (empty)
      // which causes data loss.
      const currentState = await this.stateSnapshotService.getStateSnapshotAsync();

      // Rotate the clientId for the duration of the destructive replacement.
      // The clientId lives in a separate IDB database (`pf`) and so cannot
      // share the atomic SUP_OPS tx below; ClientIdService.withRotation rolls
      // it back on failure so `pf` and `SUP_OPS` agree on the device's
      // clientId after this method returns or throws.
      result = await this.clientIdService.withRotation(
        '[CleanSlate]',
        async (newClientId) => {
          OpLog.normal('[CleanSlate] Generated new client ID', { newClientId });

          const newVectorClock = { [newClientId]: 1 };
          const syncImportOp: Operation = {
            id: uuidv7(),
            actionType: ActionType.LOAD_ALL_DATA,
            opType: OpType.SyncImport,
            entityType: 'ALL',
            entityId: undefined,
            payload: currentState,
            clientId: newClientId,
            vectorClock: newVectorClock,
            timestamp: Date.now(),
            schemaVersion: CURRENT_SCHEMA_VERSION,
            syncImportReason,
          };

          OpLog.normal('[CleanSlate] Created SYNC_IMPORT operation', {
            opId: syncImportOp.id,
            clientId: newClientId,
          });

          OpLog.normal('[CleanSlate] Replacing op-log + state cache atomically');
          await this.opLogStore.runDestructiveStateReplacement({
            syncImportOp,
            newVectorClock,
            newState: currentState,
            schemaVersion: CURRENT_SCHEMA_VERSION,
            snapshotEntityKeys: extractEntityKeysFromState(currentState),
          });

          return { syncImportId: syncImportOp.id, newClientId };
        },
      );
    });

    if (!result) {
      throw new Error('[CleanSlate] Clean slate completed without a replacement result');
    }
    const cleanSlateResult = result as { syncImportId: string; newClientId: string };

    OpLog.normal('[CleanSlate] Clean slate completed successfully', {
      syncImportId: cleanSlateResult.syncImportId,
      newClientId: cleanSlateResult.newClientId,
      reason,
    });
  }
}
