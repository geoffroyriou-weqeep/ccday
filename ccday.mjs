#!/usr/bin/env node
// ccday — usage Claude Code du jour, par modèle. Inspiré de ccusage.
// Usage: ccday [--date YYYY-MM-DD] [--json] [--no-cost] [--effort]
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
      rows.set(key, { model, u, effort: j.perTurnEffort ?? j.effort ?? 'n/a' });
    }
  }
}

const byModel = new Map();
const byEffort = new Map(); // model -> effort -> { msgs, output, thinking }
for (const { model, u, effort } of rows.values()) {
  const m = byModel.get(model) ?? { input: 0, output: 0, cacheCreate: 0, cacheCreate1h: 0, cacheRead: 0 };
  m.input += u.input_tokens ?? 0;
  m.output += u.output_tokens ?? 0;
  m.cacheCreate += u.cache_creation_input_tokens ?? 0;
  m.cacheCreate1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  m.cacheRead += u.cache_read_input_tokens ?? 0;
  byModel.set(model, m);
  const perEffort = byEffort.get(model) ?? new Map();
  const e = perEffort.get(effort) ?? { msgs: 0, output: 0, thinking: 0 };
  e.msgs++;
  e.output += u.output_tokens ?? 0;
  e.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
  perEffort.set(effort, e);
  byEffort.set(model, perEffort);
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
// prix par token pour chaque catégorie (null si modèle inconnu)
const priceOf = (model) => {
  const p = findPrice(prices, model);
  if (!p) return null;
  const c5 = p.cache_creation_input_token_cost ?? 0;
  return {
    input: p.input_cost_per_token ?? 0,
    output: p.output_cost_per_token ?? 0,
    cache5m: c5,
    cache1h: p.cache_creation_input_token_cost_above_1hr ?? c5,
    cacheRead: p.cache_read_input_token_cost ?? 0,
  };
};
const costOf = (m, p) => p && (m.input * p.input + m.output * p.output + (m.cacheCreate - m.cacheCreate1h) * p.cache5m +
  m.cacheCreate1h * p.cache1h + m.cacheRead * p.cacheRead);

const out = [...byModel].map(([model, m]) => {
  const price = priceOf(model);
  return {
    model, ...m, effort: Object.fromEntries(byEffort.get(model)), cacheCreate5m: m.cacheCreate - m.cacheCreate1h,
    total: m.input + m.output + m.cacheCreate + m.cacheRead, price, cost: costOf(m, price),
  };
}).sort((a, b) => b.total - a.total);

if (flag('json')) { console.log(JSON.stringify({ date: day, models: out }, null, 2)); process.exit(0); }

// --- affichage : tableau arrondi, 2 lignes par cellule (tokens puis prix/M)
const useColor = (process.stdout.isTTY && !process.env.NO_COLOR) || process.env.FORCE_COLOR;
const paint = (s, ...codes) => (useColor && codes.filter(Boolean).length ? `\x1b[${codes.filter(Boolean).join(';')}m${s}\x1b[0m` : s);
const BORDER = '90', DIM = '2', BOLD = '1';
const modelColor = (m) => (m.includes('opus') ? '35' : m.includes('sonnet') ? '34' : m.includes('haiku') ? '32' : '33');

const n = (x) => x.toLocaleString('en-US');
const usd = (c) => (c == null ? '-' : `$${c.toFixed(2)}`);
const perM = (p) => (p == null ? '' : `@ $${+(p * 1e6).toFixed(2)}/M`);
const KEYS = ['input', 'output', 'cacheCreate5m', 'cacheCreate1h', 'cacheRead'];
const PKEY = { input: 'input', output: 'output', cacheCreate5m: 'cache5m', cacheCreate1h: 'cache1h', cacheRead: 'cacheRead' };
const head = ['Model', 'Input', 'Output', 'Cache Create 5m', 'Cache Create 1h', 'Cache Read', 'Total Tokens', 'Cost (USD)'];
const short = (m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '');

const sum = out.reduce((a, r) => {
  KEYS.forEach((k) => (a[k] += r[k]));
  a.total += r.total; a.cost += r.cost ?? 0;
  return a;
}, { input: 0, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0, total: 0, cost: 0 });

// chaque ligne = { cells: [[texte, style...]], sub: [[texte]] | null }
const modelRow = (r) => ({
  main: [[short(r.model), BOLD, modelColor(r.model)], ...KEYS.map((k) => [n(r[k])]), [n(r.total), BOLD], [usd(r.cost), BOLD, '32']],
  sub: [[''], ...KEYS.map((k) => [perM(r.price?.[PKEY[k]]), DIM]), [''], ['']],
});
const totalRow = {
  main: [['Σ Total'], ...KEYS.map((k) => [n(sum[k])]), [n(sum.total)], [usd(sum.cost)]].map((c) => [...c, BOLD, '36']),
  sub: null,
};
const tableRows = [...out.map(modelRow), ...(out.length > 1 ? [totalRow] : [])];

const w = head.map((h, i) => Math.max(h.length, ...tableRows.flatMap((r) => [r.main[i][0], r.sub?.[i][0] ?? ''].map((t) => t.length))) + 6);
const line = (l, m, r, ch = '─') => paint(l + w.map((x) => ch.repeat(x)).join(m) + r, BORDER);
const cell = (t, i) => ' ' + (i === 0 ? t.padEnd(w[i] - 1) : t.padStart(w[i] - 2) + ' ');
const printRow = (cells) => {
  const bar = paint('│', BORDER);
  console.log(bar + cells.map(([t, ...st], i) => paint(cell(t, i), ...st)).join(bar) + bar);
};

console.log();
console.log(` ${paint('◆ Claude Code', BOLD, '36')} ${paint('· Daily Usage par modèle ·', DIM)} ${paint(day, BOLD)}`);
if (!out.length) console.log('\n Aucune consommation.\n');
else {
  console.log(` ${paint(usd(sum.cost), BOLD, '32')} ${paint('·', DIM)} ${paint(n(sum.total) + ' tokens', BOLD)}\n`);
  console.log(line('╭', '┬', '╮'));
  printRow(head.map((h) => [h, BOLD, '36']));
  tableRows.forEach((r, ri) => {
    const last = ri === tableRows.length - 1;
    const dbl = ri === 0 || (last && out.length > 1);
    console.log(dbl ? line('╞', '╪', '╡', '═') : line('├', '┼', '┤'));
    printRow(r.main);
    if (r.sub) printRow(r.sub);
  });
  console.log(line('╰', '┴', '╯'));

  const bars = (title, items, total, fmt) => {
    console.log(`\n ${paint(title, BOLD)}`);
    for (const r of items) {
      const ratio = total ? fmt.value(r) / total : 0;
      const filled = Math.round(ratio * 24);
      console.log(` ${paint(short(r.model).padEnd(12), BOLD, modelColor(r.model))} ${paint('█'.repeat(filled), modelColor(r.model))}${paint('░'.repeat(24 - filled), BORDER)} ${String(Math.round(ratio * 100)).padStart(3)}%  ${fmt.label(r)}`);
    }
  };
  if (out.length > 1 && sum.total > 0) bars('Répartition par token', out, sum.total, { value: (r) => r.total, label: (r) => n(r.total) });

  if (flag('effort')) {
    console.log(`\n ${paint('Effort de réflexion par modèle', BOLD)} ${paint('(par message)', DIM)}`);
    for (const r of out) {
      const total = Object.values(r.effort).reduce((a, e) => a + e.msgs, 0);
      for (const [lvl, e] of Object.entries(r.effort).sort((a, b) => b[1].msgs - a[1].msgs)) {
        const ratio = e.msgs / total;
        const filled = Math.round(ratio * 24);
        const think = e.output ? Math.round((e.thinking / e.output) * 100) : 0;
        console.log(` ${paint(short(r.model).padEnd(12), BOLD, modelColor(r.model))} ${lvl.padEnd(7)} ${paint('█'.repeat(filled), modelColor(r.model))}${paint('░'.repeat(24 - filled), BORDER)} ${String(Math.round(ratio * 100)).padStart(3)}%  ${n(e.msgs)} msgs · thinking ${n(e.thinking)}/${n(e.output)} output (${think}%)`);
      }
    }
  }
  console.log(paint('\n Cache 5m / 1h : durée de vie du cache à l’écriture (1h facturé plus cher). Prix LiteLLM, par million de tokens.', DIM) + '\n');
}
