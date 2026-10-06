# 0008 — Catalog multilingual content: translation tables with default-locale fallback

Date: 2026-10-06
Status: accepted

## Context

The catalog (category names, product names/descriptions) must serve `es`
and `en` (configurable via `DEFAULT_LOCALE` / `SUPPORTED_LOCALES`) per
AGENTS.md §1, and the public endpoints accept a `locale` param. Candidate
strategies:

1. **Translation tables** (`category_translations`, `product_translations`).
2. **JSONB `translations` column** on each entity.
3. **One row per locale** (duplicated products).

## Decision

- **Option 1 (translation tables).** Base columns (`name`, `description`)
  hold the `DEFAULT_LOCALE` content and are never null, so the catalog
  works with zero translation rows. Each translation table has
  `UNIQUE(parent_id, locale)` plus an index on `locale`.
- **Brands are not translated** (proper names are locale-independent);
  only categories (`name`) and products (`name`, `description`) have
  translation tables.
- **Fallback rule (implemented in `CatalogService`):** resolve the
  requested `locale` (must match BCP 47 format; unknown/unsupported
  values fall back silently to `DEFAULT_LOCALE`), then use the
  translation row for that locale when present, else the base columns.
  Every response echoes the **resolved** `locale`, so the frontend knows
  which language it received.
- Search text (`q`) matches the base name **and** translated names, so
  a Spanish query finds a product whose base name is English.
- No new dependencies.

## Consequences

- Adding a language is `INSERT`s only (additive migration-free); missing
  translations degrade gracefully to the default language instead of
  404ing or returning nulls.
- Queries fetch translations with a single Prisma `include` (no N+1);
  locale filtering happens in the service, keeping the SQL simple.
- Full-text search with per-locale dictionaries (`tsvector`) is deferred
  to Fase 2 (retrieval), where the linguistic configuration is needed.
