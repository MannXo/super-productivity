import { TestBed } from '@angular/core/testing';
import { ClientIdService } from './client-id.service';
import { SnackService } from '../snack/snack.service';
import { openDB } from 'idb';
import { OpLog } from '../log';

// Constants that mirror the private constants in ClientIdService
const DB_NAME = 'pf';
const DB_STORE_NAME = 'main';
const DB_VERSION = 1;
const CLIENT_ID_KEY = '__client_id_';

/**
 * Helper to write a raw value directly to the 'pf' IndexedDB store,
 * bypassing ClientIdService validation so we can test recovery paths.
 */
const writeRawClientId = async (value: unknown): Promise<void> => {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade: (database) => {
      if (!database.objectStoreNames.contains(DB_STORE_NAME)) {
        database.createObjectStore(DB_STORE_NAME);
      }
    },
  });
  await db.put(DB_STORE_NAME, value, CLIENT_ID_KEY);
  db.close();
};

describe('ClientIdService', () => {
  let service: ClientIdService;
  let mockSnackService: jasmine.SpyObj<SnackService>;

  beforeEach(() => {
    mockSnackService = jasmine.createSpyObj('SnackService', ['open']);

    TestBed.configureTestingModule({
      providers: [ClientIdService, { provide: SnackService, useValue: mockSnackService }],
    });
    service = TestBed.inject(ClientIdService);
  });

  afterEach(async () => {
    // Clean up IndexedDB between tests
    const db = await openDB(DB_NAME, DB_VERSION, {
      upgrade: (database) => {
        if (!database.objectStoreNames.contains(DB_STORE_NAME)) {
          database.createObjectStore(DB_STORE_NAME);
        }
      },
    });
    await db.delete(DB_STORE_NAME, CLIENT_ID_KEY);
    db.close();
    service.clearCache();
  });

  describe('loadClientId()', () => {
    it('should return null when no clientId is stored', async () => {
      const result = await service.loadClientId();
      expect(result).toBeNull();
    });

    it('should return a valid new-format clientId (e.g. "B_H8AR")', async () => {
      await writeRawClientId('B_H8AR');
      const result = await service.loadClientId();
      expect(result).toBe('B_H8AR');
    });

    it('should return a valid old-format clientId (10+ chars)', async () => {
      const oldFormatId = 'LongClientId123';
      await writeRawClientId(oldFormatId);
      const result = await service.loadClientId();
      expect(result).toBe(oldFormatId);
    });

    it('should return null (not throw) for an invalid clientId format, enabling recovery (#6197)', async () => {
      // Simulate a corrupted or truncated clientId that doesn't match either format
      await writeRawClientId('BAD');
      // Must NOT throw - returning null allows caller to generate a fresh clientId
      const result = await service.loadClientId();
      expect(result).toBeNull();
    });

    it('should warn the user when clientId is invalid and will be regenerated', async () => {
      await writeRawClientId('BAD');
      await service.loadClientId();
      expect(mockSnackService.open).toHaveBeenCalledWith(
        jasmine.objectContaining({ type: 'WARNING' }),
      );
    });

    it('should return null (not throw) for empty string clientId', async () => {
      await writeRawClientId('');
      const result = await service.loadClientId();
      expect(result).toBeNull();
    });

    it('should cache a valid clientId after first load', async () => {
      await writeRawClientId('B_H8AR');
      const first = await service.loadClientId();
      // Delete from DB to confirm cache is used on second call
      const db = await openDB(DB_NAME, DB_VERSION);
      await db.delete(DB_STORE_NAME, CLIENT_ID_KEY);
      db.close();
      const second = await service.loadClientId();
      expect(second).toBe(first);
    });
  });

  describe('generateNewClientId()', () => {
    it('should generate a clientId matching the new format', async () => {
      const id = await service.generateNewClientId();
      expect(/^[BEAI]_[a-zA-Z0-9]{4}$/.test(id)).toBeTrue();
    });

    it('should persist the generated clientId so loadClientId() returns it', async () => {
      const generated = await service.generateNewClientId();
      service.clearCache();
      const loaded = await service.loadClientId();
      expect(loaded).toBe(generated);
    });
  });

  describe('getOrGenerateClientId()', () => {
    it('should return existing valid clientId', async () => {
      await writeRawClientId('B_H8AR');
      const result = await service.getOrGenerateClientId();
      expect(result).toBe('B_H8AR');
    });

    it('should generate and persist a new clientId when none is stored', async () => {
      const result = await service.getOrGenerateClientId();
      expect(/^[BEAI]_[a-zA-Z0-9]{4}$/.test(result)).toBeTrue();
      // Verify it was persisted: clear cache and reload
      service.clearCache();
      const loaded = await service.loadClientId();
      expect(loaded).toBe(result);
    });

    it('should generate a new clientId when stored value is invalid', async () => {
      await writeRawClientId('BAD');
      const result = await service.getOrGenerateClientId();
      expect(/^[BEAI]_[a-zA-Z0-9]{4}$/.test(result)).toBeTrue();
    });
  });

  describe('persistClientId()', () => {
    it('should persist a valid new-format clientId', async () => {
      await service.persistClientId('E_abcd');
      service.clearCache();
      const loaded = await service.loadClientId();
      expect(loaded).toBe('E_abcd');
    });

    it('should persist a valid old-format clientId', async () => {
      const oldId = 'OldFormatClientId1';
      await service.persistClientId(oldId);
      service.clearCache();
      const loaded = await service.loadClientId();
      expect(loaded).toBe(oldId);
    });

    it('should throw for invalid format without persisting', async () => {
      await expectAsync(service.persistClientId('INVALID')).toBeRejected();
    });
  });

  describe('withRotation()', () => {
    it('should call fn with a fresh clientId and return its value', async () => {
      await service.persistClientId('B_Prio');
      service.clearCache();

      const result = await service.withRotation('[Test]', async (newId) => {
        expect(newId).not.toBe('B_Prio');
        return { ok: true, id: newId };
      });

      expect(result.ok).toBe(true);
      const persisted = await service.loadClientId();
      expect(persisted).toBe(result.id);
    });

    it('should restore the prior clientId when fn throws', async () => {
      await service.persistClientId('B_Prio');
      service.clearCache();

      await expectAsync(
        service.withRotation('[Test]', async () => {
          throw new Error('work failed');
        }),
      ).toBeRejectedWith(jasmine.objectContaining({ message: 'work failed' }));

      service.clearCache();
      expect(await service.loadClientId()).toBe('B_Prio');
    });

    it('should restore the persisted prior clientId even when the cache is stale', async () => {
      await service.persistClientId('B_Cach');
      await writeRawClientId('B_Fres');

      await expectAsync(
        service.withRotation('[Test]', async () => {
          throw new Error('work failed');
        }),
      ).toBeRejectedWith(jasmine.objectContaining({ message: 'work failed' }));

      service.clearCache();
      expect(await service.loadClientId()).toBe('B_Fres');
    });

    it('should not roll back over a newer persisted clientId from another context', async () => {
      await service.persistClientId('B_Prio');
      service.clearCache();

      await expectAsync(
        service.withRotation('[Test]', async () => {
          await writeRawClientId('B_Othr');
          throw new Error('work failed');
        }),
      ).toBeRejectedWith(jasmine.objectContaining({ message: 'work failed' }));

      service.clearCache();
      expect(await service.loadClientId()).toBe('B_Othr');
    });

    it('should leave the rotated clientId in place when there was no prior id', async () => {
      // Wholly fresh device — `pf` is empty.
      expect(await service.loadClientId()).toBeNull();

      await expectAsync(
        service.withRotation('[Test]', async () => {
          throw new Error('work failed');
        }),
      ).toBeRejectedWith(jasmine.objectContaining({ message: 'work failed' }));

      service.clearCache();
      const persisted = await service.loadClientId();
      expect(persisted).not.toBeNull();
    });

    it('should propagate the original fn error when rollback also fails', async () => {
      await service.persistClientId('B_Prio');
      service.clearCache();
      spyOn(service as any, '_restorePriorClientIdIfCurrentMatches').and.rejectWith(
        new Error('pf write also broken'),
      );

      await expectAsync(
        service.withRotation('[Test]', async () => {
          throw new Error('work failed');
        }),
      ).toBeRejectedWith(jasmine.objectContaining({ message: 'work failed' }));
    });

    it('should not log clientIds or raw error messages when rollback fails', async () => {
      await service.persistClientId('B_Prio');
      service.clearCache();
      spyOn(service as any, '_restorePriorClientIdIfCurrentMatches').and.rejectWith(
        new Error('rollback failed with B_Prio'),
      );
      const opLogSpy = spyOn(OpLog, 'critical');

      await expectAsync(
        service.withRotation('[Test]', async () => {
          throw new Error('work failed with B_Prio');
        }),
      ).toBeRejectedWith(
        jasmine.objectContaining({ message: 'work failed with B_Prio' }),
      );

      expect(opLogSpy).toHaveBeenCalled();
      const payload = opLogSpy.calls.mostRecent().args[1] as Record<string, unknown>;
      const serializedPayload = JSON.stringify(payload);
      expect(payload).toEqual(
        jasmine.objectContaining({
          hadPriorClientId: true,
          originalErrorName: 'Error',
          rollbackErrorName: 'Error',
        }),
      );
      expect(serializedPayload).not.toContain('B_Prio');
      expect(serializedPayload).not.toContain('work failed');
      expect(serializedPayload).not.toContain('rollback failed');
    });
  });
});
