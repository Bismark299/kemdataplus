CREATE TABLE "number_verification_submissions" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "submittedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "number_verification_submissions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "number_verification_submissions_submittedById_createdAt_idx"
    ON "number_verification_submissions"("submittedById", "createdAt");
CREATE INDEX "number_verification_submissions_status_createdAt_idx"
    ON "number_verification_submissions"("status", "createdAt");
CREATE INDEX "number_verification_submissions_batchId_idx"
    ON "number_verification_submissions"("batchId");

ALTER TABLE "number_verification_submissions"
    ADD CONSTRAINT "number_verification_submissions_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
