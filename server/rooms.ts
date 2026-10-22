import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SqliteDb } from './database.js';

export type CallType = 'voice' | 'video';
export type RoomStatus = 'waiting' | 'connecting' | 'active' | 'ended';
export type Role = 'host' | 'guest';
export const LANGUAGES = {
  'hi-IN': { name: 'Hindi', translate: 'hi', stt: 'hi-IN' },
  'id-ID': { name: 'Indonesian', translate: 'id', stt: 'id-ID' },
  'en-US': { name: 'English (US)', translate: 'en', stt: 'en-US' }
} as const;
export type LanguageCode = keyof typeof LANGUAGES;

interface RoomRow {
  id: string; title: string; call_type: CallType; host_name: string; guest_name: string | null;
  host_language: LanguageCode; guest_language: LanguageCode;
  host_output_language: LanguageCode; guest_output_language: LanguageCode;
  status: RoomStatus; invite_hash: string; host_session_hash: string; guest_session_hash: string | null;
  created_at: number; expires_at: number; revoked_at: number | null;
}
export interface PublicRoom {
  id: string; title: string; callType: CallType; hostName: string; guestName: string | null;
  hostLanguage: LanguageCode; guestLanguage: LanguageCode;
  hostOutputLanguage: LanguageCode; guestOutputLanguage: LanguageCode;
  status: RoomStatus; expiresAt: number;
}
export interface CreateRoomInput {
  callType: CallType; title?: string; hostName?: string; hostLanguage: LanguageCode;
  guestLanguage: LanguageCode; hostOutputLanguage: LanguageCode; guestOutputLanguage: LanguageCode;
}
export interface Member { role: Role; room: PublicRoom }
export interface CreatedRoom { room: PublicRoom; sessionToken: string; inviteToken: string }

const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');
function matches(raw: string, digest: string): boolean {
  const a = Buffer.from(hash(raw), 'hex');
  const b = Buffer.from(digest, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function toPublic(row: RoomRow): PublicRoom {
  return {
    id: row.id, title: row.title, callType: row.call_type, hostName: row.host_name, guestName: row.guest_name,
    hostLanguage: row.host_language, guestLanguage: row.guest_language,
    hostOutputLanguage: row.host_output_language, guestOutputLanguage: row.guest_output_language,
    status: row.status, expiresAt: row.expires_at
  };
}

export class RoomStore {
  constructor(private readonly db: SqliteDb, private readonly now: () => number = Date.now) {}

  create(input: CreateRoomInput): CreatedRoom {
    const id = randomUUID();
    const inviteToken = secret();
    const sessionToken = secret();
    const createdAt = this.now();
    const expiresAt = createdAt + 24 * 60 * 60 * 1000;
    this.db.prepare('INSERT INTO rooms (id, title, call_type, host_name, host_language, guest_language, host_output_language, guest_output_language, status, invite_hash, host_session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title?.trim() || 'Private conversation', input.callType, input.hostName?.trim() || 'Host',
        input.hostLanguage, input.guestLanguage, input.hostOutputLanguage, input.guestOutputLanguage,
        'waiting', hash(inviteToken), hash(sessionToken), createdAt, expiresAt);
    const room = this.getRow(id);
    if (!room) throw new Error('Room could not be created.');
    return { room: toPublic(room), sessionToken, inviteToken };
  }

  preview(id: string, inviteToken: string): PublicRoom | null {
    const row = this.getRow(id);
    return row && this.joinable(row, inviteToken) ? toPublic(row) : null;
  }

  join(id: string, inviteToken: string, guestName: string, guestLanguage: LanguageCode): { room: PublicRoom; sessionToken: string } | null {
    const sessionToken = secret();
    return this.db.transaction(() => {
      const row = this.getRow(id);
      if (!row || !this.joinable(row, inviteToken) || guestLanguage !== row.guest_language) return null;
      const result = this.db.prepare("UPDATE rooms SET guest_name = ?, guest_session_hash = ?, status = 'connecting' WHERE id = ? AND guest_session_hash IS NULL AND revoked_at IS NULL AND expires_at > ? AND status = 'waiting'")
        .run(guestName.trim(), hash(sessionToken), id, this.now());
      if (result.changes !== 1) return null;
      const updated = this.getRow(id);
      return updated ? { room: toPublic(updated), sessionToken } : null;
    })();
  }

  member(id: string, token: string | undefined): Member | null {
    if (!token) return null;
    const row = this.getRow(id);
    if (!row || row.expires_at <= this.now() || row.status === 'ended') return null;
    if (matches(token, row.host_session_hash)) return { role: 'host', room: toPublic(row) };
    if (row.guest_session_hash && matches(token, row.guest_session_hash)) return { role: 'guest', room: toPublic(row) };
    return null;
  }

  setActive(id: string): void {
    this.db.prepare("UPDATE rooms SET status = 'active' WHERE id = ? AND status IN ('waiting', 'connecting')").run(id);
  }

  revoke(id: string, hostToken: string | undefined): boolean {
    const member = this.member(id, hostToken);
    if (!member || member.role !== 'host') return false;
    this.db.prepare('UPDATE rooms SET revoked_at = ? WHERE id = ? AND guest_session_hash IS NULL').run(this.now(), id);
    return true;
  }

  end(id: string, token: string | undefined): boolean {
    if (!this.member(id, token)) return false;
    this.db.prepare("UPDATE rooms SET status = 'ended', revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(this.now(), id);
    return true;
  }

  expire(): number {
    return this.db.prepare("UPDATE rooms SET status = 'ended', revoked_at = COALESCE(revoked_at, ?) WHERE status <> 'ended' AND expires_at <= ?")
      .run(this.now(), this.now()).changes;
  }

  private joinable(row: RoomRow, inviteToken: string): boolean {
    return Boolean(inviteToken) && row.status === 'waiting' && row.guest_session_hash === null &&
      row.revoked_at === null && row.expires_at > this.now() && matches(inviteToken, row.invite_hash);
  }

  private getRow(id: string): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
  }
}

export function sessionCookieName(roomId: string): string {
  return 'room_' + roomId.replaceAll('-', '');
}