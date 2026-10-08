import { Module } from '@nestjs/common';
import { AuthSecurityModule } from '../auth/auth-security.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminDocumentsController } from './documents/admin-documents.controller.js';
import { AdminDocumentsService } from './documents/admin-documents.service.js';
import { DocumentStorageService } from './documents/document-storage.service.js';

/**
 * Back-office writes (Fase 1, P1.7 — see ADR 0013). Imports
 * `OrdersModule` for the guarded `OrdersService.transitionOrder` (the
 * state machine stays enforced in one place); `InventoryService` is
 * global but stock adjustments live here because they must append the
 * `InventoryMovement` audit row in the same transaction.
 *
 * Corpus documents (P2.5, see ADR 0020) live here too: the
 * `AdminDocumentsController` under `/admin/documents` plus the local-disk
 * `DocumentStorageService`, backed by `IngestionModule` for the pipeline.
 */
@Module({
  imports: [AuthSecurityModule, OrdersModule, IngestionModule],
  controllers: [AdminController, AdminDocumentsController],
  providers: [AdminService, AdminDocumentsService, DocumentStorageService],
})
export class AdminModule {}
