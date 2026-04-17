const { Hono } = require("hono");
const { serveStatic } = require("@hono/node-server/serve-static");
const { serve } = require("@hono/node-server");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync("./brimstone.db");

// --- Schema ---
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

// --- Migration: text-based mission_tags → id-based ---
// If mission_tags has a 'tag' TEXT column (old schema), migrate to tag_id references.
const mtCols = db.prepare("PRAGMA table_info(mission_tags)").all();
if (mtCols.some((c) => c.name === "tag")) {
  // Ensure every tag name used in mission_tags exists in the tags table
  db.exec("INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag FROM mission_tags");
  db.exec(`
    CREATE TABLE mission_tags_new (
      mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (mission_id, tag_id)
    );
    INSERT INTO mission_tags_new (mission_id, tag_id)
      SELECT mt.mission_id, t.id FROM mission_tags mt JOIN tags t ON t.name = mt.tag;
    DROP TABLE mission_tags;
    ALTER TABLE mission_tags_new RENAME TO mission_tags;
  `);
  console.log("Migrated mission_tags from text to tag_id references");
}

const app = new Hono();

// --- Sourcebook endpoints ---

app.get("/api/sourcebooks", (c) => {
  const rows = db.prepare("SELECT * FROM sourcebooks ORDER BY name").all();
  return c.json(rows);
});

app.post("/api/sourcebooks", async (c) => {
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    const info = db.prepare("INSERT INTO sourcebooks (name) VALUES (?)").run(name.trim());
    return c.json({ id: Number(info.lastInsertRowid), name: name.trim() }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Sourcebook already exists" }, 409);
    }
    throw e;
  }
});

app.patch("/api/sourcebooks/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE sourcebooks SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Sourcebook already exists" }, 409);
    }
    throw e;
  }
});

app.delete("/api/sourcebooks/:id", (c) => {
  const id = Number(c.req.param("id"));
  const missions = db.prepare("SELECT COUNT(*) as count FROM missions WHERE sourcebook_id = ?").get(id);
  if (missions.count > 0) {
    return c.json({ error: "Cannot delete sourcebook that has missions" }, 400);
  }
  db.prepare("DELETE FROM sourcebooks WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Helpers to hydrate mission metadata ---
function hydrateMissions(rows) {
  const tagStmt = db.prepare(
    `SELECT t.id, t.name FROM tags t
     JOIN mission_tags mt ON mt.tag_id = t.id
     WHERE mt.mission_id = ?`
  );
  const enemyStmt = db.prepare(
    `SELECT e.id, e.name FROM enemy_types e
     JOIN mission_enemy_types me ON me.enemy_type_id = e.id
     WHERE me.mission_id = ?`
  );
  return rows.map((r) => ({
    ...r,
    tags: tagStmt.all(r.id),
    enemy_types: enemyStmt.all(r.id),
  }));
}

// --- Tag endpoints ---
app.get("/api/tags", (c) => {
  const rows = db.prepare("SELECT * FROM tags ORDER BY name").all();
  return c.json(rows);
});

app.post("/api/tags", async (c) => {
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    const info = db.prepare("INSERT INTO tags (name) VALUES (?)").run(name.trim());
    return c.json({ id: Number(info.lastInsertRowid), name: name.trim() }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Tag already exists" }, 409);
    }
    throw e;
  }
});

app.patch("/api/tags/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Tag already exists" }, 409);
    }
    throw e;
  }
});

app.delete("/api/tags/:id", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare("DELETE FROM mission_tags WHERE tag_id = ?").run(id);
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Enemy type endpoints ---
app.get("/api/enemy-types", (c) => {
  const q = c.req.query("q");
  if (q) {
    const rows = db
      .prepare("SELECT * FROM enemy_types WHERE name LIKE ? ORDER BY name LIMIT 20")
      .all(`%${q}%`);
    return c.json(rows);
  }
  return c.json(db.prepare("SELECT * FROM enemy_types ORDER BY name").all());
});

app.patch("/api/enemy-types/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE enemy_types SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Enemy type already exists" }, 409);
    }
    throw e;
  }
});

app.delete("/api/enemy-types/:id", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare("DELETE FROM mission_enemy_types WHERE enemy_type_id = ?").run(id);
  db.prepare("DELETE FROM enemy_types WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Mission endpoints ---

app.get("/api/missions", (c) => {
  const rows = db
    .prepare(
      `SELECT m.id, m.title, m.mission_number, m.completed, m.result, m.sourcebook_id,
              s.name as sourcebook
       FROM missions m JOIN sourcebooks s ON m.sourcebook_id = s.id
       ORDER BY s.name, m.mission_number, m.title`
    )
    .all();
  return c.json(hydrateMissions(rows));
});

app.post("/api/missions", async (c) => {
  const { title, sourcebook_id, mission_number, tags, enemy_types } = await c.req.json();
  if (!title || !title.trim()) return c.json({ error: "Title required" }, 400);
  if (!sourcebook_id) return c.json({ error: "Sourcebook required" }, 400);
  try {
    const info = db
      .prepare("INSERT INTO missions (title, sourcebook_id, mission_number) VALUES (?, ?, ?)")
      .run(title.trim(), sourcebook_id, mission_number || null);
    const missionId = Number(info.lastInsertRowid);

    if (tags && tags.length) {
      const tagStmt = db.prepare("INSERT INTO mission_tags (mission_id, tag_id) VALUES (?, ?)");
      for (const tagId of tags) tagStmt.run(missionId, tagId);
    }

    if (enemy_types && enemy_types.length) {
      const findOrCreate = db.prepare("INSERT INTO enemy_types (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id");
      const linkStmt = db.prepare("INSERT INTO mission_enemy_types (mission_id, enemy_type_id) VALUES (?, ?)");
      for (const name of enemy_types) {
        const row = findOrCreate.get(name.trim());
        linkStmt.run(missionId, row.id);
      }
    }

    return c.json({ id: missionId, title: title.trim(), sourcebook_id }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Mission already exists in that sourcebook" }, 409);
    }
    throw e;
  }
});

app.delete("/api/missions/:id", (c) => {
  const id = Number(c.req.param("id"));
  db.prepare("DELETE FROM mission_tags WHERE mission_id = ?").run(id);
  db.prepare("DELETE FROM mission_enemy_types WHERE mission_id = ?").run(id);
  db.prepare("DELETE FROM missions WHERE id = ?").run(id);
  return c.json({ ok: true });
});

app.patch("/api/missions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();

  // Completion-only update (pass/fail/undo)
  if ("completed" in body && !("title" in body)) {
    db.prepare("UPDATE missions SET completed = ?, result = ? WHERE id = ?").run(
      body.completed ? 1 : 0,
      body.result || null,
      id
    );
    return c.json({ ok: true });
  }

  // Full edit
  const { title, sourcebook_id, mission_number, tags, enemy_types } = body;
  if (!title || !title.trim()) return c.json({ error: "Title required" }, 400);
  if (!sourcebook_id) return c.json({ error: "Sourcebook required" }, 400);

  try {
    db.prepare(
      "UPDATE missions SET title = ?, sourcebook_id = ?, mission_number = ? WHERE id = ?"
    ).run(title.trim(), sourcebook_id, mission_number || null, id);

    // Replace tags
    db.prepare("DELETE FROM mission_tags WHERE mission_id = ?").run(id);
    if (tags && tags.length) {
      const tagStmt = db.prepare("INSERT INTO mission_tags (mission_id, tag_id) VALUES (?, ?)");
      for (const tagId of tags) tagStmt.run(id, tagId);
    }

    // Replace enemy types
    db.prepare("DELETE FROM mission_enemy_types WHERE mission_id = ?").run(id);
    if (enemy_types && enemy_types.length) {
      const findOrCreate = db.prepare(
        "INSERT INTO enemy_types (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id"
      );
      const linkStmt = db.prepare(
        "INSERT INTO mission_enemy_types (mission_id, enemy_type_id) VALUES (?, ?)"
      );
      for (const name of enemy_types) {
        const row = findOrCreate.get(name.trim());
        linkStmt.run(id, row.id);
      }
    }

    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return c.json({ error: "Mission already exists in that sourcebook" }, 409);
    }
    throw e;
  }
});

// --- Random mission selection ---

app.post("/api/missions/random", async (c) => {
  const { sourcebook_ids, mission_ids, include_tag_ids, exclude_tag_ids } = await c.req.json();

  let sql = `SELECT m.id, m.title, m.mission_number, m.completed, m.result, m.sourcebook_id,
                    s.name as sourcebook
             FROM missions m JOIN sourcebooks s ON m.sourcebook_id = s.id
             WHERE m.completed = 0`;
  const params = [];

  if (mission_ids && mission_ids.length > 0) {
    sql += ` AND m.id IN (${mission_ids.map(() => "?").join(",")})`;
    params.push(...mission_ids);
  } else if (sourcebook_ids && sourcebook_ids.length > 0) {
    sql += ` AND m.sourcebook_id IN (${sourcebook_ids.map(() => "?").join(",")})`;
    params.push(...sourcebook_ids);
  }

  // Include: mission must have ALL of these tags
  if (include_tag_ids && include_tag_ids.length > 0) {
    sql += ` AND (SELECT COUNT(*) FROM mission_tags mt WHERE mt.mission_id = m.id AND mt.tag_id IN (${include_tag_ids.map(() => "?").join(",")})) = ?`;
    params.push(...include_tag_ids, include_tag_ids.length);
  }

  // Exclude: mission must have NONE of these tags
  if (exclude_tag_ids && exclude_tag_ids.length > 0) {
    sql += ` AND NOT EXISTS (SELECT 1 FROM mission_tags mt WHERE mt.mission_id = m.id AND mt.tag_id IN (${exclude_tag_ids.map(() => "?").join(",")}))`;
    params.push(...exclude_tag_ids);
  }

  sql += " ORDER BY RANDOM() LIMIT 1";
  const row = db.prepare(sql).get(...params);
  if (!row) return c.json({ error: "No matching incomplete missions" }, 404);
  return c.json(hydrateMissions([row])[0]);
});

// --- Static files ---
app.use("/*", serveStatic({ root: "./public" }));

const port = process.env.PORT || 3003;
serve({ fetch: app.fetch, port }, () => {
  console.log(`Brimstone Missions running at http://localhost:${port}`);
});
