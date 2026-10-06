-- CreateTable
CREATE TABLE "inventory" (
    "product_id" UUID NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("product_id")
);

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Domain invariants (Prisma has no native CHECK support, so raw SQL).
-- Belt and braces behind the conditional UPDATEs in InventoryService:
-- even a buggy writer can never leave negative or over-reserved stock.
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_stock_non_negative" CHECK ("stock" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_non_negative" CHECK ("reserved" >= 0);
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_reserved_within_stock" CHECK ("reserved" <= "stock");
