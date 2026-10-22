import type { CreateRoomInput, Room, RoomData } from './types';

interface ErrorResponse { error?: { message?: string } }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const payload = await response.json() as T & ErrorResponse;
  if (!response.ok) throw new Error(payload.error?.message || 'The request could not be completed.');
  return payload;
}

const base = (roomId: string): string => '/api/rooms/' + encodeURIComponent(roomId);

export const api = {
  createRoom(input: CreateRoomInput) {
    return request<{ room: Room; inviteToken: string; aiAvailable: boolean; productName: string }>('/api/rooms', {
      method: 'POST', body: JSON.stringify(input)
    });
  },
  previewRoom(roomId: string, inviteToken: string) {
    return request<{ room: Room }>(base(roomId) + '/preview', {
      method: 'POST', body: JSON.stringify({ inviteToken })
    });
  },
  joinRoom(roomId: string, inviteToken: string, guestName: string, guestLanguage: string) {
    return request<{ room: Room; aiAvailable: boolean }>(base(roomId) + '/join', {
      method: 'POST', body: JSON.stringify({ inviteToken, guestName, guestLanguage })
    });
  },
  getRoom(roomId: string) {
    return request<RoomData>(base(roomId));
  },
  revokeInvitation(roomId: string) {
    return request<{ ok: boolean }>(base(roomId) + '/revoke', { method: 'POST', body: '{}' });
  },
  endRoom(roomId: string) {
    return request<{ ok: boolean }>(base(roomId) + '/end', { method: 'POST', body: '{}' });
  }
};

export function invitationUrl(roomId: string, token: string): string {
  const url = new URL('/room/' + encodeURIComponent(roomId), window.location.origin);
  url.hash = 'invite=' + encodeURIComponent(token);
  return url.toString();
}