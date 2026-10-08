import { Module } from '@nestjs/common';
import { RetrievalModule } from '../retrieval/retrieval.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/**
 * Public semantic search module (see ADR 0022).
 *
 * Exposes `GET /search` backed by `RetrievalService` (hybrid retrieval over
 * the RAG corpus) with products hydrated from SQL. Depends on
 * `RetrievalModule` for retrieval and on the global `InventoryService` /
 * `APP_CONFIG` — no provider SDK is ever imported here.
 */
@Module({
  imports: [RetrievalModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
