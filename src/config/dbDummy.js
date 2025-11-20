// Pool Pro - Backend Scaffold (ES Module)
// --------------------------------------------------
// This single-file scaffold shows a professional Node.js + Express + MongoDB
// backend layout (ES modules). Use it as a starting point — split into files
// in a real repo. It includes:
// - Email/Password auth + JWT refresh tokens
// - OAuth via Passport (Google, Facebook, Apple) placeholders
// - OTP (SMS/email) verification hooks
// - Socket.IO realtime (match invites, presence, live-sync)
// - Pusher integration for mobile push notifications (Pusher Channels)
// - Zego token endpoint placeholder for live streaming
// - User, Profile, Friend, Match, Tournament models (Mongoose)
// - Example controllers, routes, services, middlewares
// - .env variables used are listed at top
// --------------------------------------------------

/*
ENVIRONMENT (.env)
PORT=4000
MONGO_URI=mongodb+srv://<user>:<pass>@cluster0.mongodb.net/poolpro?retryWrites=true&w=majority
JWT_SECRET=verysecret
JWT_REFRESH_SECRET=veryrefreshsecret
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=30d
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASS=secret
TWILIO_SID=your_twilio_sid
TWILIO_TOKEN=your_twilio_token
TWILIO_FROM=+1234567890
PUSHER_APP_ID=
PUSHER_KEY=
PUSHER_SECRET=
PUSHER_CLUSTER=
ZEGO_SERVER_SECRET=your_zego_server_secret
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----

Notes: Replace placeholders. For production, protect secrets in vault.
*/

// ---------------------------
// package.json (for reference)
// ---------------------------
/*
{
  "name": "pool-pro-backend",
  "type": "module",
  "scripts": {
    "start": "node ./src/index.js",
    "dev": "nodemon --watch src --exec node --experimental-specifier-resolution=node --input-type=module src/index.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.0",
    "express-rate-limit": "^6.6.0",
    "helmet": "^6.0.0",
    "jsonwebtoken": "^9.0.0",
    "mongoose": "^7.0.0",
    "nodemailer": "^6.9.0",
    "passport": "^0.6.0",
    "passport-facebook": "^3.0.0",
    "passport-google-oauth20": "^2.0.0",
    "passport-apple": "^1.0.0",
    "socket.io": "^4.7.0",
    "pusher": "^5.0.0",
    "axios": "^1.4.0",
    "uuid": "^9.0.0"
  }
}
*/

// ---------------------------
// Minimal single-file implementation
// ---------------------------

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { v4 as uuidv4 } from 'uuid';
import Pusher from 'pusher';

dotenv.config();

const {
  PORT = 4000,
  MONGO_URI,
  JWT_SECRET,
  JWT_REFRESH_SECRET,
  JWT_ACCESS_EXPIRES = '15m',
  JWT_REFRESH_EXPIRES = '30d',
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  PUSHER_APP_ID,
  PUSHER_KEY,
  PUSHER_SECRET,
  PUSHER_CLUSTER,
  ZEGO_SERVER_SECRET
} = process.env;

// ---------------------------
// Setup Pusher (used for mobile push & realtime triggers)
// ---------------------------
const pusher = new Pusher({
  appId: PUSHER_APP_ID || '',
  key: PUSHER_KEY || '',
  secret: PUSHER_SECRET || '',
  cluster: PUSHER_CLUSTER || 'mt1',
  useTLS: true
});

// ---------------------------
// Mongoose models
// ---------------------------

const { Schema, model } = mongoose;

const UserSchema = new Schema({
  email: { type: String, unique: true, sparse: true },
  phone: { type: String, unique: true, sparse: true },
  passwordHash: String,
  nickname: String,
  displayName: String,
  avatar: String,
  verified: { type: Boolean, default: false },
  roles: [String],
  online: { type: Boolean, default: false },
  lastSeen: Date,
  social: {
    googleId: String,
    facebookId: String,
    appleId: String
  },
  wallet: {
    balance: { type: Number, default: 0 },
    withdrawable: { type: Boolean, default: true }
  },
  stats: {
    rank: { type: String, default: 'Beginner' },
    score: { type: Number, default: 0 },
    totalWinnings: { type: Number, default: 0 },
    bestWinStreak: { type: Number, default: 0 },
    currentWinStreak: { type: Number, default: 0 },
    winRate: { type: Number, default: 0 },
    gamesWon: { type: Number, default: 0 },
    gamesLost: { type: Number, default: 0 },
    gamesDrawn: { type: Number, default: 0 },
    avgMatchDurationMinutes: { type: Number, default: 0 }
  },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [0, 0] } // [lng, lat]
  },
  createdAt: { type: Date, default: Date.now }
});

UserSchema.index({ location: '2dsphere' });

const OTPSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  to: String, // email or phone
  code: String,
  type: { type: String, enum: ['email', 'sms'] },
  used: { type: Boolean, default: false },
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const FriendSchema = new Schema({
  requester: { type: Schema.Types.ObjectId, ref: 'User' },
  recipient: { type: Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const MatchSchema = new Schema({
  players: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  status: { type: String, enum: ['waiting', 'active', 'finished', 'cancelled'], default: 'waiting' },
  winner: { type: Schema.Types.ObjectId, ref: 'User' },
  score: Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  startedAt: Date,
  endedAt: Date
});

const TournamentSchema = new Schema({
  name: String,
  organizer: { type: Schema.Types.ObjectId, ref: 'User' },
  startDate: Date,
  endDate: Date,
  entryFee: Number,
  participants: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});

const User = model('User', UserSchema);
const OTP = model('OTP', OTPSchema);
const Friend = model('Friend', FriendSchema);
const Match = model('Match', MatchSchema);
const Tournament = model('Tournament', TournamentSchema);

// ---------------------------
// Utilities: Mailer, JWT, OTP
// ---------------------------

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT) || 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_ACCESS_EXPIRES });
}
function signRefreshToken(payload) {
  return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: JWT_REFRESH_EXPIRES });
}

async function sendEmailOTP(to, code) {
  const info = await transporter.sendMail({
    from: SMTP_USER,
    to,
    subject: 'Your PoolPro verification code',
    text: `Your verification code: ${code}`
  });
  return info;
}

async function createAndSendOTP({ userId = null, to, type = 'email' }) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  const otp = await OTP.create({ userId, to, code, type, expiresAt });
  if (type === 'email') await sendEmailOTP(to, code);
  // For SMS: integrate Twilio here (left as placeholder)
  return otp;
}

async function verifyOTP({ to, code }) {
  const rec = await OTP.findOne({ to, code, used: false, expiresAt: { $gt: new Date() } });
  if (!rec) return null;
  rec.used = true;
  await rec.save();
  return rec;
}

// ---------------------------
// Middlewares
// ---------------------------

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------------------------
// Express App & Routes
// ---------------------------

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

// Basic health
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Auth routes -----------------------------------------------------------
app.post('/auth/register', async (req, res) => {
  try {
    const { email, phone, password, nickname } = req.body;
    if (!email && !phone) return res.status(400).json({ error: 'Email or phone required' });
    const existing = await User.findOne({ $or: [{ email }, { phone }] });
    if (existing) return res.status(409).json({ error: 'User exists' });
    const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;
    const user = await User.create({ email, phone, passwordHash, nickname, verified: false });
    // send verification OTP
    if (email) await createAndSendOTP({ userId: user._id, to: email, type: 'email' });
    if (phone) await createAndSendOTP({ userId: user._id, to: phone, type: 'sms' });
    res.json({ ok: true, userId: user._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body;
    const user = await User.findOne(email ? { email } : { phone });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (password) {
      const match = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
      if (!match) return res.status(403).json({ error: 'Invalid credentials' });
    }
    // create tokens
    const access = signAccessToken({ id: user._id });
    const refresh = signRefreshToken({ id: user._id });
    res.json({ access, refresh, user: { id: user._id, nickname: user.nickname, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/auth/refresh', async (req, res) => {
  const { refresh } = req.body;
  if (!refresh) return res.status(400).json({ error: 'Missing refresh token' });
  try {
    const decoded = jwt.verify(refresh, JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const access = signAccessToken({ id: user._id });
    res.json({ access });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// OTP verify
app.post('/auth/verify-otp', async (req, res) => {
  const { to, code } = req.body;
  const rec = await verifyOTP({ to, code });
  if (!rec) return res.status(400).json({ error: 'Invalid or expired code' });
  const user = rec.userId ? await User.findById(rec.userId) : await User.findOne({ $or: [{ email: to }, { phone: to }] });
  if (user) {
    user.verified = true;
    await user.save();
    return res.json({ ok: true, userId: user._id });
  }
  return res.status(404).json({ error: 'User not found' });
});

// Forgot password (send OTP)
app.post('/auth/forgot', async (req, res) => {
  const { to } = req.body;
  const user = await User.findOne({ $or: [{ email: to }, { phone: to }] });
  if (!user) return res.status(404).json({ error: 'User not found' });
  await createAndSendOTP({ userId: user._id, to, type: to.includes('@') ? 'email' : 'sms' });
  res.json({ ok: true });
});

// Reset password using OTP
app.post('/auth/reset', async (req, res) => {
  const { to, code, password } = req.body;
  const rec = await verifyOTP({ to, code });
  if (!rec) return res.status(400).json({ error: 'Invalid code' });
  const user = await User.findById(rec.userId);
  user.passwordHash = await bcrypt.hash(password, 12);
  await user.save();
  res.json({ ok: true });
});

// OAuth endpoints - placeholders
app.get('/auth/oauth/:provider/callback', (req, res) => {
  // Integrate Passport strategies for google/facebook/apple.
  res.json({ msg: 'Use Passport strategies to implement OAuth flows on server side.' });
});

// --- Profile & user routes -------------------------------------------------
app.get('/users/me', authMiddleware, async (req, res) => {
  const user = req.user;
  res.json({ user });
});

app.patch('/users/me', authMiddleware, async (req, res) => {
  const updates = req.body; // validate in production
  const allowed = ['nickname', 'displayName', 'avatar', 'location'];
  for (const k of Object.keys(updates)) if (!allowed.includes(k)) delete updates[k];
  Object.assign(req.user, updates);
  await req.user.save();
  // Send realtime update via Pusher
  try { pusher.trigger(`private-user-${req.user._id}`, 'profile-updated', { userId: req.user._id, updates }); } catch(e){/* ignore */}
  res.json({ ok: true, user: req.user });
});

// Friend request
app.post('/friends/request', authMiddleware, async (req, res) => {
  const { recipientId } = req.body;
  if (!recipientId) return res.status(400).json({ error: 'recipientId required' });
  const existing = await Friend.findOne({ requester: req.user._id, recipient: recipientId });
  if (existing) return res.status(400).json({ error: 'Already requested' });
  const fr = await Friend.create({ requester: req.user._id, recipient: recipientId });
  // real-time notify
  pusher.trigger(`private-user-${recipientId}`, 'friend-request', { from: req.user._id, frId: fr._id });
  res.json({ ok: true });
});

app.post('/friends/respond', authMiddleware, async (req, res) => {
  const { requestId, accept } = req.body;
  const fr = await Friend.findById(requestId);
  if (!fr) return res.status(404).json({ error: 'Not found' });
  if (String(fr.recipient) !== String(req.user._id)) return res.status(403).json({ error: 'Forbidden' });
  fr.status = accept ? 'accepted' : 'rejected';
  await fr.save();
  if (accept) {
    pusher.trigger(`private-user-${fr.requester}`, 'friend-accepted', { from: req.user._id });
  }
  res.json({ ok: true });
});

// Matches (create invite)
app.post('/matches/invite', authMiddleware, async (req, res) => {
  const { opponentId, meta } = req.body;
  const match = await Match.create({ players: [req.user._id, opponentId], status: 'waiting', score: {}, createdAt: new Date() });
  pusher.trigger(`private-user-${opponentId}`, 'match-invite', { matchId: match._id, from: req.user._id, meta });
  res.json({ ok: true, matchId: match._id });
});

app.post('/matches/respond', authMiddleware, async (req, res) => {
  const { matchId, accept } = req.body;
  const match = await Match.findById(matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (!match.players.map(p => String(p)).includes(String(req.user._id))) return res.status(403).json({ error: 'Not a participant' });
  if (accept) {
    match.status = 'active';
    match.startedAt = new Date();
    await match.save();
    // notify players
    for (const p of match.players) pusher.trigger(`private-user-${p}`, 'match-started', { matchId: match._id });
  } else {
    match.status = 'cancelled';
    await match.save();
    pusher.trigger(`private-user-${match.players[0]}`, 'match-declined', { matchId: match._id });
  }
  res.json({ ok: true });
});

// Tournament create (organizer)
app.post('/tournaments', authMiddleware, async (req, res) => {
  const { name, startDate, endDate, entryFee } = req.body;
  const t = await Tournament.create({ name, organizer: req.user._id, startDate, endDate, entryFee });
  res.json({ ok: true, tournament: t });
});

// Zego token endpoint placeholder — client will request token for live streaming
app.post('/zego/token', authMiddleware, async (req, res) => {
  const { userId = req.user._id, roomId } = req.body;
  // IMPORTANT: Implement Zego token creation server-side using ZEGO_SERVER_SECRET
  // This endpoint should return: { token: "...", userId, roomId }
  // For now return a placeholder
  return res.json({ token: 'ZEGO_TOKEN_PLACEHOLDER', userId, roomId });
});

// Notifications: example to trigger push via Pusher
app.post('/notify/test', authMiddleware, async (req, res) => {
  const { toUserId, event, payload } = req.body;
  await pusher.trigger(`private-user-${toUserId}`, event || 'test', payload || {});
  res.json({ ok: true });
});

// Search nearest online players (using geospatial index)
app.get('/players/nearby', authMiddleware, async (req, res) => {
  const { lng, lat, maxDistanceMeters = 5000 } = req.query;
  if (!lng || !lat) return res.status(400).json({ error: 'lng & lat required' });
  const players = await User.find({
    online: true,
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [Number(lng), Number(lat)] },
        $maxDistance: Number(maxDistanceMeters)
      }
    }
  }).limit(50).select('nickname avatar stats location online');
  res.json({ players });
});

// ---------------------------
// Socket.IO: realtime syncing
// ---------------------------

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication error'));
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = await User.findById(decoded.id);
    return next();
  } catch (err) { return next(new Error('Authentication error')); }
});

io.on('connection', (socket) => {
  const user = socket.user;
  socket.join(`user-${user._id}`);
  user.online = true;
  user.lastSeen = new Date();
  user.save().catch(console.error);

  socket.emit('connected', { userId: user._id });

  socket.on('presence:update', async (payload) => {
    // payload: { lat, lng }
    try {
      if (payload?.lat && payload?.lng) {
        user.location = { type: 'Point', coordinates: [payload.lng, payload.lat] };
        await user.save();
      }
      socket.broadcast.emit('user:presence', { userId: user._id, online: true, location: user.location });
    } catch (e) { console.error(e); }
  });

  socket.on('match:score', async ({ matchId, score }) => {
    const match = await Match.findById(matchId);
    if (!match) return;
    match.score = score;
    await match.save();
    // broadcast inside match room
    io.to(`match-${matchId}`).emit('match:score', { matchId, score });
  });

  socket.on('join:match', ({ matchId }) => {
    socket.join(`match-${matchId}`);
  });

  socket.on('disconnect', async () => {
    user.online = false;
    user.lastSeen = new Date();
    await user.save().catch(console.error);
    socket.broadcast.emit('user:presence', { userId: user._id, online: false });
  });
});

// ---------------------------
// DB Connect + Launch
// ---------------------------

async function start() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log('Mongo connected');
    server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
  } catch (err) {
    console.error('Failed to start', err);
    process.exit(1);
  }
}

start();

// ---------------------------
// Final notes (read me)
// ---------------------------
/*
1) Split this file into routes, controllers, models, services.
2) Add validations (Joi/Zod) to all endpoints.
3) Use HTTPS, helmet, rate-limiting, strong CORS.
4) For OAuth: configure Passport strategies and callbacks.
5) Integrate Twilio for SMS OTP (use TWILIO env vars). For production, store OTPs hashed.
6) Use Pusher Beams for mobile push notifications or FCM via server-side.
7) Implement Zego server-side token generation per Zego docs using ZEGO_SERVER_SECRET — return short-lived tokens.
8) Add payments (Stripe/PayPal) for entry fees and wallet.
9) Add logging (winston) and metrics.
10) Deploy: use PM2 or containerize with Docker and set up staging/prod envs.

Client (Flutter) expectations:
- Use JWT access + refresh flow. Access in Authorization header.
- For realtime: connect Socket.IO with { auth: { token }}. Listen to private channels from Pusher for push notifications.
- Use Zego SDK on client; call /zego/token to get token before joining live room.
- Use Google Maps SDK on client; send location updates to /players/nearby and via socket presence:update.
*/


