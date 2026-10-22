export type LanguageCode = 'hi-IN' | 'id-ID' | 'en-US';
export type CallType = 'voice' | 'video';
export type Role = 'host' | 'guest';
export type RoomStatus = 'waiting' | 'connecting' | 'active' | 'ended';

export interface Room {
  id: string;
  title: string;
  callType: CallType;
  hostName: string;
  guestName: string | null;
  hostLanguage: LanguageCode;
  guestLanguage: LanguageCode;
  hostOutputLanguage: LanguageCode;
  guestOutputLanguage: LanguageCode;
  status: RoomStatus;
  expiresAt: number;
}

export const LANGUAGES: ReadonlyArray<{ code: LanguageCode; name: string }> = [
  { code: 'hi-IN', name: 'Hindi' },
  { code: 'id-ID', name: 'Indonesian' },
  { code: 'en-US', name: 'English (US)' }
];

export function languageName(code: LanguageCode): string {
  return LANGUAGES.find((language) => language.code === code)?.name || code;
}

export interface CreateRoomInput {
  callType: CallType;
  title: string;
  hostName: string;
  hostLanguage: LanguageCode;
  guestLanguage: LanguageCode;
  hostOutputLanguage: LanguageCode;
  guestOutputLanguage: LanguageCode;
}

export interface RoomData {
  room: Room;
  role: Role;
  iceServers: RTCIceServer[];
  aiAvailable: boolean;
  productName: string;
}