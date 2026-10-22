CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  call_type TEXT NOT NULL CHECK (call_type IN ('voice', 'video')),
  host_name TEXT NOT NULL,
  guest_name TEXT,
  host_language TEXT NOT NULL,
  guest_language TEXT NOT NULL,
  host_output_language TEXT NOT NULL,
  guest_output_language TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'connecting', 'active', 'ended')),
  invite_hash TEXT NOT NULL,
  host_session_hash TEXT NOT NULL,
  guest_session_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX rooms_expiration_idx ON rooms(expires_at);
CREATE INDEX rooms_status_idx ON rooms(status);