-- CreateEnum
CREATE TYPE "export_status" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "form_id" UUID NOT NULL,
    "requested_by" UUID,
    "format" VARCHAR(10) NOT NULL,
    "status" "export_status" NOT NULL DEFAULT 'pending',
    "filters_json" JSONB NOT NULL DEFAULT '{}',
    "s3_key" TEXT,
    "row_count" INTEGER,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exports_organization_id_created_at_idx" ON "exports"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
