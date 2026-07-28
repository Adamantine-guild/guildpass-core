CREATE TYPE "AttendanceMethod" AS ENUM ('manual', 'qr', 'signed_message');

CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_attendance" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" "AttendanceMethod" NOT NULL,
    CONSTRAINT "event_attendance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "events_communityId_startsAt_idx"
    ON "events"("communityId", "startsAt");
CREATE UNIQUE INDEX "event_attendance_eventId_walletId_key"
    ON "event_attendance"("eventId", "walletId");
CREATE INDEX "event_attendance_walletId_checkedInAt_idx"
    ON "event_attendance"("walletId", "checkedInAt");

ALTER TABLE "events"
    ADD CONSTRAINT "events_communityId_fkey"
    FOREIGN KEY ("communityId") REFERENCES "Community"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_attendance"
    ADD CONSTRAINT "event_attendance_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_attendance"
    ADD CONSTRAINT "event_attendance_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "Wallet"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
