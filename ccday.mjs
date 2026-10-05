#!/usr/bin/env node
// ccday — usage Claude Code du jour, par modèle. Inspiré de ccusage.
// Usage: ccday [--date YYYY-MM-DD] [--json] [--no-cost]
import { readdir, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = opt('date') ?? localDay(new Date());

const roots = (process.env.CLAUDE_CONFIG_DIR?.split(',') ?? [join(homedir(), '.claude'), join(homedir(), '.config', 'claude')])
  .map((r) => join(r.trim(), 'projects'));

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// --- collecte : une entrée par (message.id, requestId), dernière occurrence gagne
const rows = new Map();
const dayStart = new Date(`${day}T00:00:00`).getTime();
for (const root of roots) {
  for await (const file of walk(root)) {
    // fichier pas modifié depuis le début du jour => rien à lire
    if ((await stat(file)).mtimeMs < dayStart) continue;
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const u = j.message?.usage;
      const model = j.message?.model;
      if (!u || !model || model === '<synthetic>' || !j.timestamp) continue;
      if (localDay(new Date(j.timestamp)) !== day) continue;
      const key = j.message.id && j.requestId ? `${j.message.id}:${j.requestId}` : j.uuid ?? line;
      rows.set(key, { model, u });
    }
  }
}

const byModel = new Map();
for (const { model, u } of rows.values()) {
  const m = byModel.get(model) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  m.input += u.input_tokens ?? 0;
  m.output += u.output_tokens ?? 0;
  m.cacheCreate += u.cache_creation_input_tokens ?? 0;
  m.cacheRead += u.cache_read_input_tokens ?? 0;
  byModel.set(model, m);
}

// --- coût (prix LiteLLM, mis en cache 24h)
async function loadPrices() {
  const cacheDir = join(homedir(), '.cache', 'ccday');
  const cacheFile = join(cacheDir, 'prices.json');
  try {
    const s = await stat(cacheFile);
    if (Date.now() - s.mtimeMs < 864e5) return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {}
  try {
    const r = await fetch('https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json');
    const all = await r.json();
    const prices = Object.fromEntries(Object.entries(all).filter(([k]) => k.includes('claude')));
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(prices));
    return prices;
  } catch {
    try { return JSON.parse(await readFile(cacheFile, 'utf8')); } catch { return {}; }
  }
}
const findPrice = (prices, model) =>
  prices[model] ?? prices[`anthropic/${model}`] ??
  Object.entries(prices).find(([k]) => k.endsWith(model) || model.startsWith(k.replace(/^anthropic\//, '')))?.[1];

const prices = flag('no-cost') ? {} : await loadPrices();
const costOf = (model, m) => {
  const p = findPrice(prices, model);
  if (!p) return null;
  return m.input * (p.input_cost_per_token ?? 0) + m.output * (p.output_cost_per_token ?? 0) +
    m.cacheCreate * (p.cache_creation_input_token_cost ?? 0) + m.cacheRead * (p.cache_read_input_token_cost ?? 0);
};

const out = [...byModel].map(([model, m]) => ({
  model, ...m, total: m.input + m.output + m.cacheCreate + m.cacheRead, cost: costOf(model, m),
})).sort((a, b) => b.total - a.total);

if (flag('json')) { console.log(JSON.stringify({ date: day, models: out }, null, 2)); process.exit(0); }

// --- affichage
const n = (x) => x.toLocaleString('en-US');
const usd = (c) => (c == null ? '-' : `$${c.toFixed(2)}`);
const head = ['Model', 'Input', 'Output', 'Cache Create', 'Cache Read', 'Total Tokens', 'Cost'];
const toRow = (r, name) => [name, n(r.input), n(r.output), n(r.cacheCreate), n(r.cacheRead), n(r.total), usd(r.cost)];
const sum = out.reduce((a, r) => ({
  input: a.input + r.input, output: a.output + r.output, cacheCreate: a.cacheCreate + r.cacheCreate,
  cacheRead: a.cacheRead + r.cacheRead, total: a.total + r.total, cost: a.cost + (r.cost ?? 0),
}), { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, cost: 0 });
const table = [head, ...out.map((r) => toRow(r, r.model)), ...(out.length > 1 ? [toRow(sum, 'Total')] : [])];
const w = head.map((_, i) => Math.max(...table.map((r) => r[i].length)));
const fmt = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
console.log(`\nClaude Code — ${day}\n`);
if (!out.length) console.log('Aucune consommation.');
else {
  console.log(fmt(table[0]));
  console.log(w.map((x) => '─'.repeat(x)).join('  '));
  table.slice(1).forEach((r, i) => {
    if (out.length > 1 && i === table.length - 2) console.log(w.map((x) => '─'.repeat(x)).join('  '));
    console.log(fmt(r));
  });
}
console.log();
