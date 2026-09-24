CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT NOT NULL,        -- lowercased address
  from_domain TEXT NOT NULL,       -- lowercased host part of the address
  subject TEXT,
  internal_date INTEGER NOT NULL,  -- ms since epoch
  size_estimate INTEGER NOT NULL,  -- bytes
  label_ids TEXT NOT NULL,         -- JSON array of Gmail label ids
  is_unread INTEGER NOT NULL,      -- 0/1
  is_trashed INTEGER NOT NULL DEFAULT 0,
  list_unsubscribe TEXT,
  list_unsubscribe_post TEXT
);
CREATE INDEX idx_messages_from_email ON messages(from_email);
CREATE INDEX idx_messages_from_domain ON messages(from_domain);
CREATE INDEX idx_messages_internal_date ON messages(internal_date);

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
