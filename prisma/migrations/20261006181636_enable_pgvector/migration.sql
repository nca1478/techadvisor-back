-- Enable pgvector for semantic search over the catalog (used from Fase 2).
-- Additive only: creates the extension if it is missing, removes nothing.
CREATE EXTENSION IF NOT EXISTS vector;
