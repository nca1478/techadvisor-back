import { randomBytes } from 'node:crypto';

/**
 * SKU/slug generation for back-office product creation (see ADR for the
 * manual `TA-` prefix vs the imported `SL-` seed prefix).
 *
 * - SKU is opaque and stable: `TA-` + 6 chars from an unambiguous alphabet
 *   (no `0/O/1/I`). Always starts with a letter and contains at least one
 *   digit so `isSkuLikeToken` keeps boosting exact matches.
 * - Slug is human-readable: `slugifyProductName(name)` + `-` + 4 base-36
 *   chars. Respects the shared `slugSchema` (`^[a-z0-9]+(-[a-z0-9]+)*$`,
 *   max 100).
 */

export const SKU_PREFIX = 'TA-';
const SKU_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SKU_RANDOM_LENGTH = 6;

const SLUG_SUFFIX_LENGTH = 4;
const SLUG_BASE_MAX = 60;

function randomChars(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function randomDigit(): string {
  return String(randomBytes(1)[0] % 10);
}

/** One random SKU candidate (no database check — see `AdminService`). */
export function generateSkuCandidate(): string {
  const tail = randomChars(SKU_ALPHABET, SKU_RANDOM_LENGTH);
  if (/\d/.test(tail)) return `${SKU_PREFIX}${tail}`;
  const pos = randomBytes(1)[0] % SKU_RANDOM_LENGTH;
  return `${SKU_PREFIX}${tail.slice(0, pos)}${randomDigit()}${tail.slice(pos + 1)}`;
}

/** `true` when `sku` matches the generation contract (used by tests). */
export function isGeneratedSku(sku: string): boolean {
  return new RegExp(`^${SKU_PREFIX}[A-Z0-9]{${String(SKU_RANDOM_LENGTH)}}$`).test(sku);
}

/** Normalizes a product name into a slug base (no uniqueness suffix). */
export function slugifyProductName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/g, '');
  return base === '' ? 'product' : base;
}

function randomSlugSuffix(): string {
  return randomBytes(3).toString('hex').slice(0, SLUG_SUFFIX_LENGTH).toLowerCase();
}

/** One random slug candidate for `name` (no database check). */
export function generateSlugCandidate(name: string): string {
  return `${slugifyProductName(name)}-${randomSlugSuffix()}`;
}
