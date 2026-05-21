import { TestBed } from '@angular/core/testing';
import { CleanSlateService } from './clean-slate.service';
import { StateSnapshotService } from '../backup/state-snapshot.service';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { ClientIdService } from '../../core/util/client-id.service';
import { OpType, OperationLogEntry } from '../core/operation.types';
import { ActionType } from '../core/action-types.enum';
import { CURRENT_SCHEMA_VERSION } from '../persistence/schema-migration.service';
import { OpLog } from '../../core/log';
import { OperationWriteFlushService } from '../sync/operation-write-flush.service';
import { LockService } from '../sync/lock.service';
import { LOCK_NAMES } from '../core/operation-log.const';

describe('CleanSlateService', () => {
  let service: CleanSlateService;
  let mockStateSnapshotService: jasmine.SpyObj<StateSnapshotService>;
  let mockOpLogStore: jasmine.SpyObj<OperationLogStoreService>;
  let mockClientIdService: jasmine.SpyObj<ClientIdService>;
  let mockOperationWriteFlushService: jasmine.SpyObj<OperationWriteFlushService>;
  let mockLockService: jasmine.SpyObj<LockService>;

  const mockState = {
    task: { ids: [], entities: {} },
    project: { ids: ['INBOX'], entities: {} },
    globalConfig: {},
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };

  beforeEach(() => {
    mockStateSnapshotService = jasmine.createSpyObj('StateSnapshotService', [
      'getStateSnapshotAsync',
    ]);
    mockOpLogStore = jasmine.createSpyObj('OperationLogStoreService', [
      'runDestructiveStateReplacement',
      'getVectorClock',
      'getUnsynced',
    ]);
    mockClientIdService = jasmine.createSpyObj('ClientIdService', ['withRotation']);
    mockOperationWriteFlushService = jasmine.createSpyObj('OperationWriteFlushService', [
      'flushPendingWrites',
    ]);
    mockLockService = jasmine.createSpyObj('LockService', ['request']);

    TestBed.configureTestingModule({
      providers: [
        CleanSlateService,
        { provide: StateSnapshotService, useValue: mockStateSnapshotService },
        { provide: OperationLogStoreService, useValue: mockOpLogStore },
        { provide: ClientIdService, useValue: mockClientIdService },
        {
          provide: OperationWriteFlushService,
          useValue: mockOperationWriteFlushService,
        },
        { provide: LockService, useValue: mockLockService },
      ],
    });

    service = TestBed.inject(CleanSlateService);

    // Setup default mock responses
    mockStateSnapshotService.getStateSnapshotAsync.and.resolveTo(mockState as any);
    // Default: withRotation invokes its callback with the new clientId and
    // propagates whatever the callback returns or throws. ClientIdService's
    // own spec covers the rollback semantics.
    mockClientIdService.withRotation.and.callFake(
      async (_logPrefix: string, fn: (newClientId: string) => Promise<any>) =>
        fn('eNewC'),
    );
    mockOpLogStore.runDestructiveStateReplacement.and.resolveTo();
    mockOpLogStore.getVectorClock.and.resolveTo(null);
    mockOpLogStore.getUnsynced.and.resolveTo([]);
    mockOperationWriteFlushService.flushPendingWrites.and.resolveTo();
    mockLockService.request.and.callFake(async (_lockName, fn) => fn());
  });

  describe('createCleanSlate', () => {
    it('should create a clean slate successfully', async () => {
      await service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      // Should get current state (async version to include archives)
      expect(mockStateSnapshotService.getStateSnapshotAsync).toHaveBeenCalled();

      // Should rotate client ID via the shared helper
      expect(mockClientIdService.withRotation).toHaveBeenCalledWith(
        '[CleanSlate]',
        jasmine.any(Function),
      );

      // Should route through the atomic helper (issue #7709)
      expect(mockOpLogStore.runDestructiveStateReplacement).toHaveBeenCalledTimes(1);
      const args = mockOpLogStore.runDestructiveStateReplacement.calls.mostRecent()
        .args[0] as Parameters<typeof mockOpLogStore.runDestructiveStateReplacement>[0];

      const appendedOp = args.syncImportOp;
      expect(appendedOp.actionType).toBe(ActionType.LOAD_ALL_DATA);
      expect(appendedOp.opType).toBe(OpType.SyncImport);
      expect(appendedOp.entityType).toBe('ALL');
      expect(appendedOp.payload).toBe(mockState);
      expect(appendedOp.clientId).toBe('eNewC');
      expect(appendedOp.vectorClock).toEqual({ eNewC: 1 });
      expect(appendedOp.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

      expect(args.newVectorClock).toEqual({ eNewC: 1 });
      expect(args.newState).toBe(mockState);
      expect(args.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('should flush pending writes and hold the op-log lock during replacement', async () => {
      const callOrder: string[] = [];
      mockOperationWriteFlushService.flushPendingWrites.and.callFake(async () => {
        callOrder.push('flush');
      });
      mockLockService.request.and.callFake(async (lockName, fn) => {
        callOrder.push(`lock:${lockName}`);
        const r = await fn();
        callOrder.push('unlock');
        return r;
      });
      mockStateSnapshotService.getStateSnapshotAsync.and.callFake(async () => {
        callOrder.push('snapshot');
        return mockState as any;
      });
      mockOpLogStore.runDestructiveStateReplacement.and.callFake(async () => {
        callOrder.push('replace');
      });

      await service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      expect(callOrder).toEqual([
        'flush',
        `lock:${LOCK_NAMES.OPERATION_LOG}`,
        'snapshot',
        'replace',
        'unlock',
      ]);
    });

    it('should log diagnostic snapshot of prior clock and unsynced ops before mutation', async () => {
      const opLogSpy = spyOn(OpLog, 'normal');
      mockOpLogStore.getVectorClock.and.resolveTo({
        ['B_old']: 42,
        ['B_other']: 7,
      });
      mockOpLogStore.getUnsynced.and.resolveTo([
        {
          seq: 1,
          op: { opType: OpType.Create, id: 'a' } as any,
          appliedAt: 0,
        },
        {
          seq: 2,
          op: { opType: OpType.Create, id: 'b' } as any,
          appliedAt: 0,
        },
        {
          seq: 3,
          op: { opType: OpType.Update, id: 'c' } as any,
          appliedAt: 0,
        },
      ] as OperationLogEntry[]);

      await service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      expect(opLogSpy).toHaveBeenCalledWith(
        '[CleanSlate] Starting clean slate process',
        jasmine.objectContaining({
          reason: 'ENCRYPTION_CHANGE',
          syncImportReason: 'PASSWORD_CHANGED',
          priorUnsyncedCount: 3,
          priorUnsyncedByOpType: jasmine.objectContaining({
            [OpType.Create]: 2,
            [OpType.Update]: 1,
          }),
          priorClockSize: 2,
        }),
      );
      // Security C2: vector-clock contents must never be logged — keys are
      // per-device clientIds and log history is user-exportable.
      const loggedPayload = opLogSpy.calls.mostRecent().args[1] as Record<
        string,
        unknown
      >;
      expect('priorClock' in loggedPayload).toBe(false);
      // Order invariant: diagnostic snapshot reads must precede the
      // destructive atomic replacement.
      expect(mockOpLogStore.getVectorClock).toHaveBeenCalledBefore(
        mockOpLogStore.runDestructiveStateReplacement,
      );
      expect(mockOpLogStore.getUnsynced).toHaveBeenCalledBefore(
        mockOpLogStore.runDestructiveStateReplacement,
      );
    });

    it('should work with MANUAL reason', async () => {
      await service.createCleanSlate('MANUAL', 'PASSWORD_CHANGED');

      // Should still complete the destructive replacement with MANUAL reason.
      expect(mockOpLogStore.runDestructiveStateReplacement).toHaveBeenCalledTimes(1);
    });

    it('should generate fresh vector clock starting at 1', async () => {
      await service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      const args = mockOpLogStore.runDestructiveStateReplacement.calls.mostRecent()
        .args[0] as Parameters<typeof mockOpLogStore.runDestructiveStateReplacement>[0];
      expect(args.syncImportOp.vectorClock).toEqual({ eNewC: 1 });
      expect(args.newVectorClock).toEqual({ eNewC: 1 });
    });

    it('should create operation with valid UUIDv7', async () => {
      await service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      const args = mockOpLogStore.runDestructiveStateReplacement.calls.mostRecent()
        .args[0] as Parameters<typeof mockOpLogStore.runDestructiveStateReplacement>[0];
      // UUIDv7 format: 8-4-4-4-12 characters
      expect(args.syncImportOp.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('should throw if state snapshot fails', async () => {
      mockStateSnapshotService.getStateSnapshotAsync.and.rejectWith(
        new Error('State error'),
      );

      await expectAsync(
        service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED'),
      ).toBeRejectedWith(jasmine.objectContaining({ message: 'State error' }));
    });

    it('should propagate errors from withRotation', async () => {
      // ClientIdService.withRotation owns the cross-DB rollback semantics
      // (see its own spec). Here we only verify that CleanSlateService
      // surfaces failures from the rotation/replacement chain to its caller.
      mockClientIdService.withRotation.and.rejectWith(
        new Error('Atomic replacement failed'),
      );

      await expectAsync(
        service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED'),
      ).toBeRejectedWith(
        jasmine.objectContaining({ message: 'Atomic replacement failed' }),
      );
    });

    it('should propagate errors from runDestructiveStateReplacement through withRotation', async () => {
      // The destructive helper runs inside the withRotation callback.
      // withRotation must re-throw whatever the callback throws so the
      // caller sees the real failure.
      mockOpLogStore.runDestructiveStateReplacement.and.rejectWith(
        new Error('Atomic replacement failed'),
      );

      await expectAsync(
        service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED'),
      ).toBeRejectedWith(
        jasmine.objectContaining({ message: 'Atomic replacement failed' }),
      );
    });

    it('should pass snapshotEntityKeys derived from current state', async () => {
      // Without snapshotEntityKeys, the persisted state_cache singleton looks
      // like the "old snapshot format" to remote-ops-processing, which
      // triggers an unnecessary background recompaction after every
      // clean-slate. Callers must pass it.
      await service.createCleanSlate('ENCRYPTION_CHANGE', 'PASSWORD_CHANGED');

      const args = mockOpLogStore.runDestructiveStateReplacement.calls.mostRecent()
        .args[0] as Parameters<typeof mockOpLogStore.runDestructiveStateReplacement>[0];
      expect(args.snapshotEntityKeys).toBeDefined();
      expect(Array.isArray(args.snapshotEntityKeys)).toBe(true);
    });
  });
});
