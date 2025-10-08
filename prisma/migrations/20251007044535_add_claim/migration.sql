/*
  Warnings:

  - You are about to drop the column `emailPublic` on the `Card` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Card" DROP COLUMN "emailPublic",
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByEmail" TEXT;
