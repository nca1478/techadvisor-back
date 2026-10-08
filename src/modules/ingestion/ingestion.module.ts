import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/app-config.module.js';
import type { AppConfig } from '../../config/env.schema.js';
import { AiModule } from '../ai/ai.module.js';
import { DocumentExtractorService } from './document-extractor.service.js';
import { INGESTION_QUEUE } from './ingestion.constants.js';
import { createIngestionQueue } from './ingestion.queue.js';
import { IngestionService } from './ingestion.service.js';
import { ProductSpecSheetService } from './product-spec-sheet.service.js';

/**
 * RAG ingestion module (see ADR 0019).
 *
 * Owns the `ingestion` BullMQ queue, the extraction/cleaning/chunking
 * pipeline (`IngestionService`) and the product SPEC_SHEET auto-ingest
 * (`ProductSpecSheetService`). Imported by `AppModule` (the API only
 * enqueues) and by the standalone worker bootstrap. Exports the services
 * plus the queue token so `AdminModule` can hook product writes.
 */
@Module({
  imports: [AiModule],
  providers: [
    DocumentExtractorService,
    IngestionService,
    ProductSpecSheetService,
    {
      provide: INGESTION_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createIngestionQueue(config),
    },
  ],
  exports: [IngestionService, ProductSpecSheetService, INGESTION_QUEUE],
})
export class IngestionModule {}
