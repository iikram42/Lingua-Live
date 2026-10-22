import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from './database.js';
import { RoomStore } from './rooms.js';

const input = {
  callType: 'voice' as const, hostName: 'Asha', title: 'Language exchange',
  hostLanguage: 'hi-IN' as const, guestLanguage: 'id-ID' as const,
  hostOutputLanguage: 'id-ID' as const, guestOutputLanguage: 'hi-IN' as const
};

test('invitation is secret, single-use, and enforces the selected language', () => {
  const db = openDatabase(':memory:');
  const store = new RoomStore(db);
  const created = store.create(input);
  assert.equal(store.preview(created.room.id, 'wrong-secret'), null);
  assert.equal(store.preview(created.room.id, created.inviteToken)?.hostName, 'Asha');
  assert.equal(store.join(created.room.id, created.inviteToken, 'Budi', 'hi-IN'), null);
  const joined = store.join(created.room.id, created.inviteToken, 'Budi', 'id-ID');
  assert.ok(joined);
  assert.equal(joined.room.guestName, 'Budi');
  assert.equal(store.preview(created.room.id, created.inviteToken), null);
  assert.equal(store.join(created.room.id, created.inviteToken, 'Other', 'id-ID'), null);
  assert.equal(store.member(created.room.id, created.sessionToken)?.role, 'host');
  assert.equal(store.member(created.room.id, joined.sessionToken)?.role, 'guest');
  assert.equal(store.member(created.room.id, 'forged'), null);
  db.close();
});

test('revoked and expired invitations cannot be joined; cleanup ends expired rooms', () => {
  let now = 1_800_000_000_000;
  const db = openDatabase(':memory:');
  const store = new RoomStore(db, () => now);
  const created = store.create(input);
  assert.equal(store.revoke(created.room.id, created.sessionToken), true);
  assert.equal(store.preview(created.room.id, created.inviteToken), null);
  const second = store.create(input);
  now += 25 * 60 * 60 * 1000;
  assert.equal(store.preview(second.room.id, second.inviteToken), null);
  assert.equal(store.expire(), 2);
  db.close();
});