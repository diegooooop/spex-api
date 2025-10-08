-- CreateTable
CREATE TABLE "Card" (
    "uid" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "company" TEXT,
    "title" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "emailPublic" TEXT,
    "website" TEXT,
    "address" TEXT,
    "socials" JSONB,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Card_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" SERIAL NOT NULL,
    "uid" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ua" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);
