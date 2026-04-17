const API = "";

// --- State ---
let sourcebooks = [];
let missions = [];
let allTags = []; // [{id, name}, ...]
let selectedEnemies = []; // for add form
let editSelectedEnemies = []; // for edit modal

// --- API helpers ---
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Something went wrong");
    return null;
  }
  return data;
}

// --- Tabs ---
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// --- Tags ---
async function loadTags() {
  allTags = await api("GET", "/api/tags");
  renderTagCheckboxes("mission-tags");
  renderTagList();
  renderRandomizerTags();
}

function renderTagCheckboxes(containerId, checkedIds) {
  const el = document.getElementById(containerId);
  el.innerHTML = allTags
    .map((t) => {
      const checked = checkedIds && checkedIds.includes(t.id) ? "checked" : "";
      return `<label><input type="checkbox" value="${t.id}" ${checked}> ${esc(t.name)}</label>`;
    })
    .join("");
}

function renderTagList() {
  const el = document.getElementById("tag-list");
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
    html += enemies
      .map((e) => `<span class="tag-pill enemy">${esc(e.name)}</span>`)
      .join("");
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
let allEnemyTypes = [];

async function loadEnemyTypes() {
  allEnemyTypes = await api("GET", "/api/enemy-types");
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

  // Initial render
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

// Set up add-form enemy search
const addEnemyCtrl = setupEnemySearch(
  "enemy-search", "enemy-suggestions", "enemy-selected",
  () => selectedEnemies,
  (v) => { selectedEnemies = v; }
);

// Set up edit-form enemy search
const editEnemyCtrl = setupEnemySearch(
  "edit-enemy-search", "edit-enemy-suggestions", "edit-enemy-selected",
  () => editSelectedEnemies,
  (v) => { editSelectedEnemies = v; }
);

// Close suggestions when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".enemy-input-wrap")) {
    document.querySelectorAll(".suggestions").forEach((el) => el.classList.add("hidden"));
  }
});

// --- Sourcebooks ---
async function loadSourcebooks() {
  sourcebooks = await api("GET", "/api/sourcebooks");
  renderSourcebooks();
  renderSourcebookDropdown("mission-sourcebook");
  renderSourcebookDropdown("edit-mission-sourcebook");
  renderRandomizerSourcebooks();
}

function renderSourcebooks() {
  const el = document.getElementById("sourcebook-list");
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
  sel.innerHTML =
    '<option value="">Sourcebook…</option>' +
    sourcebooks
      .map((s) => `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${esc(s.name)}</option>`)
      .join("");
}

function renderRandomizerSourcebooks() {
  document.getElementById("randomizer-sourcebook-toggles").innerHTML =
    `<span class="select-toggle" onclick="toggleRandomizerSourcebooks(true)">all</span> / <span class="select-toggle" onclick="toggleRandomizerSourcebooks(false)">none</span>`;
  const el = document.getElementById("randomizer-sourcebooks");
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
  missions = await api("GET", "/api/missions");
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
  const incomplete = missions.filter((m) => !m.completed);
  if (!incomplete.length) {
    el.innerHTML = '<p class="empty-state">No missions yet. Add one above.</p>';
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
        <button class="btn-edit" onclick="openEditModal(${m.id})" title="Edit">edit</button>
        <button class="btn-success" onclick="completeMission(${m.id}, 'success')" title="Mark success">pass</button>
        <button class="btn-fail" onclick="completeMission(${m.id}, 'failure')" title="Mark failure">fail</button>
        <button class="btn-delete" onclick="deleteMission(${m.id})">remove</button>
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
      <button class="btn-edit" onclick="openEditModal(${m.id})" title="Edit">edit</button>
      <button class="btn-undo" onclick="undoComplete(${m.id})" title="Mark incomplete">undo</button>
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
  await api("PATCH", `/api/missions/${id}`, { completed: true, result });
  await loadMissions();
};

window.undoComplete = async function (id) {
  await api("PATCH", `/api/missions/${id}`, { completed: false, result: null });
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

// --- Randomizer ---
function renderRandomizerTags() {
  const el = document.getElementById("randomizer-tags");
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

  const result = await api("POST", "/api/missions/random", {
    sourcebook_ids: checked,
    include_tag_ids,
    exclude_tag_ids,
  });
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
(async () => {
  await loadTags();
  await loadSourcebooks();
  await loadEnemyTypes();
  await loadMissions();
})();
