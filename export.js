const { DatabaseSync } = require("node:sqlite");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dbPath = join(__dirname, "brimstone.db");
const db = new DatabaseSync(dbPath);

const data = {
  exported_at: new Date().toISOString(),
  sourcebooks: db.prepare("SELECT * FROM sourcebooks ORDER BY id").all(),
  missions: db.prepare("SELECT * FROM missions ORDER BY id").all(),
  tags: db.prepare("SELECT * FROM tags ORDER BY id").all(),
  mission_tags: db.prepare("SELECT * FROM mission_tags ORDER BY mission_id, tag_id").all(),
  enemy_types: db.prepare("SELECT * FROM enemy_types ORDER BY id").all(),
  mission_enemy_types: db.prepare("SELECT * FROM mission_enemy_types ORDER BY mission_id, enemy_type_id").all(),
};

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = join(__dirname, `brimstone-export-${timestamp}.json`);
writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log(`Exported to ${outPath}`);
