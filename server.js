const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const SQLiteStore = require("connect-sqlite3")(session);
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "sunu-deal.db");
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, "uploads");

if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET doit être défini en production.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,
  location TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'Occasion',
  image TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  listing_id INTEGER NOT NULL,
  PRIMARY KEY(user_id, listing_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  listing_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE SET NULL
);
`);

app.disable("x-powered-by");
if (IS_PRODUCTION) app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use(session({
  store: new SQLiteStore({ db: "sessions.db", dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || "development-only-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PRODUCTION,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: IS_PRODUCTION ? "7d" : 0 }));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Format d'image non autorisé."));
    cb(null, true);
  }
});

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Connexion requise." });
  next();
}

function publicUser(id) {
  return db.prepare("SELECT id, name, email, phone, created_at FROM users WHERE id=?").get(id);
}

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.userId ? publicUser(req.session.userId) : null });
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password || password.length < 6)
      return res.status(400).json({ error: "Nom, email et mot de passe (6 caractères minimum) requis." });

    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      "INSERT INTO users(name,email,phone,password_hash) VALUES(?,?,?,?)"
    ).run(name.trim(), email.trim().toLowerCase(), phone || "", hash);

    req.session.userId = result.lastInsertRowid;
    res.json({ user: publicUser(result.lastInsertRowid) });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return res.status(409).json({ error: "Cet email est déjà utilisé." });
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email=?").get((email || "").trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password || "", user.password_hash)))
    return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  req.session.userId = user.id;
  res.json({ user: publicUser(user.id) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/listings", (req, res) => {
  const { q = "", category = "", location = "", min = 0, max = 999999999999, sort = "recent" } = req.query;
  let order = "l.created_at DESC";
  if (sort === "low") order = "l.price ASC";
  if (sort === "high") order = "l.price DESC";

  const rows = db.prepare(`
    SELECT l.*, u.name AS seller_name
    FROM listings l JOIN users u ON u.id=l.user_id
    WHERE (l.title LIKE @q OR l.description LIKE @q OR l.category LIKE @q)
      AND (@category='' OR l.category=@category)
      AND (@location='' OR l.location LIKE '%'||@location||'%')
      AND l.price >= @min AND l.price <= @max
    ORDER BY ${order}
  `).all({ q: `%${q}%`, category, location, min: Number(min)||0, max: Number(max)||999999999999 });
  res.json({ listings: rows });
});

app.get("/api/listings/:id", (req, res) => {
  const row = db.prepare(`
    SELECT l.*, u.name AS seller_name, u.phone AS seller_phone
    FROM listings l JOIN users u ON u.id=l.user_id WHERE l.id=?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Annonce introuvable." });
  res.json({ listing: row });
});

app.post("/api/listings", auth, upload.single("image"), (req, res) => {
  const { title, description, price, category, location, condition } = req.body;
  if (!title || !description || !category || !location)
    return res.status(400).json({ error: "Titre, description, catégorie et localisation requis." });

  const image = req.file ? `/uploads/${req.file.filename}` : null;
  const result = db.prepare(`
    INSERT INTO listings(user_id,title,description,price,category,location,condition,image)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(req.session.userId, title, description, Number(price)||0, category, location, condition || "Occasion", image);

  res.json({ id: result.lastInsertRowid });
});

app.put("/api/listings/:id", auth, upload.single("image"), (req, res) => {
  const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(req.params.id);
  if (!listing || listing.user_id !== req.session.userId)
    return res.status(403).json({ error: "Vous ne pouvez modifier que vos annonces." });

  const { title, description, price, category, location, condition } = req.body;
  let image = listing.image;
  if (req.file) image = `/uploads/${req.file.filename}`;

  db.prepare(`
    UPDATE listings SET title=?,description=?,price=?,category=?,location=?,condition=?,image=?
    WHERE id=?
  `).run(title, description, Number(price)||0, category, location, condition || "Occasion", image, req.params.id);

  res.json({ ok: true });
});

app.delete("/api/listings/:id", auth, (req, res) => {
  const listing = db.prepare("SELECT * FROM listings WHERE id=?").get(req.params.id);
  if (!listing || listing.user_id !== req.session.userId)
    return res.status(403).json({ error: "Action non autorisée." });
  db.prepare("DELETE FROM listings WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/favorites/:listingId", auth, (req, res) => {
  const exists = db.prepare("SELECT 1 FROM favorites WHERE user_id=? AND listing_id=?")
    .get(req.session.userId, req.params.listingId);
  if (exists) db.prepare("DELETE FROM favorites WHERE user_id=? AND listing_id=?").run(req.session.userId, req.params.listingId);
  else db.prepare("INSERT INTO favorites(user_id,listing_id) VALUES(?,?)").run(req.session.userId, req.params.listingId);
  res.json({ favorite: !exists });
});

app.get("/api/favorites", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, u.name AS seller_name
    FROM favorites f JOIN listings l ON l.id=f.listing_id
    JOIN users u ON u.id=l.user_id
    WHERE f.user_id=? ORDER BY l.created_at DESC
  `).all(req.session.userId);
  res.json({ listings: rows });
});

app.post("/api/messages", auth, (req, res) => {
  const { receiverId, listingId, body } = req.body;
  if (!receiverId || !body?.trim()) return res.status(400).json({ error: "Destinataire et message requis." });
  const result = db.prepare(`
    INSERT INTO messages(sender_id,receiver_id,listing_id,body) VALUES(?,?,?,?)
  `).run(req.session.userId, receiverId, listingId || null, body.trim());
  res.json({ id: result.lastInsertRowid });
});

app.get("/api/messages/:userId", auth, (req, res) => {
  const other = Number(req.params.userId);
  const rows = db.prepare(`
    SELECT m.*, s.name AS sender_name, r.name AS receiver_name
    FROM messages m
    JOIN users s ON s.id=m.sender_id JOIN users r ON r.id=m.receiver_id
    WHERE (m.sender_id=? AND m.receiver_id=?) OR (m.sender_id=? AND m.receiver_id=?)
    ORDER BY m.created_at ASC
  `).all(req.session.userId, other, other, req.session.userId);
  res.json({ messages: rows });
});

app.get("/api/my-listings", auth, (req, res) => {
  res.json({ listings: db.prepare("SELECT * FROM listings WHERE user_id=? ORDER BY created_at DESC").all(req.session.userId) });
});

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.message === "Format d'image non autorisé.") {
    return res.status(400).json({ error: err.message || "Fichier invalide." });
  }
  console.error(err);
  res.status(500).json({ error: "Erreur serveur." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Sunu Deal lancé sur le port ${PORT}`));
