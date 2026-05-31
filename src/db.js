const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const databasePath = process.env.DATABASE_PATH || "./data/learning-lane.sqlite";
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON");

function ensureDatabase() {
  db.exec(`
    create table if not exists users (
      id integer primary key,
      google_id text unique not null,
      email text unique not null,
      name text not null,
      avatar_url text,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );

    create table if not exists families (
      id integer primary key,
      name text not null,
      creator_user_id integer not null references users(id),
      created_at text not null default current_timestamp
    );

    create table if not exists family_members (
      id integer primary key,
      family_id integer not null references families(id) on delete cascade,
      user_id integer not null references users(id) on delete cascade,
      role text not null check (role in ('parent', 'kid')),
      created_at text not null default current_timestamp,
      unique (family_id, user_id)
    );

    create table if not exists parent_invites (
      id integer primary key,
      family_id integer not null references families(id) on delete cascade,
      email text not null,
      invited_by_user_id integer not null references users(id),
      created_at text not null default current_timestamp,
      accepted_at text,
      unique (family_id, email)
    );

    create table if not exists family_approval_requests (
      id integer primary key,
      requester_user_id integer not null references users(id) on delete cascade,
      requester_email text not null,
      requester_name text not null,
      token_hash text unique not null,
      setup_json text not null,
      status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
      requested_at text not null default current_timestamp,
      expires_at text not null,
      decided_at text,
      decided_by_email text
    );

    create table if not exists kids (
      id integer primary key,
      family_id integer not null references families(id) on delete cascade,
      name text not null,
      linked_email text,
      linked_user_id integer references users(id),
      created_at text not null default current_timestamp
    );

    create table if not exists subjects (
      id integer primary key,
      kid_id integer not null references kids(id) on delete cascade,
      name text not null,
      color text not null default '#60a5fa',
      created_at text not null default current_timestamp
    );

    create table if not exists goals (
      kid_id integer primary key references kids(id) on delete cascade,
      weekly_minutes integer not null,
      weekday_minutes integer not null,
      weekend_minutes integer not null,
      updated_at text not null default current_timestamp
    );

    create table if not exists prizes (
      kid_id integer primary key references kids(id) on delete cascade,
      name text,
      target_date text,
      target_weeks integer,
      success_percent integer not null default 100,
      updated_at text not null default current_timestamp
    );

    create table if not exists study_sessions (
      id integer primary key,
      kid_id integer not null references kids(id) on delete cascade,
      subject_id integer not null references subjects(id) on delete cascade,
      minutes integer not null,
      performance_percent integer,
      correct integer,
      total integer,
      note text,
      source text not null check (source in ('timer', 'manual', 'migrated')),
      session_date text not null,
      created_by_user_id integer references users(id),
      created_at text not null default current_timestamp
    );

    create table if not exists import_events (
      id integer primary key,
      kid_id integer not null references kids(id) on delete cascade,
      source_key text not null,
      imported_by_user_id integer not null references users(id),
      imported_count integer not null,
      created_at text not null default current_timestamp,
      unique (kid_id, source_key)
    );

    create table if not exists web_sessions (
      sid text primary key,
      sess text not null,
      expires integer not null
    );
  `);
}

function findOrCreateUser(profile) {
  const email = profile.email.trim().toLowerCase();
  const existing = db.prepare("select * from users where google_id = ? or email = ?").get(profile.googleId, email);
  if (existing) {
    db.prepare(`
      update users
      set google_id = ?, email = ?, name = ?, avatar_url = ?, updated_at = current_timestamp
      where id = ?
    `).run(profile.googleId, email, profile.name, profile.avatarUrl, existing.id);
    acceptParentInvites(existing.id, email);
    return db.prepare("select * from users where id = ?").get(existing.id);
  }

  const result = db.prepare(`
    insert into users (google_id, email, name, avatar_url)
    values (?, ?, ?, ?)
  `).run(profile.googleId, email, profile.name, profile.avatarUrl);
  acceptParentInvites(result.lastInsertRowid, email);
  return db.prepare("select * from users where id = ?").get(result.lastInsertRowid);
}

function acceptParentInvites(userId, email) {
  const invites = db.prepare("select * from parent_invites where email = ? and accepted_at is null").all(email);
  const addMember = db.prepare(`
    insert or ignore into family_members (family_id, user_id, role)
    values (?, ?, 'parent')
  `);
  const markAccepted = db.prepare("update parent_invites set accepted_at = current_timestamp where id = ?");
  withTransaction(() => {
    invites.forEach((invite) => {
      addMember.run(invite.family_id, userId);
      markAccepted.run(invite.id);
    });
  });
}

function hydrateLinkedKidAccounts(user) {
  db.prepare(`
    update kids
    set linked_user_id = ?
    where lower(linked_email) = ? and linked_user_id is null
  `).run(user.id, user.email.toLowerCase());

  const linkedKids = db.prepare(`
    select family_id from kids where linked_user_id = ?
  `).all(user.id);
  const addKidMember = db.prepare(`
    insert or ignore into family_members (family_id, user_id, role)
    values (?, ?, 'kid')
  `);
  linkedKids.forEach((kid) => addKidMember.run(kid.family_id, user.id));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function slugColor(index) {
  const colors = ["#60a5fa", "#f472b6", "#34d399", "#f59e0b", "#a78bfa", "#2dd4bf"];
  return colors[index % colors.length];
}

function withTransaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = {
  db,
  ensureDatabase,
  findOrCreateUser,
  hydrateLinkedKidAccounts,
  normalizeEmail,
  slugColor,
  withTransaction
};
