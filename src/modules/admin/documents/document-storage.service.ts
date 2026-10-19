import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';

/** `<uuid>.bin`: the only filename shape this service ever reads. */
const STORAGE_KEY_PATTERN = /^[0-9a-fA-F-]{36}\.bin$/;

/** Placeholder proving the configured prefix exists (Supabase has no real folders). */
const PREFIX_KEEP_FILE = '.keep';

/** Trims slashes so `storage/documents`, `/storage/documents/` and `` all behave. */
export function normalizeStoragePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Dual-driver storage for admin-uploaded RAG sources (see ADRs 0020, 0071).
 *
 * - `local` (development default): `<DOCUMENTS_DIR>/<documentId>.bin` on
 *   disk, created with `mkdir -p` at boot. Never touches Supabase, so no
 *   bucket is created in this environment.
 * - `supabase` (production): private Supabase Storage bucket
 *   `<bucket>/<prefix>/<documentId>.bin` (default prefix
 *   `storage/documents`). `onModuleInit` ensures the bucket exists
 *   (idempotent create, `public: false`) and the prefix folder via a
 *   `.keep` placeholder — Supabase folders are virtual path prefixes.
 *
 * The filename is derived from the document UUID — never from user input —
 * so there is no path traversal; `storageKey` values are validated against
 * the UUID pattern on read. No path is ever returned to clients (the key
 * itself is internal-only and absent from every DTO).
 */
@Injectable()
export class DocumentStorageService implements OnModuleInit {
  private readonly logger = new Logger(DocumentStorageService.name);
  private readonly dir: string;
  private readonly driver: AppConfig['DOCUMENTS_DRIVER'];
  private readonly bucket: string;
  private readonly prefix: string;
  private client: SupabaseClient | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.dir = isAbsolute(config.DOCUMENTS_DIR)
      ? config.DOCUMENTS_DIR
      : resolve(process.cwd(), config.DOCUMENTS_DIR);
    this.driver = config.DOCUMENTS_DRIVER;
    this.bucket = config.SUPABASE_STORAGE_BUCKET;
    this.prefix = normalizeStoragePrefix(config.SUPABASE_STORAGE_PREFIX);
  }

  /** Active driver (`local` in development, `supabase` in production). */
  get storageDriver(): AppConfig['DOCUMENTS_DRIVER'] {
    return this.driver;
  }

  /**
   * Boot provisioning. Local: creates `./storage/documents` on disk.
   * Supabase: creates the bucket + `storage/documents` prefix folder.
   * Never creates a bucket when the driver is `local`.
   */
  async onModuleInit(): Promise<void> {
    if (this.driver === 'supabase') {
      await this.ensureSupabaseBucket();
      return;
    }
    await mkdir(this.dir, { recursive: true });
  }

  /** Directory holding the source files (local driver; created lazily, for tests too). */
  directory(): string {
    return this.dir;
  }

  /** Bucket holding the source files (supabase driver). */
  bucketName(): string {
    return this.bucket;
  }

  /** Object path inside the bucket: `<prefix>/<storageKey>` (or just the key at root). */
  objectPath(storageKey: string): string {
    return this.prefix.length > 0 ? `${this.prefix}/${storageKey}` : storageKey;
  }

  /** Persists raw bytes for a document; returns the internal storage key. */
  async save(documentId: string, raw: Buffer): Promise<string> {
    const key = `${documentId}.bin`;
    if (this.driver === 'supabase') {
      const client = this.getClient();
      const { error } = await client.storage.from(this.bucket).upload(this.objectPath(key), raw, {
        upsert: true,
        contentType: 'application/octet-stream',
      });
      if (error !== null) {
        throw new Error(`Supabase storage upload failed: ${error.message}`);
      }
      return key;
    }
    await mkdir(this.dir, { recursive: true });
    await writeFile(resolve(this.dir, key), raw);
    return key;
  }

  /** Reads stored bytes, or `null` when the file is gone. */
  async read(storageKey: string): Promise<Buffer | null> {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      return null;
    }
    if (this.driver === 'supabase') {
      const client = this.getClient();
      const { data, error } = await client.storage
        .from(this.bucket)
        .download(this.objectPath(storageKey));
      if (error !== null) {
        return null;
      }
      return Buffer.from(await data.arrayBuffer());
    }
    const path = resolve(this.dir, storageKey);
    if (!existsSync(path)) {
      return null;
    }
    return readFile(path);
  }

  /** Best-effort removal (missing files are not an error). */
  async remove(storageKey: string): Promise<void> {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      return;
    }
    if (this.driver === 'supabase') {
      await this.getClient()
        .storage.from(this.bucket)
        .remove([this.objectPath(storageKey)])
        .catch(() => undefined);
      return;
    }
    await unlink(resolve(this.dir, storageKey)).catch(() => undefined);
  }

  private getClient(): SupabaseClient {
    if (this.client !== null) {
      return this.client;
    }
    const url = this.config.SUPABASE_URL;
    const serviceKey = this.config.SUPABASE_SERVICE_ROLE_KEY;
    if (url === undefined || serviceKey === undefined) {
      throw new Error(
        'Supabase storage is not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when DOCUMENTS_DRIVER is supabase)',
      );
    }
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  /**
   * Idempotent production provisioning: private bucket + prefix folder.
   * Warns instead of throwing so a transient Storage outage never crashes
   * boot; the next `save()` surfaces the real error.
   */
  private async ensureSupabaseBucket(): Promise<void> {
    try {
      const client = this.getClient();
      const { error: getError } = await client.storage.getBucket(this.bucket);
      if (getError !== null) {
        const { error: createError } = await client.storage.createBucket(this.bucket, {
          public: false,
        });
        if (createError !== null && !/already|exists/i.test(createError.message)) {
          throw createError;
        }
      }
      if (this.prefix.length > 0) {
        const { data } = await client.storage.from(this.bucket).list(this.prefix, { limit: 1 });
        if (data === null || data.length === 0) {
          const { error: keepError } = await client.storage
            .from(this.bucket)
            .upload(`${this.prefix}/${PREFIX_KEEP_FILE}`, Buffer.from('', 'utf8'), {
              upsert: true,
              contentType: 'text/plain',
            });
          if (keepError !== null) {
            throw keepError;
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `Supabase storage provisioning skipped: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
