const { Hono } = require("hono");
const { serveStatic } = require("@hono/node-server/serve-static");
const { serve } = require("@hono/node-server");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const db = new DatabaseSync(process.env.DB_PATH || "./brimstone.db");

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
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    UNIQUE(user_id, name)
  );
  CREATE TABLE IF NOT EXISTS campaign_completions (
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    result TEXT NOT NULL,
    PRIMARY KEY (campaign_id, mission_id)
  );
`);

// --- Migration: text-based mission_tags → id-based ---
const mtCols = db.prepare("PRAGMA table_info(mission_tags)").all();
if (mtCols.some((c) => c.name === "tag")) {
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

// --- Seed admin user ---
const adminExists = db.prepare("SELECT id FROM users WHERE is_admin = 1").get();
if (!adminExists) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync("admin", salt, 64).toString("hex");
  db.prepare("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)")
    .run("admin", `${salt}:${hash}`);
  console.log("Created default admin user (username: admin, password: admin)");
}

// --- Auth helpers ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test, "hex"), Buffer.from(hash, "hex"));
}

function getSession(c) {
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (!match) return null;
  return db.prepare(
    `SELECT s.id, s.user_id, u.username, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).get(match[1]) || null;
}

function requireAdmin(c) {
  const user = c.get("user");
  if (!user?.is_admin) return c.json({ error: "Admin access required" }, 403);
  return null;
}

const app = new Hono();

// --- Auth middleware ---
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const session = getSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", session);
  return next();
});

// --- Auth endpoints ---

app.post("/api/auth/register", async (c) => {
  const { username, password } = await c.req.json();
  if (!username?.trim()) return c.json({ error: "Username required" }, 400);
  if (!password || password.length < 4)
    return c.json({ error: "Password must be at least 4 characters" }, 400);
  try {
    const info = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
      .run(username.trim(), hashPassword(password));
    const token = crypto.randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(token, Number(info.lastInsertRowid));
    c.header("Set-Cookie", `session=${token}; Path=/; HttpOnly; SameSite=Strict`);
    return c.json({ id: Number(info.lastInsertRowid), username: username.trim(), is_admin: 0 }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Username already taken" }, 409);
    throw e;
  }
});

app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) return c.json({ error: "Username and password required" }, 400);
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: "Invalid username or password" }, 401);
  }
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(token, user.id);
  c.header("Set-Cookie", `session=${token}; Path=/; HttpOnly; SameSite=Strict`);
  return c.json({ id: user.id, username: user.username, is_admin: user.is_admin });
});

app.post("/api/auth/logout", (c) => {
  const cookie = c.req.header("cookie") || "";
  const match = cookie.match(/session=([a-f0-9]+)/);
  if (match) db.prepare("DELETE FROM sessions WHERE id = ?").run(match[1]);
  c.header("Set-Cookie", "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  return c.json({ ok: true });
});

app.post("/api/auth/change-password", async (c) => {
  const session = getSession(c);
  if (!session) return c.json({ error: "Not logged in" }, 401);
  const { current_password, new_password } = await c.req.json();
  if (!current_password || !new_password)
    return c.json({ error: "Current and new password required" }, 400);
  if (new_password.length < 4)
    return c.json({ error: "New password must be at least 4 characters" }, 400);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
  if (!verifyPassword(current_password, user.password_hash))
    return c.json({ error: "Current password is incorrect" }, 401);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(new_password), user.id);
  return c.json({ ok: true });
});

app.get("/api/auth/me", (c) => {
  const session = getSession(c);
  if (!session) return c.json({ error: "Not logged in" }, 401);
  return c.json({ id: session.user_id, username: session.username, is_admin: session.is_admin });
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

// --- Sourcebook endpoints ---

app.get("/api/sourcebooks", (c) => {
  return c.json(db.prepare("SELECT * FROM sourcebooks ORDER BY name").all());
});

app.post("/api/sourcebooks", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    const info = db.prepare("INSERT INTO sourcebooks (name) VALUES (?)").run(name.trim());
    return c.json({ id: Number(info.lastInsertRowid), name: name.trim() }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Sourcebook already exists" }, 409);
    throw e;
  }
});

app.patch("/api/sourcebooks/:id", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE sourcebooks SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Sourcebook already exists" }, 409);
    throw e;
  }
});

app.delete("/api/sourcebooks/:id", (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  const missions = db.prepare("SELECT COUNT(*) as count FROM missions WHERE sourcebook_id = ?").get(id);
  if (missions.count > 0) return c.json({ error: "Cannot delete sourcebook that has missions" }, 400);
  db.prepare("DELETE FROM sourcebooks WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Tag endpoints ---

app.get("/api/tags", (c) => {
  return c.json(db.prepare("SELECT * FROM tags ORDER BY name").all());
});

app.post("/api/tags", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    const info = db.prepare("INSERT INTO tags (name) VALUES (?)").run(name.trim());
    return c.json({ id: Number(info.lastInsertRowid), name: name.trim() }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Tag already exists" }, 409);
    throw e;
  }
});

app.patch("/api/tags/:id", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE tags SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Tag already exists" }, 409);
    throw e;
  }
});

app.delete("/api/tags/:id", (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  db.prepare("DELETE FROM mission_tags WHERE tag_id = ?").run(id);
  db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Enemy type endpoints ---

app.get("/api/enemy-types", (c) => {
  const q = c.req.query("q");
  if (q) {
    return c.json(
      db.prepare("SELECT * FROM enemy_types WHERE name LIKE ? ORDER BY name LIMIT 20").all(`%${q}%`)
    );
  }
  return c.json(db.prepare("SELECT * FROM enemy_types ORDER BY name").all());
});

app.patch("/api/enemy-types/:id", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  const { name } = await c.req.json();
  if (!name || !name.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE enemy_types SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Enemy type already exists" }, 409);
    throw e;
  }
});

app.delete("/api/enemy-types/:id", (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  db.prepare("DELETE FROM mission_enemy_types WHERE enemy_type_id = ?").run(id);
  db.prepare("DELETE FROM enemy_types WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Mission endpoints ---

app.get("/api/missions", (c) => {
  const campaignId = c.req.query("campaign_id");
  let rows;
  if (campaignId) {
    rows = db.prepare(
      `SELECT m.id, m.title, m.mission_number, m.sourcebook_id, s.name as sourcebook,
              CASE WHEN cc.campaign_id IS NOT NULL THEN 1 ELSE 0 END as completed,
              cc.result
       FROM missions m JOIN sourcebooks s ON m.sourcebook_id = s.id
       LEFT JOIN campaign_completions cc ON cc.mission_id = m.id AND cc.campaign_id = ?
       ORDER BY s.name, m.mission_number, m.title`
    ).all(Number(campaignId));
  } else {
    rows = db.prepare(
      `SELECT m.id, m.title, m.mission_number, m.sourcebook_id, s.name as sourcebook,
              0 as completed, NULL as result
       FROM missions m JOIN sourcebooks s ON m.sourcebook_id = s.id
       ORDER BY s.name, m.mission_number, m.title`
    ).all();
  }
  return c.json(hydrateMissions(rows));
});

app.post("/api/missions", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
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
      const findOrCreate = db.prepare(
        "INSERT INTO enemy_types (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id"
      );
      const linkStmt = db.prepare("INSERT INTO mission_enemy_types (mission_id, enemy_type_id) VALUES (?, ?)");
      for (const name of enemy_types) {
        const row = findOrCreate.get(name.trim());
        linkStmt.run(missionId, row.id);
      }
    }
    return c.json({ id: missionId, title: title.trim(), sourcebook_id }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "Mission already exists in that sourcebook" }, 409);
    throw e;
  }
});

app.delete("/api/missions/:id", (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  db.prepare("DELETE FROM mission_tags WHERE mission_id = ?").run(id);
  db.prepare("DELETE FROM mission_enemy_types WHERE mission_id = ?").run(id);
  db.prepare("DELETE FROM campaign_completions WHERE mission_id = ?").run(id);
  db.prepare("DELETE FROM missions WHERE id = ?").run(id);
  return c.json({ ok: true });
});

app.patch("/api/missions/:id", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const id = Number(c.req.param("id"));
  const { title, sourcebook_id, mission_number, tags, enemy_types } = await c.req.json();
  if (!title || !title.trim()) return c.json({ error: "Title required" }, 400);
  if (!sourcebook_id) return c.json({ error: "Sourcebook required" }, 400);
  try {
    db.prepare(
      "UPDATE missions SET title = ?, sourcebook_id = ?, mission_number = ? WHERE id = ?"
    ).run(title.trim(), sourcebook_id, mission_number || null, id);

    db.prepare("DELETE FROM mission_tags WHERE mission_id = ?").run(id);
    if (tags && tags.length) {
      const tagStmt = db.prepare("INSERT INTO mission_tags (mission_id, tag_id) VALUES (?, ?)");
      for (const tagId of tags) tagStmt.run(id, tagId);
    }

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
    if (e.message.includes("UNIQUE")) return c.json({ error: "Mission already exists in that sourcebook" }, 409);
    throw e;
  }
});

// --- Campaign endpoints ---

app.get("/api/campaigns", (c) => {
  const user = c.get("user");
  return c.json(db.prepare("SELECT * FROM campaigns WHERE user_id = ? ORDER BY name").all(user.user_id));
});

app.post("/api/campaigns", async (c) => {
  const user = c.get("user");
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: "Name required" }, 400);
  try {
    const info = db.prepare("INSERT INTO campaigns (user_id, name) VALUES (?, ?)").run(user.user_id, name.trim());
    return c.json({ id: Number(info.lastInsertRowid), user_id: user.user_id, name: name.trim() }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "You already have a campaign with that name" }, 409);
    throw e;
  }
});

app.patch("/api/campaigns/:id", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND user_id = ?").get(id, user.user_id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: "Name required" }, 400);
  try {
    db.prepare("UPDATE campaigns SET name = ? WHERE id = ?").run(name.trim(), id);
    return c.json({ ok: true });
  } catch (e) {
    if (e.message.includes("UNIQUE")) return c.json({ error: "You already have a campaign with that name" }, 409);
    throw e;
  }
});

app.delete("/api/campaigns/:id", (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND user_id = ?").get(id, user.user_id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  db.prepare("DELETE FROM campaign_completions WHERE campaign_id = ?").run(id);
  db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  return c.json({ ok: true });
});

// --- Campaign completion endpoints ---

app.post("/api/campaigns/:id/completions", async (c) => {
  const user = c.get("user");
  const campaignId = Number(c.req.param("id"));
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND user_id = ?").get(campaignId, user.user_id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  const { mission_id, result } = await c.req.json();
  if (!mission_id) return c.json({ error: "Mission ID required" }, 400);
  if (!["success", "failure"].includes(result))
    return c.json({ error: "Result must be 'success' or 'failure'" }, 400);
  db.prepare("INSERT OR REPLACE INTO campaign_completions (campaign_id, mission_id, result) VALUES (?, ?, ?)")
    .run(campaignId, mission_id, result);
  return c.json({ ok: true });
});

app.delete("/api/campaigns/:id/completions/:missionId", (c) => {
  const user = c.get("user");
  const campaignId = Number(c.req.param("id"));
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ? AND user_id = ?").get(campaignId, user.user_id);
  if (!campaign) return c.json({ error: "Campaign not found" }, 404);
  const missionId = Number(c.req.param("missionId"));
  db.prepare("DELETE FROM campaign_completions WHERE campaign_id = ? AND mission_id = ?").run(campaignId, missionId);
  return c.json({ ok: true });
});

// --- Export / Import (admin only) ---

app.get("/api/export", (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const data = {
    exported_at: new Date().toISOString(),
    sourcebooks: db.prepare("SELECT * FROM sourcebooks ORDER BY id").all(),
    missions: db.prepare("SELECT * FROM missions ORDER BY id").all(),
    tags: db.prepare("SELECT * FROM tags ORDER BY id").all(),
    mission_tags: db.prepare("SELECT * FROM mission_tags ORDER BY mission_id, tag_id").all(),
    enemy_types: db.prepare("SELECT * FROM enemy_types ORDER BY id").all(),
    mission_enemy_types: db.prepare("SELECT * FROM mission_enemy_types ORDER BY mission_id, enemy_type_id").all(),
  };
  return c.json(data);
});

app.post("/api/import", async (c) => {
  const err = requireAdmin(c);
  if (err) return err;
  const data = await c.req.json();

  // Validate shape
  if (!data.sourcebooks || !data.missions || !data.tags) {
    return c.json({ error: "Invalid export format" }, 400);
  }

  // Insert sourcebooks
  const insertSB = db.prepare("INSERT OR REPLACE INTO sourcebooks (id, name) VALUES (?, ?)");
  for (const s of data.sourcebooks) insertSB.run(s.id, s.name);

  // Insert tags
  const insertT = db.prepare("INSERT OR REPLACE INTO tags (id, name) VALUES (?, ?)");
  for (const t of data.tags) insertT.run(t.id, t.name);

  // Insert enemy types
  if (data.enemy_types) {
    const insertET = db.prepare("INSERT OR REPLACE INTO enemy_types (id, name) VALUES (?, ?)");
    for (const e of data.enemy_types) insertET.run(e.id, e.name);
  }

  // Insert missions (preserve IDs)
  const insertM = db.prepare(
    "INSERT OR REPLACE INTO missions (id, title, sourcebook_id, mission_number, completed, result) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const m of data.missions) {
    insertM.run(m.id, m.title, m.sourcebook_id, m.mission_number, m.completed || 0, m.result || null);
  }

  // Insert mission_tags
  if (data.mission_tags) {
    const insertMT = db.prepare("INSERT OR IGNORE INTO mission_tags (mission_id, tag_id) VALUES (?, ?)");
    // Build name→id lookup for old-format exports
    const tagLookup = {};
    for (const t of data.tags) tagLookup[t.name] = t.id;
    for (const mt of data.mission_tags) {
      if (mt.tag_id) {
        insertMT.run(mt.mission_id, mt.tag_id);
      } else if (mt.tag) {
        const tagId = tagLookup[mt.tag];
        if (tagId) insertMT.run(mt.mission_id, tagId);
      }
    }
  }

  // Insert mission_enemy_types
  if (data.mission_enemy_types) {
    const insertMET = db.prepare("INSERT OR IGNORE INTO mission_enemy_types (mission_id, enemy_type_id) VALUES (?, ?)");
    for (const me of data.mission_enemy_types) insertMET.run(me.mission_id, me.enemy_type_id);
  }

  const counts = {
    sourcebooks: db.prepare("SELECT COUNT(*) as c FROM sourcebooks").get().c,
    missions: db.prepare("SELECT COUNT(*) as c FROM missions").get().c,
    tags: db.prepare("SELECT COUNT(*) as c FROM tags").get().c,
    enemy_types: db.prepare("SELECT COUNT(*) as c FROM enemy_types").get().c,
  };
  return c.json({ ok: true, counts });
});

// --- Random mission selection ---

app.post("/api/missions/random", async (c) => {
  const { sourcebook_ids, mission_ids, include_tag_ids, exclude_tag_ids, campaign_id } = await c.req.json();

  let sql = `SELECT m.id, m.title, m.mission_number, m.sourcebook_id, s.name as sourcebook
             FROM missions m JOIN sourcebooks s ON m.sourcebook_id = s.id WHERE 1=1`;
  const params = [];

  if (campaign_id) {
    sql += ` AND NOT EXISTS (SELECT 1 FROM campaign_completions cc WHERE cc.mission_id = m.id AND cc.campaign_id = ?)`;
    params.push(campaign_id);
  }

  if (mission_ids && mission_ids.length > 0) {
    sql += ` AND m.id IN (${mission_ids.map(() => "?").join(",")})`;
    params.push(...mission_ids);
  } else if (sourcebook_ids && sourcebook_ids.length > 0) {
    sql += ` AND m.sourcebook_id IN (${sourcebook_ids.map(() => "?").join(",")})`;
    params.push(...sourcebook_ids);
  }

  if (include_tag_ids && include_tag_ids.length > 0) {
    sql += ` AND (SELECT COUNT(*) FROM mission_tags mt WHERE mt.mission_id = m.id AND mt.tag_id IN (${include_tag_ids.map(() => "?").join(",")})) = ?`;
    params.push(...include_tag_ids, include_tag_ids.length);
  }

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
