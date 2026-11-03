// База Фриджа: встроенный SQLite из Node 22 (node:sqlite), один файл на диске.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY,            -- Telegram id
      first_name TEXT NOT NULL DEFAULT '',
      can_dm INTEGER NOT NULL DEFAULT 0, -- бот может писать человеку (нажал «Старт» или разрешил в мини-аппе)
      consent_at TEXT,                   -- когда дал согласие на обработку данных
      notify_on INTEGER NOT NULL DEFAULT 1,
      notify_days INTEGER NOT NULL DEFAULT 3,
      notify_time TEXT NOT NULL DEFAULT '09:00',
      onboarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fridges(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Наш холодильник',
      tpl TEXT,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS members(
      fridge_id INTEGER NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(fridge_id,user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS members_one_fridge ON members(user_id);
    CREATE TABLE IF NOT EXISTS invites(
      token TEXT PRIMARY KEY,
      fridge_id INTEGER NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_by INTEGER, used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fridge_id INTEGER NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
      name TEXT NOT NULL, e TEXT NOT NULL DEFAULT '📦', c TEXT NOT NULL DEFAULT 'other',
      exp TEXT, q REAL NOT NULL DEFAULT 1, u TEXT NOT NULL DEFAULT 'шт',
      added_by INTEGER, added TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS products_fridge ON products(fridge_id);
    CREATE TABLE IF NOT EXISTS asks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fridge_id INTEGER NOT NULL REFERENCES fridges(id) ON DELETE CASCADE,
      from_id INTEGER NOT NULL, to_ids TEXT NOT NULL,
      name TEXT NOT NULL, q REAL NOT NULL, u TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0, done_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS asks_fridge ON asks(fridge_id);
    CREATE TABLE IF NOT EXISTS outbox(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL, text TEXT NOT NULL, markup TEXT,
      dedup TEXT UNIQUE,
      tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT, failed TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_due ON outbox(sent_at, failed, next_at);
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

module.exports = { open };
