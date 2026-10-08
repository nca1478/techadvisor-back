-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('SPEC_SHEET', 'MANUAL', 'FAQ', 'WARRANTY', 'REVIEW', 'POLICY');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "product_id" UUID,
    "category_id" UUID,
    "type" "DocumentType" NOT NULL,
    "title" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "source_url" VARCHAR(2048),
    "content_hash" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "product_id" UUID,
    "ord" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_product_id_idx" ON "documents"("product_id");

-- CreateIndex
CREATE INDEX "documents_category_id_idx" ON "documents"("category_id");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE INDEX "documents_locale_idx" ON "documents"("locale");

-- CreateIndex
CREATE INDEX "chunks_document_id_idx" ON "chunks"("document_id");

-- CreateIndex
CREATE INDEX "chunks_product_id_idx" ON "chunks"("product_id");

-- CreateIndex
CREATE INDEX "chunks_locale_idx" ON "chunks"("locale");

-- CreateIndex
CREATE INDEX "chunks_metadata_idx" ON "chunks" USING GIN ("metadata");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_document_id_ord_key" ON "chunks"("document_id", "ord");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
