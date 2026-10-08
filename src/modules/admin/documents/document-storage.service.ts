import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/app-config.module.js';
import type { AppConfig } from '../../../config/env.schema.js';

/** `<uuid>.bin`: the only filename shape this service ever reads. */
const STORAGE_KEY_PATTERN = /^[0-9a-fA-F-]{36}\.bin$/;

/**
 * Local-disk storage for admin-uploaded RAG sources (see ADR 0020).
 *
 * Layout: `<DOCUMENTS_DIR>/<documentId>.bin`. The filename is derived
 * from the document UUID — never from user input — so there is no path
 * traversal; `storageKey` values are validated against the UUID pattern
 * on read. No path is ever returned to clients (the key itself is
 * internal-only and absent from every DTO).
 */
@Injectable()
export class DocumentStorageService {
  private readonly dir: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.dir = isAbsolute(config.DOCUMENTS_DIR)
      ? config.DOCUMENTS_DIR
      : resolve(process.cwd(), config.DOCUMENTS_DIR);
  }

  /** Directory holding the source files (created lazily, for tests too). */
  directory(): string {
    return this.dir;
  }

  /** Persists raw bytes for a document; returns the internal storage key. */
  async save(documentId: string, raw: Buffer): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const key = `${documentId}.bin`;
    await writeFile(resolve(this.dir, key), raw);
    return key;
  }

  /** Reads stored bytes, or `null` when the file is gone. */
  async read(storageKey: string): Promise<Buffer | null> {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      return null;
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
    await unlink(resolve(this.dir, storageKey)).catch(() => undefined);
  }
}
