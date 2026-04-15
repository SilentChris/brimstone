const { DatabaseSync } = require("node:sqlite");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node import.js <export-file.json>");
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, "utf-8"));
const dbPath = join(__dirname, "brimstone.db");
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS sourcebooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    sourcebook_id INTEGER NOT NULL REFERENCES sourcebooks(id),
    mission_number INTEGER,
    completed INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    UNIQUE(title, sourcebook_id)
  );
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS mission_tags (
    mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (mission_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS enemy_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS mission_enemy_types (
    mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    enemy_type_id INTEGER NOT NULL REFERENCES enemy_types(id),
    PRIMARY KEY (mission_id, enemy_type_id)
  );
`);

// Insert sourcebooks
const insertSB = db.prepare("INSERT OR IGNORE INTO sourcebooks (id, name) VALUES (?, ?)");
for (const s of data.sourcebooks) insertSB.run(s.id, s.name);

// Insert missions
const insertM = db.prepare(
  "INSERT OR IGNORE INTO missions (id, title, sourcebook_id, mission_number, completed, result) VALUES (?, ?, ?, ?, ?, ?)"
);
for (const m of data.missions) {
  insertM.run(m.id, m.title, m.sourcebook_id, m.mission_number, m.completed, m.result);
}

// Insert tags
const insertT = db.prepare("INSERT OR IGNORE INTO tags (id, name) VALUES (?, ?)");
for (const t of data.tags) insertT.run(t.id, t.name);

// Insert mission_tags — handle both old (text) and new (id) formats
const insertMT = db.prepare("INSERT OR IGNORE INTO mission_tags (mission_id, tag_id) VALUES (?, ?)");
// Build name→id lookup from the tags we just inserted
const tagLookup = {};
for (const t of data.tags) tagLookup[t.name] = t.id;

for (const mt of data.mission_tags) {
  if (mt.tag_id) {
    // New format — already has the id
    insertMT.run(mt.mission_id, mt.tag_id);
  } else if (mt.tag) {
    // Old format — look up the tag name
    const tagId = tagLookup[mt.tag];
    if (tagId) {
      insertMT.run(mt.mission_id, tagId);
    } else {
      console.warn(`Warning: tag "${mt.tag}" not found in tags table, skipping mission_id=${mt.mission_id}`);
    }
  }
}

// Insert enemy_types
const insertET = db.prepare("INSERT OR IGNORE INTO enemy_types (id, name) VALUES (?, ?)");
for (const e of data.enemy_types) insertET.run(e.id, e.name);

// Insert mission_enemy_types
const insertMET = db.prepare("INSERT OR IGNORE INTO mission_enemy_types (mission_id, enemy_type_id) VALUES (?, ?)");
for (const me of data.mission_enemy_types) insertMET.run(me.mission_id, me.enemy_type_id);

// Summary
const counts = {
  sourcebooks: db.prepare("SELECT COUNT(*) as c FROM sourcebooks").get().c,
  missions: db.prepare("SELECT COUNT(*) as c FROM missions").get().c,
  tags: db.prepare("SELECT COUNT(*) as c FROM tags").get().c,
  mission_tags: db.prepare("SELECT COUNT(*) as c FROM mission_tags").get().c,
  enemy_types: db.prepare("SELECT COUNT(*) as c FROM enemy_types").get().c,
  mission_enemy_types: db.prepare("SELECT COUNT(*) as c FROM mission_enemy_types").get().c,
};
console.log("Imported into", dbPath);
console.log(counts);
