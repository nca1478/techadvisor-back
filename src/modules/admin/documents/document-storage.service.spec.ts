import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));

vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));

import { parseEnv } from '../../../config/env.schema.js';
import { DocumentStorageService, normalizeStoragePrefix } from './document-storage.service.js';

function baseConfig() {
  return parseEnv();
}

describe('normalizeStoragePrefix', () => {
  it('trims slashes and whitespace', () => {
    expect(normalizeStoragePrefix('storage/documents')).toBe('storage/documents');
    expect(normalizeStoragePrefix('/storage/documents/')).toBe('storage/documents');
    expect(normalizeStoragePrefix('  ')).toBe('');
  });
});

describe('DocumentStorageService (local driver)', () => {
  it('creates ./storage/documents on init and round-trips bytes without Supabase', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docs-local-'));
    await rm(dir, { recursive: true, force: true });
    const config = { ...baseConfig(), DOCUMENTS_DIR: dir, DOCUMENTS_DRIVER: 'local' as const };
    const service = new DocumentStorageService(config);

    expect(service.storageDriver).toBe('local');
    await service.onModuleInit();
    expect(createClientMock).not.toHaveBeenCalled();

    const id = '11111111-1111-4111-8111-111111111111';
    const key = await service.save(id, Buffer.from('hello local', 'utf8'));
    expect(key).toBe(`${id}.bin`);
    await expect(service.read(key)).resolves.toEqual(Buffer.from('hello local', 'utf8'));
    await service.remove(key);
    await expect(service.read(key)).resolves.toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects non-UUID keys', async () => {
    const config = { ...baseConfig(), DOCUMENTS_DRIVER: 'local' as const };
    const service = new DocumentStorageService(config);
    await expect(service.read('../evil.bin')).resolves.toBeNull();
    await expect(service.remove('not-a-key')).resolves.toBeUndefined();
  });
});

describe('DocumentStorageService (supabase driver)', () => {
  const documentId = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    createClientMock.mockReset();
  });

  function supabaseConfig(documentsDir: string) {
    return {
      ...baseConfig(),
      DOCUMENTS_DIR: documentsDir,
      DOCUMENTS_DRIVER: 'supabase' as const,
      SUPABASE_URL: 'https://xyz.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_STORAGE_BUCKET: 'documents',
      SUPABASE_STORAGE_PREFIX: 'storage/documents',
    };
  }

  function fakeStorageBucket() {
    const files = new Map<string, Buffer>();
    return {
      files,
      getBucket: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
      createBucket: vi.fn().mockResolvedValue({ data: null, error: null }),
      list: vi.fn().mockResolvedValue({ data: [], error: null }),
      upload: vi.fn((path: string, body: Buffer) => {
        files.set(path, Buffer.from(body));
        return { data: { path }, error: null };
      }),
      download: vi.fn((path: string) => {
        const raw = files.get(path);
        if (raw === undefined) {
          return { data: null, error: { message: 'not found' } };
        }
        return { data: new Blob([new Uint8Array(raw)]), error: null };
      }),
      remove: vi.fn((paths: string[]) => {
        for (const path of paths) {
          files.delete(path);
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };
  }

  function mockBucket(bucket: ReturnType<typeof fakeStorageBucket>, listData: unknown[] = []) {
    bucket.list.mockResolvedValue({ data: listData, error: null });
    createClientMock.mockReturnValue({
      storage: {
        getBucket: bucket.getBucket,
        createBucket: bucket.createBucket,
        from: () => ({
          upload: bucket.upload,
          download: bucket.download,
          remove: bucket.remove,
          list: bucket.list,
        }),
      },
    });
    return bucket;
  }

  it('creates the bucket and the storage/documents prefix on init', async () => {
    const bucket = fakeStorageBucket();
    mockBucket(bucket);
    const service = new DocumentStorageService(supabaseConfig(join(tmpdir(), 'docs-unused')));
    await service.onModuleInit();

    expect(bucket.getBucket).toHaveBeenCalledWith('documents');
    expect(bucket.createBucket).toHaveBeenCalledWith('documents', { public: false });
    expect(bucket.upload).toHaveBeenCalledWith(
      'storage/documents/.keep',
      expect.any(Buffer),
      expect.objectContaining({ upsert: true }),
    );
    expect(service.objectPath(`${documentId}.bin`)).toBe(`storage/documents/${documentId}.bin`);
  });

  it('does not recreate the prefix when it already has files', async () => {
    const bucket = fakeStorageBucket();
    mockBucket(bucket, [{ name: 'existing.bin' }]);
    const service = new DocumentStorageService(supabaseConfig(join(tmpdir(), 'docs-unused')));
    await service.onModuleInit();

    expect(bucket.upload).not.toHaveBeenCalled();
  });

  it('round-trips bytes through object paths without touching local disk', async () => {
    const bucket = fakeStorageBucket();
    mockBucket(bucket, [{ name: '.keep' }]);
    const service = new DocumentStorageService(supabaseConfig(join(tmpdir(), 'docs-unused')));
    await service.onModuleInit();

    const key = await service.save(documentId, Buffer.from('hello supabase', 'utf8'));
    expect(key).toBe(`${documentId}.bin`);
    expect(bucket.upload).toHaveBeenCalledWith(
      `storage/documents/${documentId}.bin`,
      expect.any(Buffer),
      expect.objectContaining({ upsert: true }),
    );
    await expect(service.read(key)).resolves.toEqual(Buffer.from('hello supabase', 'utf8'));
    await service.remove(key);
    await expect(service.read(key)).resolves.toBeNull();
  });
});
