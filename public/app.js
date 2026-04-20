const API = "";

// --- State ---
let currentUser = null;
let campaigns = [];
let activeCampaignId = null;
let sourcebooks = [];
let missions = [];
let allTags = [];
let allEnemyTypes = [];
let selectedEnemies = [];
let editSelectedEnemies = [];

// --- API helpers ---
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    showLogin();
    return null;
  }
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Something went wrong");
    return null;
  }
  return data;
}

async function authApi(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  return { ok: res.ok, data };
}

// --- Auth ---
function showLogin() {
  currentUser = null;
  document.getElementById("login-overlay").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-form").reset();
  document.getElementById("register-form").reset();
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("register-error").classList.add("hidden");
  switchLoginTab("login");
}

function showApp() {
  document.getElementById("login-overlay").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("username-display").textContent = currentUser.username;
  // Show/hide admin-only elements
  document.querySelectorAll(".admin-only").forEach((el) => {
    el.style.display = currentUser.is_admin ? "" : "none";
  });
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;
  const { ok, data } = await authApi("POST", "/api/auth/login", { username, password });
  if (ok) {
    currentUser = data;
    await initApp();
  } else {
    errEl.textContent = data.error;
    errEl.classList.remove("hidden");
  }
});

function switchLoginTab(tab) {
  document.getElementById("login-tab-btn").classList.toggle("active", tab === "login");
  document.getElementById("register-tab-btn").classList.toggle("active", tab === "register");
  document.getElementById("login-form").classList.toggle("hidden", tab !== "login");
  document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
}

document.getElementById("login-tab-btn").addEventListener("click", () => switchLoginTab("login"));
document.getElementById("register-tab-btn").addEventListener("click", () => switchLoginTab("register"));

document.getElementById("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("register-error");
  errEl.classList.add("hidden");
  const username = document.getElementById("reg-username").value;
  const password = document.getElementById("reg-password").value;
  const { ok, data } = await authApi("POST", "/api/auth/register", { username, password });
  if (ok) {
    currentUser = data;
    await initApp();
  } else {
    errEl.textContent = data.error;
    errEl.classList.remove("hidden");
  }
});

document.getElementById("change-pw-btn").addEventListener("click", async () => {
  const current_password = prompt("Current password:");
  if (!current_password) return;
  const new_password = prompt("New password (4+ characters):");
  if (!new_password) return;
  const result = await api("POST", "/api/auth/change-password", { current_password, new_password });
  if (result) alert("Password changed.");
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch(API + "/api/auth/logout", { method: "POST" });
  showLogin();
});

// --- Tabs ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// --- Campaigns ---
async function loadCampaigns() {
  campaigns = (await api("GET", "/api/campaigns")) || [];
  renderCampaignSelect();
}

function renderCampaignSelect() {
  const sel = document.getElementById("campaign-select");
  if (!campaigns.length) {
    sel.innerHTML = '<option value="">No campaigns</option>';
    activeCampaignId = null;
  } else {
    const stillValid = campaigns.some((c) => c.id === activeCampaignId);
    if (!stillValid) {
      const saved = localStorage.getItem("activeCampaignId");
      if (saved && campaigns.some((c) => c.id === Number(saved))) {
        activeCampaignId = Number(saved);
      } else {
        activeCampaignId = campaigns[0].id;
      }
    }
    sel.innerHTML = campaigns
      .map((c) => `<option value="${c.id}" ${c.id === activeCampaignId ? "selected" : ""}>${esc(c.name)}</option>`)
      .join("");
  }
  localStorage.setItem("activeCampaignId", activeCampaignId || "");
}

document.getElementById("campaign-select").addEventListener("change", async (e) => {
  activeCampaignId = Number(e.target.value) || null;
  localStorage.setItem("activeCampaignId", activeCampaignId || "");
  await loadMissions();
});

document.getElementById("new-campaign-btn").addEventListener("click", async () => {
  const name = prompt("Campaign name:");
  if (!name?.trim()) return;
  const result = await api("POST", "/api/campaigns", { name: name.trim() });
  if (result) {
    activeCampaignId = result.id;
    await loadCampaigns();
    await loadMissions();
  }
});

document.getElementById("rename-campaign-btn").addEventListener("click", async () => {
  if (!activeCampaignId) return;
  const campaign = campaigns.find((c) => c.id === activeCampaignId);
  const name = prompt("Rename campaign:", campaign?.name);
  if (!name?.trim() || name.trim() === campaign?.name) return;
  const result = await api("PATCH", `/api/campaigns/${activeCampaignId}`, { name: name.trim() });
  if (result) await loadCampaigns();
});

document.getElementById("delete-campaign-btn").addEventListener("click", async () => {
  if (!activeCampaignId) return;
  const campaign = campaigns.find((c) => c.id === activeCampaignId);
  if (!confirm(`Delete campaign "${campaign?.name}"? All completion data will be lost.`)) return;
  const result = await api("DELETE", `/api/campaigns/${activeCampaignId}`);
  if (result) {
    activeCampaignId = null;
    await loadCampaigns();
    await loadMissions();
  }
});

// --- Tags ---
async function loadTags() {
  allTags = (await api("GET", "/api/tags")) || [];
  renderTagCheckboxes("mission-tags");
  renderTagList();
  renderRandomizerTags();
}

function renderTagCheckboxes(containerId, checkedIds) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = allTags
    .map((t) => {
      const checked = checkedIds && checkedIds.includes(t.id) ? "checked" : "";
      return `<label><input type="checkbox" value="${t.id}" ${checked}> ${esc(t.name)}</label>`;
    })
    .join("");
}

function renderTagList() {
  const el = document.getElementById("tag-list");
  if (!el) return;
  if (!allTags.length) {
    el.innerHTML = '<p class="empty-state">No tags yet.</p>';
    return;
  }
  el.innerHTML = allTags
    .map(
      (t) => `
    <div class="item">
      <span class="title"><span class="tag-pill ${tagClass(t.name)}">${esc(t.name)}</span></span>
      <button class="btn-edit" onclick="renameTag(${t.id}, '${esc(t.name).replace(/'/g, "\\'")}')">rename</button>
      <button class="btn-delete" onclick="deleteTag(${t.id})">remove</button>
    </div>`
    )
    .join("");
}

window.renameTag = async function (id, currentName) {
  const newName = prompt("Rename tag:", currentName);
  if (!newName || newName.trim() === currentName) return;
  const result = await api("PATCH", `/api/tags/${id}`, { name: newName.trim() });
  if (result) {
    await loadTags();
    await loadMissions();
  }
};

function tagClass(tag) {
  const slug = tag.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const map = {
    "preset-map": "preset-map",
    "no-gates": "no-gates",
    "starts-in-other-world": "starts-other-world",
    "epic-threat": "epic-threat",
  };
  return map[slug] || "";
}

function renderTagPills(tags, enemies) {
  let html = "";
  if (tags) {
    html += tags.map((t) => `<span class="tag-pill ${tagClass(t.name)}">${esc(t.name)}</span>`).join("");
  }
  if (enemies && enemies.length) {
    html += enemies.map((e) => `<span class="tag-pill enemy">${esc(e.name)}</span>`).join("");
  }
  return html;
}

document.getElementById("add-tag-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("tag-name");
  const result = await api("POST", "/api/tags", { name: input.value });
  if (result) {
    input.value = "";
    await loadTags();
  }
});

window.deleteTag = async function (id) {
  const tag = allTags.find((t) => t.id === id);
  if (!confirm(`Delete tag "${tag?.name}"? It will be removed from all missions.`)) return;
  const result = await api("DELETE", `/api/tags/${id}`);
  if (result) {
    await loadTags();
    await loadMissions();
  }
};

// --- Enemy type management ---
async function loadEnemyTypes() {
  allEnemyTypes = (await api("GET", "/api/enemy-types")) || [];
  renderEnemyTypeList();
}

function renderEnemyTypeList() {
  const el = document.getElementById("enemy-type-list");
  if (!el) return;
  if (!allEnemyTypes.length) {
    el.innerHTML = '<p class="empty-state">No enemy types yet.</p>';
    return;
  }
  el.innerHTML = allEnemyTypes
    .map(
      (e) => `
    <div class="item">
      <span class="title"><span class="tag-pill enemy">${esc(e.name)}</span></span>
      <button class="btn-edit" onclick="renameEnemyType(${e.id}, '${esc(e.name).replace(/'/g, "\\'")}')">rename</button>
      <button class="btn-delete" onclick="deleteEnemyType(${e.id})">remove</button>
    </div>`
    )
    .join("");
}

window.renameEnemyType = async function (id, currentName) {
  const newName = prompt("Rename enemy type:", currentName);
  if (!newName || newName.trim() === currentName) return;
  const result = await api("PATCH", `/api/enemy-types/${id}`, { name: newName.trim() });
  if (result) {
    await loadEnemyTypes();
    await loadMissions();
  }
};

window.deleteEnemyType = async function (id) {
  const enemy = allEnemyTypes.find((e) => e.id === id);
  if (!confirm(`Delete enemy type "${enemy?.name}"? It will be removed from all missions.`)) return;
  const result = await api("DELETE", `/api/enemy-types/${id}`);
  if (result) {
    await loadEnemyTypes();
    await loadMissions();
  }
};

// --- Enemy type search (reusable for add + edit forms) ---
function setupEnemySearch(inputId, suggestionsId, selectedId, getList, setList) {
  const input = document.getElementById(inputId);
  const suggestionsEl = document.getElementById(suggestionsId);
  const selectedEl = document.getElementById(selectedId);
  let debounce;

  input.addEventListener("input", () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { suggestionsEl.classList.add("hidden"); return; }
    debounce = setTimeout(() => doSearch(q), 150);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const active = suggestionsEl.querySelector(".suggestion.active");
      if (active) { active.click(); }
      else { const q = input.value.trim(); if (q) doAdd(q); }
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...suggestionsEl.querySelectorAll(".suggestion")];
      if (!items.length) return;
      const cur = items.findIndex((i) => i.classList.contains("active"));
      items.forEach((i) => i.classList.remove("active"));
      const next = Math.max(0, Math.min(items.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
      items[next].classList.add("active");
    }
  });

  async function doSearch(q) {
    const results = await api("GET", `/api/enemy-types?q=${encodeURIComponent(q)}`);
    if (!results) return;
    const list = getList();
    const filtered = results.filter(
      (r) => !list.some((s) => s.toLowerCase() === r.name.toLowerCase())
    );
    let html = filtered
      .map((r) => `<div class="suggestion" data-name="${esc(r.name)}">${esc(r.name)}</div>`)
      .join("");
    const exactMatch = results.some((r) => r.name.toLowerCase() === q.toLowerCase());
    if (!exactMatch && !list.some((s) => s.toLowerCase() === q.toLowerCase())) {
      html += `<div class="suggestion add-new" data-name="${esc(q)}">+ Add "${esc(q)}"</div>`;
    }
    suggestionsEl.innerHTML = html;
    suggestionsEl.classList.toggle("hidden", !html);
    suggestionsEl.querySelectorAll(".suggestion").forEach((el) => {
      el.addEventListener("click", () => doAdd(el.dataset.name));
    });
  }

  function doAdd(name) {
    name = name.trim();
    const list = getList();
    if (!name || list.some((s) => s.toLowerCase() === name.toLowerCase())) return;
    list.push(name);
    setList(list);
    input.value = "";
    suggestionsEl.classList.add("hidden");
    renderEnemyPills(selectedEl, getList, setList);
  }

  renderEnemyPills(selectedEl, getList, setList);
  return { renderPills: () => renderEnemyPills(selectedEl, getList, setList) };
}

function renderEnemyPills(container, getList, setList) {
  const list = getList();
  container.innerHTML = list
    .map(
      (name, i) =>
        `<span class="tag-pill enemy">${esc(name)} <span class="remove-tag" data-idx="${i}">&times;</span></span>`
    )
    .join("");
  container.querySelectorAll(".remove-tag").forEach((el) => {
    el.addEventListener("click", () => {
      const l = getList();
      l.splice(Number(el.dataset.idx), 1);
      setList(l);
      renderEnemyPills(container, getList, setList);
    });
  });
}

const addEnemyCtrl = setupEnemySearch(
  "enemy-search", "enemy-suggestions", "enemy-selected",
  () => selectedEnemies,
  (v) => { selectedEnemies = v; }
);

const editEnemyCtrl = setupEnemySearch(
  "edit-enemy-search", "edit-enemy-suggestions", "edit-enemy-selected",
  () => editSelectedEnemies,
  (v) => { editSelectedEnemies = v; }
);

document.addEventListener("click", (e) => {
  if (!e.target.closest(".enemy-input-wrap")) {
    document.querySelectorAll(".suggestions").forEach((el) => el.classList.add("hidden"));
  }
});

// --- Sourcebooks ---
async function loadSourcebooks() {
  sourcebooks = (await api("GET", "/api/sourcebooks")) || [];
  renderSourcebooks();
  renderSourcebookDropdown("mission-sourcebook");
  renderSourcebookDropdown("edit-mission-sourcebook");
  renderRandomizerSourcebooks();
}

function renderSourcebooks() {
  const el = document.getElementById("sourcebook-list");
  if (!el) return;
  if (!sourcebooks.length) {
    el.innerHTML = '<p class="empty-state">No sourcebooks yet. Add one above.</p>';
    return;
  }
  el.innerHTML = sourcebooks
    .map(
      (s) => `
    <div class="item">
      <span class="title">${esc(s.name)}</span>
      <button class="btn-edit" onclick="renameSourcebook(${s.id}, '${esc(s.name).replace(/'/g, "\\'")}')">rename</button>
      <button class="btn-delete" onclick="deleteSourcebook(${s.id})">remove</button>
    </div>`
    )
    .join("");
}

window.renameSourcebook = async function (id, currentName) {
  const newName = prompt("Rename sourcebook:", currentName);
  if (!newName || newName.trim() === currentName) return;
  const result = await api("PATCH", `/api/sourcebooks/${id}`, { name: newName.trim() });
  if (result) {
    await loadSourcebooks();
    await loadMissions();
  }
};

function renderSourcebookDropdown(selectId, selectedId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML =
    '<option value="">Sourcebook…</option>' +
    sourcebooks
      .map((s) => `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${esc(s.name)}</option>`)
      .join("");
}

function renderRandomizerSourcebooks() {
  const toggles = document.getElementById("randomizer-sourcebook-toggles");
  if (toggles) {
    toggles.innerHTML =
      `<span class="select-toggle" onclick="toggleRandomizerSourcebooks(true)">all</span> / <span class="select-toggle" onclick="toggleRandomizerSourcebooks(false)">none</span>`;
  }
  const el = document.getElementById("randomizer-sourcebooks");
  if (!el) return;
  el.innerHTML = sourcebooks
    .map(
      (s) => `
    <label><input type="checkbox" value="${s.id}" checked> ${esc(s.name)}</label>`
    )
    .join("");
}

window.toggleRandomizerSourcebooks = function (checked) {
  document.querySelectorAll('#randomizer-sourcebooks input[type="checkbox"]').forEach(
    (cb) => (cb.checked = checked)
  );
};

document.getElementById("add-sourcebook-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("sourcebook-name");
  const result = await api("POST", "/api/sourcebooks", { name: input.value });
  if (result) {
    input.value = "";
    await loadSourcebooks();
  }
});

window.deleteSourcebook = async function (id) {
  if (!confirm("Delete this sourcebook?")) return;
  const result = await api("DELETE", `/api/sourcebooks/${id}`);
  if (result) await loadSourcebooks();
};

// --- Missions ---
async function loadMissions() {
  const campaignParam = activeCampaignId ? `?campaign_id=${activeCampaignId}` : "";
  missions = (await api("GET", `/api/missions${campaignParam}`)) || [];
  renderMissions();
  renderHistory();
}

function missionLabel(m) {
  let label = "";
  if (m.mission_number) label += `<span class="mission-num">#${m.mission_number}</span> `;
  label += esc(m.title);
  return label;
}

function renderMissions() {
  const el = document.getElementById("mission-list");
  const noCampaignMsg = document.getElementById("no-campaign-msg");

  if (!activeCampaignId) {
    noCampaignMsg.classList.remove("hidden");
  } else {
    noCampaignMsg.classList.add("hidden");
  }

  const incomplete = missions.filter((m) => !m.completed);
  const isAdmin = currentUser?.is_admin;

  if (!incomplete.length) {
    el.innerHTML = activeCampaignId
      ? '<p class="empty-state">All missions completed in this campaign!</p>'
      : (missions.length ? '<p class="empty-state">No incomplete missions.</p>' : '<p class="empty-state">No missions yet.</p>');
    return;
  }

  const grouped = {};
  for (const m of incomplete) {
    (grouped[m.sourcebook] ||= []).push(m);
  }

  el.innerHTML = Object.entries(grouped)
    .map(
      ([source, items]) => `
    <h3>${esc(source)}</h3>
    ${items
      .map(
        (m) => `
      <div class="item">
        <div class="title">
          ${missionLabel(m)}
          <div class="tag-list">${renderTagPills(m.tags, m.enemy_types)}</div>
        </div>
        ${isAdmin ? `<button class="btn-edit" onclick="openEditModal(${m.id})" title="Edit">edit</button>` : ""}
        ${activeCampaignId ? `
          <button class="btn-success" onclick="completeMission(${m.id}, 'success')" title="Mark success">pass</button>
          <button class="btn-fail" onclick="completeMission(${m.id}, 'failure')" title="Mark failure">fail</button>
        ` : ""}
        ${isAdmin ? `<button class="btn-delete" onclick="deleteMission(${m.id})">remove</button>` : ""}
      </div>`
      )
      .join("")}`
    )
    .join("");
}

function renderHistory() {
  const el = document.getElementById("history-list");
  const completed = missions.filter((m) => m.completed);
  if (!completed.length) {
    el.innerHTML = '<p class="empty-state">No completed missions yet.</p>';
    return;
  }
  const isAdmin = currentUser?.is_admin;
  el.innerHTML = completed
    .map(
      (m) => `
    <div class="item completed">
      <div class="title">
        ${missionLabel(m)}
        <div class="tag-list">${renderTagPills(m.tags, m.enemy_types)}</div>
      </div>
      <span class="source-tag">${esc(m.sourcebook)}</span>
      <span class="result-badge ${m.result}">${m.result}</span>
      ${isAdmin ? `<button class="btn-edit" onclick="openEditModal(${m.id})" title="Edit">edit</button>` : ""}
      ${activeCampaignId ? `<button class="btn-undo" onclick="undoComplete(${m.id})" title="Mark incomplete">undo</button>` : ""}
    </div>`
    )
    .join("");
}

// Add mission
document.getElementById("add-mission-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("mission-title");
  const sourcebook = document.getElementById("mission-sourcebook");
  const missionNum = document.getElementById("mission-number");
  const checkedTagIds = [...document.querySelectorAll('#mission-tags input[type="checkbox"]:checked')].map(
    (cb) => Number(cb.value)
  );

  const result = await api("POST", "/api/missions", {
    title: title.value,
    sourcebook_id: Number(sourcebook.value),
    mission_number: missionNum.value ? Number(missionNum.value) : null,
    tags: checkedTagIds,
    enemy_types: selectedEnemies,
  });
  if (result) {
    const nextNum = missionNum.value ? Number(missionNum.value) + 1 : "";
    title.value = "";
    missionNum.value = nextNum;
    document.querySelectorAll('#mission-tags input[type="checkbox"]').forEach((cb) => (cb.checked = false));
    selectedEnemies = [];
    addEnemyCtrl.renderPills();
    await loadMissions();
    title.focus();
  }
});

window.deleteMission = async function (id) {
  if (!confirm("Remove this mission?")) return;
  const result = await api("DELETE", `/api/missions/${id}`);
  if (result) await loadMissions();
};

window.completeMission = async function (id, result) {
  if (!activeCampaignId) return;
  await api("POST", `/api/campaigns/${activeCampaignId}/completions`, { mission_id: id, result });
  await loadMissions();
};

window.undoComplete = async function (id) {
  if (!activeCampaignId) return;
  await api("DELETE", `/api/campaigns/${activeCampaignId}/completions/${id}`);
  await loadMissions();
};

// --- Edit modal ---
const editModal = document.getElementById("edit-modal");

window.openEditModal = function (id) {
  const m = missions.find((x) => x.id === id);
  if (!m) return;

  document.getElementById("edit-mission-id").value = m.id;
  document.getElementById("edit-mission-title").value = m.title;
  document.getElementById("edit-mission-number").value = m.mission_number || "";
  renderSourcebookDropdown("edit-mission-sourcebook", m.sourcebook_id);
  renderTagCheckboxes("edit-mission-tags", m.tags.map((t) => t.id));

  editSelectedEnemies = m.enemy_types.map((e) => e.name);
  editEnemyCtrl.renderPills();

  editModal.classList.remove("hidden");
};

document.getElementById("edit-cancel").addEventListener("click", () => {
  editModal.classList.add("hidden");
});

editModal.addEventListener("click", (e) => {
  if (e.target === editModal) editModal.classList.add("hidden");
});

document.getElementById("edit-mission-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = Number(document.getElementById("edit-mission-id").value);
  const title = document.getElementById("edit-mission-title").value;
  const sourcebook_id = Number(document.getElementById("edit-mission-sourcebook").value);
  const mission_number = document.getElementById("edit-mission-number").value;
  const tags = [...document.querySelectorAll('#edit-mission-tags input[type="checkbox"]:checked')].map(
    (cb) => Number(cb.value)
  );

  const result = await api("PATCH", `/api/missions/${id}`, {
    title,
    sourcebook_id,
    mission_number: mission_number ? Number(mission_number) : null,
    tags,
    enemy_types: editSelectedEnemies,
  });
  if (result) {
    editModal.classList.add("hidden");
    await loadMissions();
  }
});

// --- Import / Export ---
document.getElementById("export-btn").addEventListener("click", async () => {
  const data = await api("GET", "/api/export");
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `brimstone-export-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm("Import will add or update missions, sourcebooks, tags, and enemy types. Existing completion tracking will not be affected. Continue?")) {
    e.target.value = "";
    return;
  }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await api("POST", "/api/import", data);
    if (result) {
      alert(`Import complete: ${result.counts.sourcebooks} sourcebooks, ${result.counts.missions} missions, ${result.counts.tags} tags, ${result.counts.enemy_types} enemy types.`);
      await loadTags();
      await loadSourcebooks();
      await loadEnemyTypes();
      await loadMissions();
    }
  } catch (err) {
    alert("Failed to parse import file: " + err.message);
  }
  e.target.value = "";
});

// --- Randomizer ---
function renderRandomizerTags() {
  const el = document.getElementById("randomizer-tags");
  if (!el) return;
  el.innerHTML = allTags
    .map((t) => `<span class="tag-filter" data-id="${t.id}" data-state="ignore">${esc(t.name)}</span>`)
    .join("");
  el.querySelectorAll(".tag-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      const states = ["ignore", "include", "exclude"];
      const cur = states.indexOf(btn.dataset.state);
      btn.dataset.state = states[(cur + 1) % 3];
    });
  });
}

document.getElementById("pick-random").addEventListener("click", async () => {
  const checked = [
    ...document.querySelectorAll('#randomizer-sourcebooks input[type="checkbox"]:checked'),
  ].map((cb) => Number(cb.value));

  const include_tag_ids = [...document.querySelectorAll('.tag-filter[data-state="include"]')].map(
    (el) => Number(el.dataset.id)
  );
  const exclude_tag_ids = [...document.querySelectorAll('.tag-filter[data-state="exclude"]')].map(
    (el) => Number(el.dataset.id)
  );

  const body = {
    sourcebook_ids: checked,
    include_tag_ids,
    exclude_tag_ids,
  };
  if (activeCampaignId) body.campaign_id = activeCampaignId;

  const result = await api("POST", "/api/missions/random", body);
  const el = document.getElementById("random-result");
  if (result) {
    el.classList.remove("hidden");
    el.innerHTML = `
      <div class="mission-name">${esc(result.title)}</div>
      <div class="mission-source">${esc(result.sourcebook)}${result.mission_number ? ` — Mission #${result.mission_number}` : ""}</div>
      ${result.tags.length || result.enemy_types.length ? `<div class="tag-list" style="justify-content:center;margin-top:0.5rem">${renderTagPills(result.tags, result.enemy_types)}</div>` : ""}`;
  }
});

// --- Util ---
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// --- Init ---
async function initApp() {
  showApp();
  await loadCampaigns();
  await loadTags();
  await loadSourcebooks();
  await loadEnemyTypes();
  await loadMissions();
}

(async () => {
  const { ok, data } = await authApi("GET", "/api/auth/me");
  if (ok) {
    currentUser = data;
    await initApp();
  } else {
    showLogin();
  }
})();
