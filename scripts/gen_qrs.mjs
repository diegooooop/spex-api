/**
 * SPEX – Universal QR Generator (Microsite + vCard) with idempotency & robust vCard QR
 *
 * Emits per UID:
 *   <OUT_DIR>/<uid>-url.png   → QR to microsite (ALWAYS /u?uid=...)
 *   <OUT_DIR>/<uid>.vcf       → vCard (IF profile data exists)
 *   <OUT_DIR>/<uid>.png       → QR to vCard contents (IF profile data exists)
 *
 * Flags:
 *   --force     regenerate even if files exist
 *   --dry-run   show actions without writing
 *   --uid=...   process a single UID
 *
 * Usage:
 *   node --env-file=.env scripts/gen_qrs.mjs [--force] [--dry-run] [--uid=<UID>]
 */

import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import QRCode from "qrcode";

const prisma = new PrismaClient();

// ---- CLI flags ----
const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes("--force");
const DRY = ARGS.includes("--dry-run");
const UID_ARG = (ARGS.find(a => a.startsWith("--uid=")) || "").split("=")[1] || null;

// ---- Config ----
const FRONTEND_BASE =
  (process.env.FRONTEND_BASE || "http://localhost:3000").replace(/\/$/, "");
const PROFILE_ROUTE = process.env.PROFILE_ROUTE || "/u";
const OUT_DIR = process.env.VCARD_OUT_DIR || "./vcard_qrs";

// ---- Helpers ----
function vEscape(s = "") {
  // vCard 3.0 escaping: backslash, newline, comma, semicolon
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\n|\r/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Fold long lines per vCard 3.0 (<=70 chars, soft wrap with CRLF + space) */
function foldVCard(text) {
  const CRLF = "\r\n";
  return text
    .split(/\r\n|\n|\r/g)
    .map(line => {
      if (line.length <= 70) return line;
      let out = "";
      let rest = line;
      while (rest.length > 70) {
        out += rest.slice(0, 70) + CRLF + " ";
        rest = rest.slice(70);
      }
      return out + rest;
    })
    .join(CRLF);
}

/** Determine if we have enough data to build a useful vCard */
function hasProfileData(c) {
  return !!(
    c?.name || c?.mobile || c?.phone || c?.email ||
    c?.company || c?.title || c?.website || c?.address || c?.imageUrl
  );
}

/** Build a vCard 3.0 string (folded) from a Card row */
function buildVCard(card) {
  const name = (card.name || "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] || "";
  const last  = parts.length > 1 ? parts[parts.length - 1] : "";

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vEscape(last)};${vEscape(first)};;;`,
    `FN:${vEscape(name)}`,
  ];
  if (card.company) lines.push(`ORG:${vEscape(card.company)}`);
  if (card.title)   lines.push(`TITLE:${vEscape(card.title)}`);
  if (card.mobile)  lines.push(`TEL;TYPE=CELL,VOICE:${vEscape(card.mobile)}`);
  if (card.phone)   lines.push(`TEL;TYPE=WORK,VOICE:${vEscape(card.phone)}`);
  if (card.email)   lines.push(`EMAIL;TYPE=INTERNET:${vEscape(card.email)}`);
  if (card.website) lines.push(`URL:${vEscape(card.website)}`);
  if (card.address) lines.push(`ADR;TYPE=WORK:;;${vEscape(card.address)};;;;`);
  lines.push("END:VCARD");

  // Ensure CRLF and fold long lines
  const raw = lines.join("\r\n");
  return foldVCard(raw);
}

/** Permanent microsite URL */
function buildMicrositeUrl(uid) {
  return `${FRONTEND_BASE}${PROFILE_ROUTE}?uid=${encodeURIComponent(uid)}`;
}

async function qrToFile(path, text) {
  if (DRY) return;
  await QRCode.toFile(path, text, {
    type: "png",
    margin: 4,                 // <- larger quiet zone for better decoding
    scale: 8,
    errorCorrectionLevel: "M", // <- slightly lower density than Q
    color: { dark: "#000000", light: "#FFFFFF" },
  });
}

function writeTextFile(path, contents, enc = "utf8") {
  if (DRY) return;
  writeFileSync(path, contents, enc);
}

async function main() {
  if (!existsSync(OUT_DIR) && !DRY) mkdirSync(OUT_DIR, { recursive: true });

  console.log(`🔧 OUT_DIR=${OUT_DIR} | FRONTEND_BASE=${FRONTEND_BASE} | PROFILE_ROUTE=${PROFILE_ROUTE}`);
  if (FORCE) console.log("⚠️  FORCE: overwrite existing files");
  if (DRY)   console.log("🧪 DRY-RUN: no files will be written");
  if (UID_ARG) console.log(`🎯 Single UID: ${UID_ARG}`);

  const where = UID_ARG ? { where: { uid: UID_ARG } } : {};
  const cards = await prisma.card.findMany({
    ...where,
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
    console.log(UID_ARG ? `⚠️ No card found for UID ${UID_ARG}.` : "⚠️ No cards found.");
    return;
  }

  let skippedAll = 0, wroteUrlQr = 0, wroteVcf = 0, wroteVcfQr = 0;

  for (const c of cards) {
    const uid = c.uid;
    const base = path.join(OUT_DIR, uid);
    const micrositePng = `${base}-url.png`;
    const vcfPath      = `${base}.vcf`;
    const vcardPng     = `${base}.png`;

    const haveProfile = hasProfileData(c);
    const url = buildMicrositeUrl(uid);

    const urlQrExists = existsSync(micrositePng);
    const vcfExists   = existsSync(vcfPath);
    const vcfQrExists = existsSync(vcardPng);

    const needsUrlQr = FORCE ? true : !urlQrExists;
    const needsVcf   = haveProfile && (FORCE ? true : !vcfExists);
    const needsVcfQr = haveProfile && (FORCE ? true : !vcfQrExists);

    if (!needsUrlQr && !needsVcf && !needsVcfQr) {
      skippedAll++; console.log(`⏭️  ${uid}: up-to-date, skipping`); continue;
    }

    if (needsUrlQr) {
      console.log(`🖨️  ${uid}: microsite QR → ${path.basename(micrositePng)} (${url})`);
      await qrToFile(micrositePng, url); wroteUrlQr++;
    } else {
      console.log(`✔️  ${uid}: microsite QR already exists`);
    }

    if (haveProfile) {
      if (needsVcf) {
        const vcard = buildVCard(c);
        console.log(`📝 ${uid}: vCard → ${path.basename(vcfPath)}`);
        writeTextFile(vcfPath, vcard); wroteVcf++;
      } else {
        console.log(`✔️  ${uid}: vCard file already exists`);
      }

      if (needsVcfQr) {
        const vcard = buildVCard(c);
        console.log(`🖨️  ${uid}: vCard QR → ${path.basename(vcardPng)}`);
        await qrToFile(vcardPng, vcard); wroteVcfQr++;
      } else if (!FORCE) {
        console.log(`✔️  ${uid}: vCard QR already exists`);
      }
    } else {
      console.log(`ℹ️  ${uid}: no profile data → vCard not generated`);
    }
  }

  console.log(`\n✨ Done! OUT_DIR=${OUT_DIR}`);
  console.log(`   Skipped up-to-date: ${skippedAll}`);
  console.log(`   Wrote microsite QR: ${wroteUrlQr}`);
  console.log(`   Wrote .vcf files : ${wroteVcf}`);
  console.log(`   Wrote vCard QRs  : ${wroteVcfQr}`);
}

main()
  .catch(err => {
    console.error("❌ Error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
