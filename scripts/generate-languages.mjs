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
  "X-GitHub-Api-Version": "2022-11-28",
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

function renderSvg(rows) {
  const width = 700;
  const paddingX = 16;
  const paddingY = 12;
  const rowHeight = 24;
  const height = paddingY * 2 + rows.length * rowHeight;

  const innerLeft = paddingX;
  const innerRight = width - paddingX;

  const dotX = innerLeft + 8;
  const nameX = innerLeft + 22;

  const bytesRightX = innerRight - 18;
  const percentRightX = bytesRightX - 92;

  const nameColWidth = 120;
  const barX = nameX + nameColWidth + 14;
  const barRight = percentRightX - 18;
  const barWidth = Math.max(120, barRight - barX);

  const rowsSvg = rows
    .map((row, index) => {
      const y = paddingY + index * rowHeight + 16;
      const barY = y - 8;
      const fillWidth =
        row.percent <= 0
          ? 0
          : Math.max(4, Math.round((row.percent / 100) * barWidth));

      return `
  <circle cx="${dotX}" cy="${y - 3}" r="4" fill="${row.color}" />
  <text x="${nameX}" y="${y}" class="lang">${escapeXml(row.name)}</text>

  <rect x="${barX}" y="${barY}" width="${barWidth}" height="8" rx="4" fill="#2b3250" />
  <rect x="${barX}" y="${barY}" width="${fillWidth}" height="8" rx="4" fill="${row.color}" />

  <text x="${percentRightX}" y="${y}" class="percent">${row.percent.toFixed(1)}%</text>
  <text x="${bytesRightX}" y="${y}" class="bytes">${escapeXml(formatBytes(row.bytes))}</text>
`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Languages">
  <style>
    .lang { font: 600 14px 'Segoe UI', Ubuntu, Sans-Serif; fill: #e5e9f0; }
    .percent { font: 600 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #7aa2f7; text-anchor: end; }
    .bytes { font: 400 13px 'Segoe UI', Ubuntu, Sans-Serif; fill: #9aa5ce; text-anchor: end; }
  </style>

  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="#1a1b27" stroke="#2f334d"/>
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

  fs.writeFileSync(path.join(outDir, "languages.svg"), renderSvg(rows));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});