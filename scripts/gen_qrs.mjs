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
 */

import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import QRCode from "qrcode";

const prisma = new PrismaClient();

const FRONTEND_BASE =
  process.env.FRONTEND_BASE?.replace(/\/$/, "") || "http://localhost:3000";

/** Build a vCard 3.0 string from a Card row */
function buildVCard(card) {
  const parts = (card.name || "").trim().split(/\s+/);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";

  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${last};${first};;;`,
    `FN:${card.name || ""}`,
    card.company ? `ORG:${card.company}` : "",
    card.title ? `TITLE:${card.title}` : "",
    card.mobile ? `TEL;TYPE=CELL,VOICE:${card.mobile}` : "",
    card.phone ? `TEL;TYPE=WORK,VOICE:${card.phone}` : "",
    card.email ? `EMAIL;TYPE=INTERNET:${card.email}` : "",
    card.website ? `URL:${card.website}` : "",
    card.address ? `ADR;TYPE=WORK:;;${card.address};;;;` : "",
    "END:VCARD",
  ]
    .filter(Boolean)
    .join("\r\n");
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
  const outDir = "./vcard_qrs";
  if (!existsSync(outDir)) mkdirSync(outDir);

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
    process.exit(0);
  }

  console.log(`🪪 Generating ${cards.length} QR sets...`);

  for (const c of cards) {
    const fileBase = `${outDir}/${c.uid}`;

    const isClaimed = !!(
      c.name || c.mobile || c.email || c.company || c.title || c.imageUrl
    );

    // 🟢 Always make a URL QR
    const url = `${FRONTEND_BASE}/${c.uid}`;
    await qrToFile(`${fileBase}-url.png`, url);

    // 🔵 If claimed, make vCard + QR
    if (isClaimed) {
      const vcard = buildVCard(c);
      writeFileSync(`${fileBase}.vcf`, vcard, "utf8");
      await qrToFile(`${fileBase}.png`, vcard);
      console.log(`✅ ${c.uid}: Claimed → vCard + URL QR`);
    } else {
      console.log(`🕓 ${c.uid}: Unclaimed → URL QR only (auto-claim link)`);
    }
  }

  console.log(`\n✨ Done! Files in ${outDir}/`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("❌ Error:", err);
  await prisma.$disconnect();
  process.exit(1);
});
