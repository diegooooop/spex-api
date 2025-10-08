/**
 * SPEX – Export QR Sheet (CSV)
 * Per row: uid, claimed, url, name, company, title, mobile, phone, email, website, address, vcard
 *
 * Usage:
 *   node scripts/export_qr_sheet.mjs
 *   FRONTEND_BASE=https://your-domain node scripts/export_qr_sheet.mjs
 */

import { PrismaClient } from "@prisma/client";
import { mkdirSync, existsSync, writeFileSync } from "fs";

const prisma = new PrismaClient();
const OUT_DIR = "./vcard_qrs";
const FRONTEND_BASE = (process.env.FRONTEND_BASE || "http://localhost:3000").replace(/\/$/, "");

function buildVCard(card) {
  const parts = (card.name || "").trim().split(/\s+/);
  const first = parts[0] || "";
  const last = parts.length > 1 ? parts.at(-1) : "";
  const email = card.email || "";

  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${last};${first};;;`,
    `FN:${card.name || ""}`,
    card.company ? `ORG:${card.company}` : "",
    card.title ? `TITLE:${card.title}` : "",
    card.mobile ? `TEL;TYPE=CELL,VOICE:${card.mobile}` : "",
    card.phone ? `TEL;TYPE=WORK,VOICE:${card.phone}` : "",
    email ? `EMAIL;TYPE=INTERNET:${email}` : "",
    card.website ? `URL:${card.website}` : "",
    card.address ? `ADR;TYPE=WORK:;;${card.address};;;;` : "",
    "END:VCARD",
  ].filter(Boolean).join("\r\n");
}

function toCsvRow(vals) {
  return vals
    .map((v) => {
      const s = (v ?? "").toString();
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",") + "\n";
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const rows = await prisma.card.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      uid: true, name: true, company: true, title: true,
      mobile: true, phone: true, email: true,
      website: true, address: true, imageUrl: true, claimedAt: true,
    },
  });

  const header = [
    "uid","claimed","url",
    "name","company","title","mobile","phone","email","website","address",
    "vcard"
  ];

  let csv = toCsvRow(header);

  for (const c of rows) {
    const claimed = !!c.claimedAt || !!(c.name || c.mobile || c.email || c.imageUrl);
    const url = `${FRONTEND_BASE}/${c.uid}`;
    const vcard = claimed ? buildVCard(c) : "";

    csv += toCsvRow([
      c.uid,
      claimed ? "yes" : "no",
      url,
      c.name || "",
      c.company || "",
      c.title || "",
      c.mobile || "",
      c.phone || "",
      c.email || "",
      c.website || "",
      c.address || "",
      vcard
    ]);
  }

  const out = `${OUT_DIR}/qr_sheet.csv`;
  writeFileSync(out, csv, "utf8");
  console.log(`✅ Wrote ${out} (${rows.length} rows)`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Export failed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
