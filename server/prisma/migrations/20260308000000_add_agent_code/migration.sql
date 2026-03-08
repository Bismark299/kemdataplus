-- AlterTable
ALTER TABLE "users" ADD COLUMN "agentCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_agentCode_key" ON "users"("agentCode");
