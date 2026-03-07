/* global Chart */

const API = "";
let currentProject = "";
let currentTab = "overview";
let memoryPage = 0;
const PAGE_SIZE = 50;

const CATEGORY_COLORS = {
  fact: "#58a6ff",
  preference: "#bc8cff",
  decision: "#d29922",
  code_pattern: "#3fb950",
  error: "#f85149",
  conversation: "#f0883e",
};

const SOURCE_COLORS = {
  user_message: "#58a6ff",
  assistant_message: "#bc8cff",
  system: "#8b949e",
  file_content: "#3fb950",
  long_term_memory: "#d29922",
};

// Chart instances
const charts = {};

// ─── API helpers ───

async function api(path, params = {}) {
  const query = new URLSearchParams();
  if (currentProject) query.set("project", currentProject);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") query.set(k, String(v));
  }
  const sep = query.toString() ? "?" : "";
  const res = await fetch(`${API}${path}${sep}${query}`);
  return res.json();
}

// ─── Init ───

async function init() {
  await loadProjects();
  await refreshAll();
}

async function refreshAll() {
  const tab = currentTab;
  if (tab === "overview") await loadOverview();
  if (tab === "memories") await loadMemories();
  if (tab === "decay") await loadDecay();
  if (tab === "telemetry") await loadTelemetry();
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  document.querySelectorAll("[id^='tab-']").forEach((el) => {
    el.style.display = el.id === `tab-${tab}` ? "" : "none";
  });
  refreshAll();
}

// ─── Projects ───

async function loadProjects() {
  const projects = await api("/api/projects");
  const list = document.getElementById("project-list");
  const totalCount = projects.reduce((sum, p) => sum + p.count, 0);

  list.innerHTML = `
    <li class="project-item active" data-project="" onclick="selectProject('', this)">
      All Projects
      <span class="count">${totalCount}</span>
    </li>
    ${projects.map((p) => `
      <li class="project-item" data-project="${esc(p.project)}" onclick="selectProject('${esc(p.project)}', this)">
        ${escHtml(shortProject(p.project))}
        <span class="count">${p.count}</span>
      </li>
    `).join("")}
  `;
}

function selectProject(project, el) {
  currentProject = project;
  document.querySelectorAll(".project-item").forEach((p) => p.classList.remove("active"));
  el.classList.add("active");

  const title = project ? shortProject(project) : "All Projects";
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-subtitle").textContent = project
    ? project
    : "Overview of all stored memories";

  memoryPage = 0;
  refreshAll();
}

function shortProject(path) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

// ─── Overview Tab ───

async function loadOverview() {
  const [stats, timeline, projects] = await Promise.all([
    api("/api/stats"),
    api("/api/timeline", { days: 30 }),
    api("/api/projects"),
  ]);

  renderOverviewCards(stats, projects);
  renderTimelineChart(timeline);
  renderCategoryChart(stats.byCategory);
  renderSourceChart(stats.bySource);
  renderProjectComparison(projects);
}

function renderOverviewCards(stats, projects) {
  const atRisk = stats.neverAccessed;
  const el = document.getElementById("overview-cards");
  el.innerHTML = `
    <div class="card">
      <div class="card-label">Total Memories</div>
      <div class="card-value accent">${stats.totalChunks.toLocaleString()}</div>
      <div class="card-sub">${Object.keys(stats.byCategory).length} categories</div>
    </div>
    <div class="card">
      <div class="card-label">Projects</div>
      <div class="card-value">${projects.length}</div>
      <div class="card-sub">active projects</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Importance</div>
      <div class="card-value ${stats.avgImportance < 0.3 ? 'yellow' : 'green'}">${stats.avgImportance.toFixed(2)}</div>
      <div class="card-sub">base importance score</div>
    </div>
    <div class="card">
      <div class="card-label">Never Accessed</div>
      <div class="card-value ${atRisk > stats.totalChunks * 0.5 ? 'red' : 'yellow'}">${atRisk}</div>
      <div class="card-sub">${stats.totalChunks > 0 ? Math.round(atRisk / stats.totalChunks * 100) : 0}% of total</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Access Count</div>
      <div class="card-value">${stats.avgAccessCount.toFixed(1)}</div>
      <div class="card-sub">per memory</div>
    </div>
  `;
}

function renderTimelineChart(data) {
  destroyChart("timeline-chart");
  const ctx = document.getElementById("timeline-chart").getContext("2d");
  charts["timeline-chart"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: data.map((d) => d.date),
      datasets: [{
        label: "Memories Created",
        data: data.map((d) => d.count),
        backgroundColor: "rgba(88, 166, 255, 0.6)",
        borderColor: "#58a6ff",
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e", maxTicksLimit: 15 },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
      },
    },
  });
}

function renderCategoryChart(byCategory) {
  destroyChart("category-chart");
  const labels = Object.keys(byCategory);
  const values = Object.values(byCategory);
  const colors = labels.map((l) => CATEGORY_COLORS[l] || "#8b949e");

  const ctx = document.getElementById("category-chart").getContext("2d");
  charts["category-chart"] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#8b949e", padding: 12, font: { size: 12 } },
        },
      },
    },
  });
}

function renderSourceChart(bySource) {
  destroyChart("source-chart");
  const labels = Object.keys(bySource);
  const values = Object.values(bySource);
  const colors = labels.map((l) => SOURCE_COLORS[l] || "#8b949e");

  const ctx = document.getElementById("source-chart").getContext("2d");
  charts["source-chart"] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#8b949e", padding: 12, font: { size: 12 } },
        },
      },
    },
  });
}

function renderProjectComparison(projects) {
  const panel = document.getElementById("project-comparison");
  if (currentProject || projects.length < 2) {
    panel.style.display = "none";
    return;
  }
  panel.style.display = "";
  destroyChart("project-chart");

  const ctx = document.getElementById("project-chart").getContext("2d");
  charts["project-chart"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: projects.map((p) => shortProject(p.project)),
      datasets: [{
        label: "Memories",
        data: projects.map((p) => p.count),
        backgroundColor: projects.map((_, i) => {
          const colors = ["#58a6ff", "#bc8cff", "#3fb950", "#d29922", "#f0883e", "#f85149", "#f778ba"];
          return colors[i % colors.length];
        }),
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: { legend: { display: false } },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
        y: {
          grid: { display: false },
          ticks: { color: "#e6edf3", font: { size: 13 } },
        },
      },
    },
  });
}

// ─── Memories Tab ───

async function loadMemories() {
  const category = document.getElementById("mem-category-filter").value;
  const sort = document.getElementById("mem-sort").value;

  const data = await api("/api/memories", {
    limit: PAGE_SIZE,
    offset: memoryPage * PAGE_SIZE,
    category,
    sort,
  });

  renderMemoriesTable(data.memories, data.total);
}

function renderMemoriesTable(memories, total) {
  const container = document.getElementById("memories-table");

  if (memories.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>No memories found</h3></div>';
    document.getElementById("memories-pagination").innerHTML = "";
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Content</th>
          <th>Category</th>
          <th>Source</th>
          <th>Importance</th>
          <th>Accessed</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        ${memories.map((m) => {
          const tags = JSON.parse(m.tags || "[]");
          const date = new Date(m.timestamp).toLocaleDateString();
          const importance = m.importance;
          const barColor = importance >= 0.7 ? "#3fb950" : importance >= 0.4 ? "#d29922" : "#f85149";
          return `
            <tr title="${escHtml(m.content)}">
              <td>${escHtml(truncate(m.content, 80))}</td>
              <td><span class="badge badge-${m.category}">${m.category}</span></td>
              <td>${m.source}</td>
              <td>
                <div class="importance-bar">
                  <div class="importance-bar-fill" style="width:${importance * 100}%; background:${barColor}"></div>
                </div>
                ${importance.toFixed(2)}
              </td>
              <td>${m.access_count || 0}</td>
              <td>${date}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;

  const totalPages = Math.ceil(total / PAGE_SIZE);
  document.getElementById("memories-pagination").innerHTML = `
    <button ${memoryPage === 0 ? "disabled" : ""} onclick="memoryPage--; loadMemories()">Prev</button>
    <span class="page-info">Page ${memoryPage + 1} of ${totalPages} (${total} total)</span>
    <button ${memoryPage >= totalPages - 1 ? "disabled" : ""} onclick="memoryPage++; loadMemories()">Next</button>
  `;
}

// ─── Decay Tab ───

async function loadDecay() {
  const [decayData, topAccessed] = await Promise.all([
    api("/api/decay"),
    api("/api/top-accessed", { limit: 20 }),
  ]);

  renderDecayScatter(decayData);
  renderTopAccessedTable(topAccessed);
}

function renderDecayScatter(data) {
  destroyChart("decay-scatter");
  const ctx = document.getElementById("decay-scatter").getContext("2d");

  const datasets = {};
  for (const d of data) {
    if (!datasets[d.category]) {
      datasets[d.category] = {
        label: d.category,
        data: [],
        backgroundColor: (CATEGORY_COLORS[d.category] || "#8b949e") + "99",
        pointRadius: 4,
        pointHoverRadius: 6,
      };
    }
    datasets[d.category].data.push({
      x: d.ageDays,
      y: d.effectiveImportance,
    });
  }

  charts["decay-scatter"] = new Chart(ctx, {
    type: "scatter",
    data: { datasets: Object.values(datasets) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: "#8b949e", padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `Age: ${ctx.parsed.x}d, Eff.Imp: ${ctx.parsed.y.toFixed(3)}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Age (days)", color: "#8b949e" },
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
        y: {
          title: { display: true, text: "Effective Importance", color: "#8b949e" },
          min: 0,
          max: 1,
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
      },
      // Prune threshold line
      annotation: {
        annotations: {
          pruneLine: {
            type: "line",
            yMin: 0.05,
            yMax: 0.05,
            borderColor: "#f85149",
            borderWidth: 1,
            borderDash: [5, 5],
          },
        },
      },
    },
    plugins: [{
      id: "pruneLine",
      afterDraw(chart) {
        const yScale = chart.scales.y;
        const ctx = chart.ctx;
        const y = yScale.getPixelForValue(0.05);
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([5, 5]);
        ctx.moveTo(chart.chartArea.left, y);
        ctx.lineTo(chart.chartArea.right, y);
        ctx.strokeStyle = "#f8514980";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#f85149";
        ctx.font = "11px sans-serif";
        ctx.fillText("Prune threshold (0.05)", chart.chartArea.left + 8, y - 6);
        ctx.restore();
      },
    }],
  });
}

function renderTopAccessedTable(memories) {
  const container = document.getElementById("top-accessed-table");

  if (memories.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>No accessed memories yet</h3></div>';
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Content</th>
          <th>Category</th>
          <th>Access Count</th>
          <th>Last Accessed</th>
          <th>Importance</th>
        </tr>
      </thead>
      <tbody>
        ${memories.map((m) => {
          const lastAcc = m.last_accessed ? new Date(m.last_accessed).toLocaleString() : "Never";
          return `
            <tr title="${escHtml(m.content)}">
              <td>${escHtml(truncate(m.content, 80))}</td>
              <td><span class="badge badge-${m.category}">${m.category}</span></td>
              <td>${m.access_count}</td>
              <td>${lastAcc}</td>
              <td>${m.importance.toFixed(2)}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ─── Telemetry Tab ───

async function loadTelemetry() {
  const [summary, events] = await Promise.all([
    api("/api/telemetry/summary", { days: 7 }),
    api("/api/telemetry", { days: 7 }),
  ]);

  renderTelemetryCards(summary);
  renderTelemetryTimeline(summary.eventsPerDay);
  renderToolUsageChart(summary.toolCalls);
  renderToolLatencyChart(summary.toolCalls);
  renderTelemetryTable(events);
}

function renderTelemetryCards(summary) {
  const tools = Object.keys(summary.toolCalls);
  const totalCalls = tools.reduce((sum, t) => sum + summary.toolCalls[t].count, 0);
  const avgLatency = tools.length > 0
    ? Math.round(tools.reduce((sum, t) => sum + summary.toolCalls[t].avgLatency * summary.toolCalls[t].count, 0) / (totalCalls || 1))
    : 0;
  const avgSuccess = tools.length > 0
    ? Math.round(tools.reduce((sum, t) => sum + summary.toolCalls[t].successRate, 0) / tools.length)
    : 0;

  document.getElementById("telemetry-cards").innerHTML = `
    <div class="card">
      <div class="card-label">Tool Calls (7d)</div>
      <div class="card-value accent">${totalCalls}</div>
      <div class="card-sub">${tools.length} distinct tools</div>
    </div>
    <div class="card">
      <div class="card-label">Avg Latency</div>
      <div class="card-value ${avgLatency > 1000 ? 'yellow' : 'green'}">${avgLatency}ms</div>
      <div class="card-sub">per tool call</div>
    </div>
    <div class="card">
      <div class="card-label">Success Rate</div>
      <div class="card-value ${avgSuccess < 90 ? 'yellow' : 'green'}">${avgSuccess}%</div>
      <div class="card-sub">across all tools</div>
    </div>
    <div class="card">
      <div class="card-label">Events/Day</div>
      <div class="card-value">${summary.eventsPerDay.length > 0 ? Math.round(totalCalls / summary.eventsPerDay.length) : 0}</div>
      <div class="card-sub">average</div>
    </div>
  `;
}

function renderTelemetryTimeline(eventsPerDay) {
  destroyChart("telemetry-timeline");
  const ctx = document.getElementById("telemetry-timeline").getContext("2d");
  charts["telemetry-timeline"] = new Chart(ctx, {
    type: "line",
    data: {
      labels: eventsPerDay.map((d) => d.date),
      datasets: [{
        label: "Events",
        data: eventsPerDay.map((d) => d.count),
        borderColor: "#58a6ff",
        backgroundColor: "rgba(88, 166, 255, 0.1)",
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: "#58a6ff",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
      },
    },
  });
}

function renderToolUsageChart(toolCalls) {
  destroyChart("tool-usage-chart");
  const labels = Object.keys(toolCalls);
  const values = labels.map((l) => toolCalls[l].count);
  const colors = ["#58a6ff", "#bc8cff", "#3fb950", "#d29922", "#f0883e", "#f85149"];

  const ctx = document.getElementById("tool-usage-chart").getContext("2d");
  charts["tool-usage-chart"] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels.map((l) => l.replace("memory_", "")),
      datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "right",
          labels: { color: "#8b949e", padding: 10, font: { size: 11 } },
        },
      },
    },
  });
}

function renderToolLatencyChart(toolCalls) {
  destroyChart("tool-latency-chart");
  const labels = Object.keys(toolCalls).map((l) => l.replace("memory_", ""));
  const values = Object.values(toolCalls).map((v) => v.avgLatency);
  const colors = values.map((v) => v > 1000 ? "#f85149" : v > 500 ? "#d29922" : "#3fb950");

  const ctx = document.getElementById("tool-latency-chart").getContext("2d");
  charts["tool-latency-chart"] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Avg Latency (ms)",
        data: values,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: "#8b949e" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(48, 54, 61, 0.5)" },
          ticks: { color: "#8b949e" },
        },
      },
    },
  });
}

function renderTelemetryTable(events) {
  const container = document.getElementById("telemetry-table");

  if (events.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No telemetry events yet</h3>
        <p style="color: var(--text-muted)">Events will appear as tools are used via MCP</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Event</th>
          <th>Tool</th>
          <th>Latency</th>
          <th>Status</th>
          <th>Project</th>
        </tr>
      </thead>
      <tbody>
        ${events.slice(0, 100).map((e) => {
          const time = new Date(e.timestamp).toLocaleString();
          const status = e.success === 1 ? '<span style="color:#3fb950">OK</span>' :
                         e.success === 0 ? '<span style="color:#f85149">FAIL</span>' : "-";
          return `
            <tr>
              <td>${time}</td>
              <td>${e.event_type}</td>
              <td>${e.tool_name || "-"}</td>
              <td>${e.latency_ms != null ? e.latency_ms + "ms" : "-"}</td>
              <td>${status}</td>
              <td>${e.project ? escHtml(shortProject(e.project)) : "-"}</td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ─── Helpers ───

function destroyChart(id) {
  if (charts[id]) {
    charts[id].destroy();
    delete charts[id];
  }
}

function esc(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "..." : str;
}

// Start
init();
