import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { config } from './config.js';
import { openDatabase } from './database.js';
import {
  RoomStore, sessionCookieName,
  type LanguageCode, type Member, type Role
} from './rooms.js';
import {
  closeProviderClients, createRecognitionSession, googleProvidersConfigured,
  synthesizeSpeech, translateText, type RecognitionSession
} from './providers.js';

const app = express();
const server = createServer(app);
const db = openDatabase(config.databasePath);
const rooms = new RoomStore(db);
const clientsByRoom = new Map<string, Map<Role, WebSocket>>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], baseUri: ["'self'"], connectSrc: ["'self'", 'ws:', 'wss:'],
    fontSrc: ["'self'", 'data:'], imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'],
    objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    frameAncestors: ["'none'"]
  } },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '32kb' }));

interface RateEntry { start: number; count: number }
const rateEntries = new Map<string, RateEntry>();
function rateLimit(limit: number, windowMs: number) {
  return (req: Request, res: Response, next: express.NextFunction): void => {
    const now = Date.now();
    const route = typeof req.route?.path === 'string' ? req.route.path : req.path.split('/').slice(0, 3).join('/');
    const key = String(req.socket.remoteAddress || 'unknown') + ':' + route;
    const existing = rateEntries.get(key);
    const entry = !existing || now - existing.start >= windowMs ? { start: now, count: 0 } : existing;
    entry.count += 1;
    rateEntries.set(key, entry);
    if (entry.count > limit) {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Please wait and try again.' } });
      return;
    }
    next();
  };
}

function cookieValue(req: Request, roomId: string): string | undefined {
  const name = sessionCookieName(roomId);
  for (const cookie of req.headers.cookie?.split(';') || []) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
function setSessionCookie(res: Response, roomId: string, token: string): void {
  res.cookie(sessionCookieName(roomId), token, {
    httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict',
    path: '/api/rooms/' + roomId, maxAge: 24 * 60 * 60 * 1000
  });
}
function clearSessionCookie(res: Response, roomId: string): void {
  res.clearCookie(sessionCookieName(roomId), {
    httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/api/rooms/' + roomId
  });
}
function requireSameOrigin(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  try {
    const parsed = origin ? new URL(origin) : null;
    const expectedHost = config.appOrigin ? new URL(config.appOrigin).host : req.headers.host;
    if (!parsed || parsed.host !== expectedHost ||
        (config.nodeEnv === 'production' && parsed.protocol !== 'https:')) throw new Error();
    return true;
  } catch {
    res.status(403).json({ error: { code: 'origin_rejected', message: 'Request origin was not accepted.' } });
    return false;
  }
}
function iceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
  const result: Array<{ urls: string | string[]; username?: string; credential?: string }> = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (config.turn) result.push(config.turn);
  return result;
}
function authenticatedPayload(member: Member) {
  return { room: member.room, role: member.role, iceServers: iceServers(), aiAvailable: googleProvidersConfigured, productName: config.productName };
}
const language = z.enum(['hi-IN', 'id-ID', 'en-US']);
const createSchema = z.object({
  callType: z.enum(['voice', 'video']), title: z.string().trim().max(80).optional().default(''),
  hostName: z.string().trim().max(60).optional().default(''),
  hostLanguage: language, guestLanguage: language, hostOutputLanguage: language, guestOutputLanguage: language
}).refine((value) => value.hostLanguage !== value.guestLanguage, {
  message: 'Choose different spoken languages.', path: ['guestLanguage']
});
const previewSchema = z.object({ inviteToken: z.string().min(32).max(100) });
const joinSchema = z.object({
  inviteToken: z.string().min(32).max(100), guestName: z.string().trim().min(1).max(60), guestLanguage: language
});

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected', speechAndTranslationConfigured: googleProvidersConfigured, turnConfigured: Boolean(config.turn) });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});
app.post('/api/rooms', rateLimit(8, 60_000), (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Check the selected languages and call details.' } });
    return;
  }
  const created = rooms.create(parsed.data);
  setSessionCookie(res, created.room.id, created.sessionToken);
  res.status(201).json({ room: created.room, inviteToken: created.inviteToken, aiAvailable: googleProvidersConfigured, productName: config.productName });
});
app.post('/api/rooms/:id/preview', rateLimit(30, 60_000), (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const parsed = previewSchema.safeParse(req.body);
  const room = parsed.success ? rooms.preview(String(req.params.id), parsed.data.inviteToken) : null;
  if (!room) {
    res.status(404).json({ error: { code: 'invitation_invalid', message: 'This invitation is invalid, expired, or already used.' } });
    return;
  }
  res.json({ room });
});
app.post('/api/rooms/:id/join', rateLimit(12, 60_000), (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'invalid_request', message: 'Enter a display name and confirm the invited language.' } });
    return;
  }
  const joined = rooms.join(String(req.params.id), parsed.data.inviteToken, parsed.data.guestName, parsed.data.guestLanguage);
  if (!joined) {
    res.status(409).json({ error: { code: 'invitation_unavailable', message: 'This invitation is invalid, expired, or already used.' } });
    return;
  }
  setSessionCookie(res, String(req.params.id), joined.sessionToken);
  res.status(201).json({ room: joined.room, aiAvailable: googleProvidersConfigured });
});
app.get('/api/rooms/:id', (req, res) => {
  const member = rooms.member(String(req.params.id), cookieValue(req, String(req.params.id)));
  if (!member) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'This room session is no longer available.' } });
    return;
  }
  res.json(authenticatedPayload(member));
});
app.post('/api/rooms/:id/revoke', rateLimit(10, 60_000), (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  if (!rooms.revoke(String(req.params.id), cookieValue(req, String(req.params.id)))) {
    res.status(403).json({ error: { code: 'forbidden', message: 'Only the host can revoke this invitation.' } });
    return;
  }
  res.json({ ok: true });
});
app.post('/api/rooms/:id/end', rateLimit(20, 60_000), (req, res) => {
  if (!requireSameOrigin(req, res)) return;
  if (!rooms.end(String(req.params.id), cookieValue(req, String(req.params.id)))) {
    res.status(401).json({ error: { code: 'unauthorized', message: 'This room session is no longer available.' } });
    return;
  }
  clearSessionCookie(res, String(req.params.id));
  broadcast(String(req.params.id), { type: 'room-ended' });
  res.json({ ok: true });
});

function allowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const expectedHost = config.appOrigin ? new URL(config.appOrigin).host : host;
    return parsed.host === expectedHost && (config.nodeEnv !== 'production' || parsed.protocol === 'https:');
  } catch { return false; }
}
interface ClientMessage {
  type?: string;
  signal?: { kind?: string; data?: unknown };
  sampleRateHertz?: number;
  startedAt?: number;
}
function send(socket: WebSocket | undefined, payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function broadcast(roomId: string, payload: unknown): void {
  for (const socket of clientsByRoom.get(roomId)?.values() || []) send(socket, payload);
}
function peerSocket(roomId: string, role: Role): WebSocket | undefined {
  return clientsByRoom.get(roomId)?.get(role);
}
function startTranslation(
  roomId: string, role: Role, member: Member, socket: WebSocket,
  sampleRateHertz: number, speechStartedAt: () => number
): RecognitionSession {
  const source: LanguageCode = role === 'host' ? member.room.hostLanguage : member.room.guestLanguage;
  const target: LanguageCode = role === 'host' ? member.room.guestOutputLanguage : member.room.hostOutputLanguage;
  let queue = Promise.resolve();
  return createRecognitionSession(source, sampleRateHertz, (update) => {
    const finalizedAt = Date.now();
    const transcript = { type: 'transcript', id: update.id, sourceRole: role, sourceText: update.text, isFinal: update.isFinal };
    send(peerSocket(roomId, 'host'), transcript);
    send(peerSocket(roomId, 'guest'), transcript);
    if (!update.isFinal) return;
    const startedAt = speechStartedAt();
    queue = queue.then(async () => {
      const translationStart = Date.now();
      const translatedText = await translateText(update.text, source, target);
      const translationMs = Date.now() - translationStart;
      const synthesisStart = Date.now();
      const audio = await synthesizeSpeech(translatedText, target);
      const synthesisMs = Date.now() - synthesisStart;
      const utterance = {
        type: 'utterance', id: update.id, sourceRole: role, sourceText: update.text, translatedText,
        audioBase64: audio.toString('base64'),
        timing: {
          speechToFinalMs: startedAt ? Math.max(0, finalizedAt - startedAt) : null,
          translationMs, synthesisMs, fromFinalTranscriptMs: Date.now() - finalizedAt
        }
      };
      send(peerSocket(roomId, 'host'), utterance);
      send(peerSocket(roomId, 'guest'), utterance);
    }).catch((error: unknown) => {
      console.error('Translation segment failed:', error instanceof Error ? error.message : 'provider error');
      send(socket, { type: 'translation-error', message: 'A translated segment could not be delivered. The call is still connected.' });
    });
  }, (error) => {
    console.error('Speech recognition stream failed:', error.message);
    send(socket, { type: 'translation-error', message: 'Speech recognition is temporarily unavailable.' });
  });
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const match = url.pathname.match(/^\/api\/rooms\/([0-9a-f-]{36})\/socket$/i);
  if (!match || !allowedOrigin(request.headers.origin, request.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  const roomId = match[1];
  const cookie = (request.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(sessionCookieName(roomId) + '='));
  const member = rooms.member(roomId, cookie ? decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)) : undefined);
  if (!member) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    const group = clientsByRoom.get(roomId) || new Map<Role, WebSocket>();
    group.get(member.role)?.close(4001, 'Reconnected elsewhere');
    group.set(member.role, ws);
    clientsByRoom.set(roomId, group);
    const otherRole: Role = member.role === 'host' ? 'guest' : 'host';
    const other = group.get(otherRole);
    send(ws, { type: 'room-state', role: member.role, peerConnected: Boolean(other), aiAvailable: googleProvidersConfigured });
    if (other) {
      rooms.setActive(roomId);
      send(ws, { type: 'peer-joined', role: otherRole });
      send(other, { type: 'peer-joined', role: member.role });
    }
    wss.emit('connection', ws, request, roomId, member);
  });
});
wss.on('connection', (socket: WebSocket, _request: unknown, roomId: string, member: Member) => {
  let recognition: RecognitionSession | undefined;
  let sampleRateHertz = 16_000;
  let speechStarted = 0;
  let bytesThisSecond = 0;
  let windowStart = Date.now();
  const otherRole: Role = member.role === 'host' ? 'guest' : 'host';
  send(socket, {
    type: 'translation-status',
    available: googleProvidersConfigured,
    message: googleProvidersConfigured ? 'Translation is ready.' : 'Connect Google Cloud credentials to enable live captions and translated voice.'
  });

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!googleProvidersConfigured) return;
      const now = Date.now();
      if (now - windowStart >= 1000) { bytesThisSecond = 0; windowStart = now; }
      const audio = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data);
      bytesThisSecond += audio.byteLength;
      if (bytesThisSecond > 96_000) { socket.close(1008, 'Audio rate limit exceeded'); return; }
      if (!recognition) recognition = startTranslation(roomId, member.role, member, socket, sampleRateHertz, () => speechStarted);
      recognition.write(audio);
      return;
    }
    let message: ClientMessage;
    try { message = JSON.parse(data.toString()) as ClientMessage; } catch { return; }
    if (message.type === 'audio-config' && Number.isInteger(message.sampleRateHertz) &&
        message.sampleRateHertz && message.sampleRateHertz >= 8_000 && message.sampleRateHertz <= 48_000) {
      sampleRateHertz = message.sampleRateHertz;
      return;
    }
    if (message.type === 'speech-start') { speechStarted = Date.now(); return; }
    if (message.type === 'signal' && message.signal && ['offer', 'answer', 'ice'].includes(String(message.signal.kind))) {
      send(peerSocket(roomId, otherRole), { type: 'signal', signal: message.signal });
    }
  });
  socket.on('close', () => {
    recognition?.close();
    const group = clientsByRoom.get(roomId);
    if (group?.get(member.role) === socket) group.delete(member.role);
    if (group?.size === 0) clientsByRoom.delete(roomId);
    send(peerSocket(roomId, otherRole), { type: 'peer-left' });
  });
  socket.on('error', () => recognition?.close());
});

app.use(express.static(resolve(process.cwd(), 'dist/client')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
    return;
  }
  res.sendFile(resolve(process.cwd(), 'dist/client/index.html'), (error) => {
    if (error) next(error);
  });
});
app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  void _next;
  console.error('Request failed:', error instanceof Error ? error.message : 'unknown error');
  if (res.headersSent) return;
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong. Please try again.' } });
});

const serverHandle = server.listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'server_started', port: config.port, database: config.databasePath,
    googleConfigured: googleProvidersConfigured, productName: config.productName
  }));
});
const expiryTimer = setInterval(() => rooms.expire(), 60_000);

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ event: 'server_shutdown', signal }));
  clearInterval(expiryTimer);
  for (const group of clientsByRoom.values()) for (const socket of group.values()) socket.close(1001, 'Server shutting down');
  await new Promise<void>((done) => server.close(() => done()));
  await closeProviderClients();
  db.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

export { app, serverHandle };