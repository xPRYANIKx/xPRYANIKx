import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.USERNAME;
const GH_TOKEN = process.env.GH_TOKEN || "";
const INCLUDE_FORKS = String(process.env.INCLUDE_FORKS).toLowerCase() === "true";
const EXCLUDE_REPOS = new Set(
  String(process.env.EXCLUDE_REPOS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);
const MIN_PERCENT = Number(process.env.MIN_PERCENT || "0");

if (!USERNAME) {
  throw new Error("USERNAME is required");
}

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "github-profile-languages-card",
  "X-GitHub-Api-Version": "2026-03-10",
};

if (GH_TOKEN) {
  headers.Authorization = `Bearer ${GH_TOKEN}`;
}

async function gh(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status} for ${url}\n${text}`);
  }
  return res.json();
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function colorFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 60%)`;
}

async function getAllRepos(username) {
  const repos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/users/${encodeURIComponent(username)}/repos?type=owner&sort=updated&per_page=100&page=${page}`;
    const batch = await gh(url);

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    repos.push(...batch);

    if (batch.length < 100) {
      break;
    }

    page++;
  }

  return repos
    .filter((repo) => INCLUDE_FORKS || !repo.fork)
    .filter((repo) => !repo.archived)
    .filter((repo) => !EXCLUDE_REPOS.has(repo.name));
}

async function getLanguages(owner, repo) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`;
  return gh(url);
}

function renderSvg(rows, repoCount) {
  const width = 760;
  const padding = 24;
  const headerHeight = 94;
  const rowHeight = 28;
  const footerHeight = 22;
  const height = headerHeight + rows.length * rowHeight + footerHeight;
  const maxValue = rows[0]?.bytes || 1;

  const generatedAt = new Date().toISOString().slice(0, 19).replace("T", " ");

  const rowsSvg = rows
    .map((row, index) => {
      const y = headerHeight + index * rowHeight;
      const barX = 250;
      const barY = y - 12;
      const barWidth = 220;
      const fillWidth = Math.max(6, Math.round((row.bytes / maxValue) * barWidth));

      return `
  <circle cx="32" cy="${y - 4}" r="5" fill="${row.color}" />
  <text x="46" y="${y}" class="lang">${escapeXml(row.name)}</text>

  <rect x="${barX}" y="${barY}" width="${barWidth}" height="10" rx="5" fill="#2b3250" />
  <rect x="${barX}" y="${barY}" width="${fillWidth}" height="10" rx="5" fill="${row.color}" />

  <text x="490" y="${y}" class="percent">${row.percent.toFixed(1)}%</text>
  <text x="565" y="${y}" class="bytes">${escapeXml(formatBytes(row.bytes))}</text>
`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="All languages across repositories">
  <style>
    .title { font: 700 24px 'Segoe UI', Ubuntu, Sans-Serif; fill: #c0caf5; }
    .sub { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #8b9bb4; }
    .lang { font: 600 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: #e5e9f0; }
    .percent { font: 600 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #7aa2f7; }
    .bytes { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #9aa5ce; }
  </style>

  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" fill="#1a1b27" stroke="#2f334d"/>
  <text x="${padding}" y="36" class="title">All languages</text>
  <text x="${padding}" y="58" class="sub">Public repositories scanned: ${repoCount}</text>
  <text x="${padding}" y="76" class="sub">Source: GitHub /languages endpoint · Generated: ${generatedAt} UTC</text>

  ${rowsSvg}
</svg>`;
}

async function main() {
  const repos = await getAllRepos(USERNAME);

  if (repos.length === 0) {
    throw new Error("No repositories found after filtering.");
  }

  const totals = new Map();

  for (const repo of repos) {
    const languages = await getLanguages(repo.owner.login, repo.name);

    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  const totalBytes = [...totals.values()].reduce((sum, value) => sum + value, 0);

  let rows = [...totals.entries()]
    .map(([name, bytes]) => ({
      name,
      bytes,
      percent: totalBytes > 0 ? (bytes / totalBytes) * 100 : 0,
      color: colorFromName(name),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  if (MIN_PERCENT > 0) {
    rows = rows.filter((row) => row.percent >= MIN_PERCENT);
  }

  const outDir = path.resolve("assets");
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, "languages.json"),
    JSON.stringify(
      {
        username: USERNAME,
        repositories_scanned: repos.map((r) => r.name),
        languages: rows,
        total_bytes: totalBytes,
        generated_at_utc: new Date().toISOString(),
      },
      null,
      2
    )
  );

  fs.writeFileSync(path.join(outDir, "languages.svg"), renderSvg(rows, repos.length));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
