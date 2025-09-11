import fs from 'fs';
import path from 'path';

const file = process.argv[2];
if (!file) {
    console.error('Usage: node analyze-cpuprofile.mjs <file.cpuprofile>');
    process.exit(1);
}
const raw = fs.readFileSync(file, 'utf8');
let data;
try { data = JSON.parse(raw); } catch (e) { console.error('Failed to parse JSON:', e); process.exit(1); }

const { nodes = [], samples = [], timeDeltas = [] } = data;
const nodeById = new Map(nodes.map(n => [n.id, n]));

// Self time calculation
const selfTime = new Map(); // id -> microseconds
for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = timeDeltas[i] || 0; // microseconds
    selfTime.set(id, (selfTime.get(id) || 0) + dt);
}

// Build children map for inclusive time
const childrenMap = new Map();
for (const n of nodes) {
    if (n.children) {
        childrenMap.set(n.id, n.children.slice());
    } else {
        childrenMap.set(n.id, []);
    }
}

// Memoized inclusive time
const inclusiveTime = new Map();
function computeInclusive(id) {
    if (inclusiveTime.has(id)) return inclusiveTime.get(id);
    let total = selfTime.get(id) || 0;
    const kids = childrenMap.get(id) || [];
    for (const c of kids) total += computeInclusive(c);
    inclusiveTime.set(id, total);
    return total;
}
for (const n of nodes) computeInclusive(n.id);

function fmt(us) {
    return (us / 1000).toFixed(2) + 'ms'; // convert microseconds to ms
}

function frameName(n) {
    const f = n.callFrame || {};
    const name = f.functionName && f.functionName.length ? f.functionName : '(anonymous)';
    let shortUrl = f.url || '';
    if (shortUrl.startsWith('file:///')) shortUrl = path.basename(shortUrl);
    return name + (shortUrl ? ' @ ' + shortUrl + ':' + (f.lineNumber ?? '?') : '');
}

const totalRuntimeUs = timeDeltas.reduce((a, b) => a + b, 0);

const rows = nodes.map(n => ({
    id: n.id,
    name: frameName(n),
    selfUs: selfTime.get(n.id) || 0,
    inclUs: inclusiveTime.get(n.id) || 0
}));

const topSelf = [...rows].sort((a, b) => b.selfUs - a.selfUs).slice(0, 25);
const topIncl = [...rows].sort((a, b) => b.inclUs - a.inclUs).slice(0, 25);

function table(title, arr, key) {
    console.log('\n' + title);
    console.log('----------------------------------------------');
    for (const r of arr) {
        const pct = totalRuntimeUs ? ((r[key] / totalRuntimeUs) * 100).toFixed(1) : '0.0';
        console.log(`${pct.padStart(5)}% ${fmt(r[key]).padStart(10)} | ${r.name}`);
    }
}

console.log('CPU Profile Summary');
console.log('Total runtime: ' + fmt(totalRuntimeUs) + ' across ' + samples.length + ' samples');

table('Top Self Time (exclusive)', topSelf, 'selfUs');

table('Top Inclusive Time', topIncl, 'inclUs');

// Group by simple heuristics
const groups = [
    { label: 'sha256/crypto', match: /(sha256|crypto|subtle)/i },
    { label: 'serialization', match: /(serialize|deserialize|encode|decode)/i },
    { label: 'index operations', match: /(reIndex|index\.put|index.get|replies|elements)/i },
    { label: 'Put/DB writes', match: /(put\b|elements\.put|links\.put)/i },
];
for (const g of groups) {
    let us = 0;
    for (const r of rows) if (g.match.test(r.name)) us += r.selfUs;
    console.log(`Group: ${g.label.padEnd(18)} ${fmt(us)} (${(us / totalRuntimeUs * 100).toFixed(1)}%)`);
}
