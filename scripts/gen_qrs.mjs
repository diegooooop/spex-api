/**
 * SPEX – Universal QR Generator (Claim + Profile)
 * - Reads all cards (claimed or not) from DB
 * - Emits:
 *    ./vcard_qrs/<uid>.vcf          (if claimed)
 *    ./vcard_qrs/<uid>.png          (vCard QR – offline Add Contact)
 *    ./vcard_qrs/<uid>-url.png      (URL QR – claim or microsite)
 *
 * Usage:
 *   node scripts/gen_qrs.mjs
 *
 * Env:
 *   FRONTEND_BASE="https://www.spexcard.com"
 *   PROFILE_ROUTE="/u"
 *   CLAIM_ROUTE="/claim"
 *   VCARD_OUT_DIR="./vcard_qrs"
 */

import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import QRCode from "qrcode";

const prisma = new PrismaClient();

// ---- Config ----
const FRONTEND_BASE =
  (process.env.FRONTEND_BASE || "http://localhost:3000").replace(/\/$/, "");
const PROFILE_ROUTE = process.env.PROFILE_ROUTE || "/u";      // e.g., /u
const CLAIM_ROUTE = process.env.CLAIM_ROUTE || "/claim";      // e.g., /claim
const OUT_DIR = process.env.VCARD_OUT_DIR || "./vcard_qrs";

// ---- Helpers ----
function vEscape(s = "") {
  // Escape commas, semicolons, and newlines per vCard 3.0
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n|\r\n?/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Build a vCard 3.0 string from a Card row */
function buildVCard(card) {
  const name = (card.name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vEscape(last)};${vEscape(first)};;;`,
    `FN:${vEscape(name)}`,
  ];

  if (card.company) lines.push(`ORG:${vEscape(card.company)}`);
  if (card.title) lines.push(`TITLE:${vEscape(card.title)}`);
  if (card.mobile) lines.push(`TEL;TYPE=CELL,VOICE:${vEscape(card.mobile)}`);
  if (card.phone) lines.push(`TEL;TYPE=WORK,VOICE:${vEscape(card.phone)}`);
  if (card.email) lines.push(`EMAIL;TYPE=INTERNET:${vEscape(card.email)}`);
  if (card.website) lines.push(`URL:${vEscape(card.website)}`);
  if (card.address) lines.push(`ADR;TYPE=WORK:;;${vEscape(card.address)};;;;`);

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

/** Build the URL for QR: claimed → PROFILE_ROUTE?uid=..., unclaimed → CLAIM_ROUTE?uid=... */
function buildCardUrl(uid, { claimed }) {
  const route = claimed ? PROFILE_ROUTE : CLAIM_ROUTE;
  return `${FRONTEND_BASE}${route}?uid=${encodeURIComponent(uid)}`;
}

async function qrToFile(path, text) {
  await QRCode.toFile(path, text, {
    type: "png",
    margin: 2,
    scale: 8,
    errorCorrectionLevel: "Q",
    color: { dark: "#000000", light: "#FFFFFF" },
  });
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  console.log("📦 Fetching all cards from database...");
  const cards = await prisma.card.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      uid: true,
      name: true,
      company: true,
      title: true,
      mobile: true,
      phone: true,
      email: true,
      website: true,
      address: true,
      imageUrl: true,
    },
  });

  if (!cards.length) {
    console.log("⚠️ No cards found in DB.");
    return;
  }

  console.log(`🪪 Generating ${cards.length} QR sets...`);
  console.log(
    `🔧 Config → FRONTEND_BASE=${FRONTEND_BASE}, PROFILE_ROUTE=${PROFILE_ROUTE}, CLAIM_ROUTE=${CLAIM_ROUTE}, OUT_DIR=${OUT_DIR}`
  );

  for (const c of cards) {
    const fileBase = `${OUT_DIR}/${c.uid}`;

    // Consider "claimed" if any identity field is present
    const isClaimed = !!(
      c.name || c.mobile || c.email || c.company || c.title || c.imageUrl
    );

    // URL QR
    const url = buildCardUrl(c.uid, { claimed: isClaimed });
    await qrToFile(`${fileBase}-url.png`, url);

    // If claimed, produce vCard file + vCard QR
    if (isClaimed) {
      const vcard = buildVCard(c);
      writeFileSync(`${fileBase}.vcf`, vcard, "utf8");
      await qrToFile(`${fileBase}.png`, vcard);
      console.log(`✅ ${c.uid}: Claimed → vCard + URL QR (${url})`);
    } else {
      console.log(`🕓 ${c.uid}: Unclaimed → URL QR only (${url})`);
    }
  }

  console.log(`\n✨ Done! Files in ${OUT_DIR}/`);
}

main()
  .catch((err) => {
    console.error("❌ Error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
