const fs = require("fs");
const path = require("path");
const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "out/refs.json"), "utf8"));
const mode = process.argv[2];
const src = rows.filter((r) => r.srcFile);
const fmt = (r) => `${r.file}:${r.line} ${r.kind} ${r.owner ? r.owner + "." : ""}${r.name}`;
if (mode === "check") {
  for (const n of process.argv.slice(3)) for (const r of rows.filter((x) => x.name === n)) console.log(fmt(r), JSON.stringify({ own: r.ownUses, src: r.extSrc, test: r.extTest, example: r.extExample, re: r.reexportVia, calls: r.calls }));
}
if (mode === "dead") {
  // exported top-level, no use anywhere outside own file, and no own use
  const d = src.filter((r) => r.exported && r.extSrc.length === 0 && r.extTest.length === 0 && r.ownUses === 0);
  for (const r of d) console.log(fmt(r) + (r.reexportVia.length ? "  [reexported: " + r.reexportVia.join(",") + "]" : ""));
  console.error("count", d.length);
}
if (mode === "testonly") {
  const d = src.filter((r) => r.exported && r.extSrc.length === 0 && r.extTest.length > 0 && r.extExample.length === 0 && r.ownUses === 0);
  for (const r of d) console.log(fmt(r) + "  tests=" + r.extTest.length + (r.extExample.length ? "  ex=" + r.extExample.length : "") + (r.reexportVia.length ? "  [re: " + r.reexportVia.join(",") + "]" : ""));
  console.error("count", d.length);
}
if (mode === "exampleonly") {
  const d = src.filter((r) => r.exported && r.extSrc.length === 0 && r.extTest.length === 0 && r.extExample.length > 0 && r.ownUses === 0);
  for (const r of d) console.log(fmt(r) + "  examples=" + r.extExample.join(","));
  console.error("count", d.length);
}
if (mode === "localonly") {
  // exported but only used inside own file (and maybe tests)
  const d = src.filter((r) => r.exported && r.extSrc.length === 0 && r.ownUses > 0);
  for (const r of d) console.log(fmt(r) + "  own=" + r.ownUses + " tests=" + r.extTest.length);
  console.error("count", d.length);
}
if (mode === "privatedead") {
  const d = src.filter((r) => !r.exported && r.ownUses === 0 && r.extSrc.length === 0 && r.extTest.length === 0 && r.kind !== "Property" && r.name !== "constructor");
  for (const r of d) console.log(fmt(r));
  console.error("count", d.length);
}
if (mode === "optional") {
  // functions with optional params never passed by any call site (calls>0)
  for (const r of src) {
    if (!r.params || r.calls === 0) continue;
    const max = Math.max(...r.callArgCounts);
    const unused = r.params.map((p, i) => ({ ...p, i })).filter((p) => p.optional && p.i >= max && !p.name.startsWith("..."));
    if (unused.length) console.log(fmt(r) + `  calls=${r.calls} maxArgs=${max} neverPassed=` + unused.map((p) => p.name.slice(0, 40)).join("|"));
  }
}
if (mode === "single") {
  // top-level functions used by exactly one call site total (own or external), non-test
  for (const r of src) {
    if (!["Function", "ConstFn"].includes(r.kind)) continue;
    const total = r.ownUses + r.extSrc.length;
    if (r.calls === 1 && r.extTest.length === 0 && total === 1) console.log(fmt(r) + (r.extSrc.length ? " <- " + r.extSrc[0] : " (local)"));
  }
}
if (mode === "fanin") {
  // per file: number of distinct src files importing it
  const m = new Map();
  for (const r of src) {
    if (!m.has(r.file)) m.set(r.file, new Set());
    for (const f of r.extSrc) m.get(r.file).add(f);
  }
  for (const [f, s] of [...m.entries()].sort((a, b) => a[1].size - b[1].size)) console.log(s.size, f, s.size <= 2 ? [...s].join(",") : "");
}
