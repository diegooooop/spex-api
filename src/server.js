import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const FRONTEND_BASE = process.env.FRONTEND_BASE || 'http://localhost:3000';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// middleware
app.use(cors({
  origin: [FRONTEND_BASE, 'http://localhost:3000'],
  credentials: false
}));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('tiny'));

// static uploads
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ---------- Helpers ----------

function requireAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY)
    return res.status(401).json({ error: "admin_only" });
  next();
}

function requireAuth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'bad_token' });
  }
}

// uploads (multer → local disk)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${nanoid(8)}${ext}`);
  }
});
const fileFilter = (req, file, cb) => {
  const ok = /image\/(jpeg|jpg|png|webp|gif)/.test(file.mimetype);
  cb(ok ? null : new Error('invalid_file_type'), ok);
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }
}); // 2MB limit

// ---------- Admin Routes ----------

// create one UID
app.post('/api/admin/create-uid', requireAdmin, async (req, res) => {
  const uid = nanoid(10);
  await prisma.card.create({ data: { uid } });
  res.json({ uid });
});

// bulk create UIDs
app.post('/api/admin/create-uids', requireAdmin, async (req, res) => {
  const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 200);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const uid = nanoid(10);
    await prisma.card.create({ data: { uid } });
    rows.push({ uid });
  }
  res.json({ ok: true, rows });
});

// list cards
app.get("/api/admin/cards", requireAdmin, async (req, res) => {
  const take = Math.min(Math.max(Number(req.query.take) || 100, 1), 500);
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  const [items, total] = await Promise.all([
    prisma.card.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        uid: true, createdAt: true, updatedAt: true,
        name: true, company: true, title: true,
        phone: true, mobile: true, email: true,
        website: true, address: true, socials: true, imageUrl: true,
        claimedAt: true
      },
      take, skip
    }),
    prisma.card.count()
  ]);
  const rows = items.map(c => ({ ...c, claimed: !!c.claimedAt }));
  res.json({ total, rows, take, skip });
});

// ---------- Public Routes ----------

// 🆕 GET /api/card/:uid — auto-claim support
app.get('/api/card/:uid', async (req, res) => {
  const { uid } = req.params;
  const card = await prisma.card.findUnique({ where: { uid } });
  if (!card) return res.status(404).json({ error: 'not_found' });

  const claimed = !!card.claimedAt;

  if (!claimed) {
    const claimToken = jwt.sign(
      { uid, purpose: 'claim' },
      JWT_SECRET,
    );
    return res.json({ uid, claimed: false, claimToken });
  }

  res.json({
    uid,
    claimed: true,
    profile: {
      name: card.name,
      company: card.company,
      title: card.title,
      phone: card.phone,
      mobile: card.mobile,
      email: card.email,
      website: card.website,
      address: card.address,
      socials: card.socials || {},
      imageUrl: card.imageUrl
    }
  });
});

// 🆕 POST /api/card/claim — atomic first-claim
app.post('/api/card/claim', async (req, res) => {
  const { uid, claimToken, profile, emailForLogin } = req.body || {};
  if (!uid || !claimToken)
    return res.status(400).json({ error: 'missing_params' });

  try {
    const payload = jwt.verify(claimToken, JWT_SECRET);
    if (payload.purpose !== 'claim' || payload.uid !== uid)
      return res.status(400).json({ error: 'invalid_token' });
  } catch {
    return res.status(401).json({ error: 'token_expired_or_invalid' });
  }

  // atomic update: only update if not yet claimed
  const updated = await prisma.card.updateMany({
    where: { uid, claimedAt: null },
    data: {
      name: profile?.name ?? null,
      company: profile?.company ?? null,
      title: profile?.title ?? null,
      phone: profile?.phone ?? null,
      mobile: profile?.mobile ?? null,
      email: profile?.email ?? null,
      website: profile?.website ?? null,
      address: profile?.address ?? null,
      socials: profile?.socials ?? {},
      imageUrl: profile?.imageUrl ?? null,
      claimedAt: new Date(),
      claimedByEmail: emailForLogin ?? null
    }
  });

  if (updated.count === 0)
    return res.status(409).json({ error: 'already_claimed' });

  const authToken = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ uid, authToken });
});

// 🆕 GET /api/card/:uid.vcf — downloadable contact
function hasProfileData(c) {
  return !!(
    c?.name ||
    c?.mobile ||
    c?.phone ||
    c?.emailPublic ||
    c?.email ||
    c?.company ||
    c?.title ||
    c?.website ||
    c?.address ||
    c?.imageUrl
  );
}
function vcardFrom(card) {
  const parts = (card.name || '').trim().split(/\s+/);
  const first = parts[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  const email = card.emailPublic || card.email || '';

  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${last};${first};;;`,
    `FN:${card.name || ''}`,
    card.company ? `ORG:${card.company}` : '',
    card.title ? `TITLE:${card.title}` : '',
    card.mobile ? `TEL;TYPE=CELL,VOICE:${card.mobile}` : '',
    card.phone ? `TEL;TYPE=WORK,VOICE:${card.phone}` : '',
    email ? `EMAIL;TYPE=INTERNET:${email}` : '',
    card.website ? `URL:${card.website}` : '',
    card.address ? `ADR;TYPE=WORK:;;${card.address};;;;` : '',
    'END:VCARD'
  ].filter(Boolean).join('\r\n');
}

app.get('/api/card/:uid.vcf', async (req, res) => {
  const { uid } = req.params;
  const c = await prisma.card.findUnique({ where: { uid } });
  if (!c) return res.status(404).send('Not found');

  // allow vCard for unclaimed cards if there is prefilled data
  if (!hasProfileData(c)) {
    // nothing meaningful to share yet (avoid blank vcf)
    return res.status(204).send(); // No Content
  }

  const vcf = vcardFrom(c);
  res.set('Content-Type', 'text/vcard; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${uid}.vcf"`);

  // Optional: long cache for clients (you can tweak or remove)
  // res.set('Cache-Control', 'public, max-age=86400');

  res.send(vcf);
});

// ---------- Owner Updates ----------

app.put('/api/card/:uid', requireAuth, async (req, res) => {
  if (req.user.uid !== req.params.uid)
    return res.status(403).json({ error: 'forbidden' });
  const p = req.body?.profile || {};
  await prisma.card.update({
    where: { uid: req.params.uid },
    data: {
      name: p.name ?? null,
      company: p.company ?? null,
      title: p.title ?? null,
      phone: p.phone ?? null,
      mobile: p.mobile ?? null,
      email: p.email ?? null,
      website: p.website ?? null,
      address: p.address ?? null,
      socials: p.socials ?? {},
      imageUrl: p.imageUrl ?? null
    }
  });
  res.json({ ok: true });
});

// ---------- Uploads & Analytics ----------

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  // relative URL → Next.js rewrite will proxy /uploads/* to the API
 const url = `${BASE_URL}/uploads/${req.file.filename}`;
 res.json({ url });
});

app.post('/api/event', async (req, res) => {
  const { uid, kind, ua } = req.body || {};
  await prisma.event.create({
    data: { uid: uid || 'unknown', kind: kind || 'visit', ua, ip: req.ip }
  });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`spex-api listening on ${BASE_URL}`));
