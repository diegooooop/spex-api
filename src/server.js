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

/* ----------------------- 🔐 CORS CONFIG ----------------------- */
const allowedOrigins = [
  'https://spexcard.com',
  'https://www.spexcard.com',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server or same-origin
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key', 'Authorization', 'Cache-Control'],
  credentials: false,
  maxAge: 86400,
}));

app.options('*', cors()); // handle preflight globally
/* ------------------------------------------------------------- */

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const FRONTEND_BASE = process.env.FRONTEND_BASE || 'http://localhost:3000';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_KEY = process.env.ADMIN_KEY || 'diego';

// middleware
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true, limit: '6mb' }));
app.use(cookieParser());
app.use(morgan('tiny'));

// static uploads
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ---------- Helpers ----------
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY || key !== ADMIN_KEY)
    return res.status(401).json({ error: 'admin_only' });
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
  },
});
const fileFilter = (req, file, cb) => {
  const ok = /image\/(jpeg|jpg|png|webp|gif)/.test(file.mimetype);
  cb(ok ? null : new Error('invalid_file_type'), ok);
};
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // ✅ allow up to 5MB
});

/* ======================  vCard helpers  ====================== */
function hasProfileData(c) {
  return !!(
    c?.name || c?.mobile || c?.phone ||
    c?.emailPublic || c?.email || c?.company ||
    c?.title || c?.website || c?.address || c?.imageUrl
  );
}

function vcardFrom(card) {
  const parts = (card.name || '').trim().split(/\s+/);
  const first = parts[0] || '';
  const last  = parts.length > 1 ? parts[parts.length - 1] : '';
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
    'END:VCARD',
  ].filter(Boolean).join('\r\n');
}

/* =======================  Admin Routes  ====================== */
app.post('/api/admin/create-uid', requireAdmin, async (req, res) => {
  const uid = nanoid(10);
  await prisma.card.create({ data: { uid } });
  res.json({ uid });
});

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

app.get('/api/admin/cards', requireAdmin, async (req, res) => {
  const take = Math.min(Math.max(Number(req.query.take) || 100, 1), 500);
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  const [items, total] = await Promise.all([
    prisma.card.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        uid: true, createdAt: true, updatedAt: true,
        name: true, company: true, title: true,
        phone: true, mobile: true, email: true,
        website: true, address: true, socials: true, imageUrl: true,
        claimedAt: true,
      },
      take, skip,
    }),
    prisma.card.count(),
  ]);
  const rows = items.map(c => ({ ...c, claimed: !!c.claimedAt }));
  res.json({ total, rows, take, skip });
});

/* =======================  Public Routes  ===================== */
/** 
 * IMPORTANT: vCard route MUST be defined BEFORE the JSON route,
 * and the dot in ".vcf" must be escaped. Regex restricts UID.
 */
app.get('/api/card/:uid([A-Za-z0-9_-]{8,32})\\.vcf', async (req, res) => {
  const { uid } = req.params;
  const c = await prisma.card.findUnique({ where: { uid } });
  if (!c) return res.status(404).send('Not found');
  if (!hasProfileData(c)) return res.status(204).send(); // nothing to export

  const vcf = vcardFrom(c);
  res.set('Content-Type', 'text/vcard; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${uid}.vcf"`);
  res.send(vcf);
});

app.get('/api/card/:uid([A-Za-z0-9_-]{8,32})', async (req, res) => {
  const { uid } = req.params;
  const card = await prisma.card.findUnique({ where: { uid } });
  if (!card) return res.status(404).json({ error: 'not_found' });

  if (!card.claimedAt) {
    const claimToken = jwt.sign({ uid, purpose: 'claim' }, JWT_SECRET);
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
      imageUrl: card.imageUrl,
    },
  });
});

// Claim route
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
      claimedByEmail: emailForLogin ?? null,
    },
  });

  if (updated.count === 0)
    return res.status(409).json({ error: 'already_claimed' });

  const authToken = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '90d' });
  res.json({ uid, authToken });
});

// Owner Updates
app.put('/api/card/:uid([A-Za-z0-9_-]{8,32})', requireAuth, async (req, res) => {
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
      imageUrl: p.imageUrl ?? null,
    },
  });
  res.json({ ok: true });
});

// ============ Admin: read single card (no claim fields changed) ============
app.get('/api/admin/cards/:uid', requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const card = await prisma.card.findUnique({
    where: { uid },
    select: {
      uid: true, createdAt: true, updatedAt: true,
      name: true, company: true, title: true,
      phone: true, mobile: true, email: true,
      website: true, address: true, socials: true, imageUrl: true,
      claimedAt: true, claimedByEmail: true,
    },
  });
  if (!card) return res.status(404).json({ error: 'not_found' });
  res.json(card);
});

// ============ Admin: update profile fields only (do NOT change claim fields) ============
app.put('/api/admin/cards/:uid', requireAdmin, async (req, res) => {
  const { uid } = req.params;
  const p = req.body?.profile || {};

  // Whitelist only profile fields; DO NOT include claimedAt/claimedByEmail
  const data = {
    name: p.name ?? null,
    company: p.company ?? null,
    title: p.title ?? null,
    phone: p.phone ?? null,
    mobile: p.mobile ?? null,
    email: p.email ?? null,
    website: p.website ?? null,
    address: p.address ?? null,
    socials: p.socials ?? {},
    imageUrl: p.imageUrl ?? null,
  };

  try {
    const updated = await prisma.card.update({
      where: { uid },
      data,
      select: {
        uid: true, name: true, company: true, title: true,
        phone: true, mobile: true, email: true,
        website: true, address: true, socials: true, imageUrl: true,
        claimedAt: true, claimedByEmail: true, updatedAt: true,
      },
    });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: 'update_failed' });
  }
});


// Uploads & Analytics
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', maxMB: 5 });
      }
      if (err.message === 'invalid_file_type') {
        return res.status(400).json({ error: 'invalid_file_type' });
      }
      return res.status(400).json({ error: 'upload_failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const url = `${BASE_URL}/uploads/${req.file.filename}`;
    res.json({ url });
  });
});

app.post('/api/event', async (req, res) => {
  const { uid, kind, ua } = req.body || {};
  await prisma.event.create({
    data: { uid: uid || 'unknown', kind: kind || 'visit', ua, ip: req.ip },
  });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`✅ spex-api running on ${BASE_URL}`));
