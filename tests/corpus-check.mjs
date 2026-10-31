import { readFile, readdir, writeFile } from 'node:fs/promises';
import { Project } from '../core/project.js';
import { equalBytes } from '../core/dtn.js';
const directory = process.argv[2];
if (!directory) throw new Error('usage: node tests/corpus-check.mjs DIRECTORY');
const results = [];
for (const name of (await readdir(directory))
  .filter((n) => n.endsWith('.dorico'))
  .sort()) {
  const row = { name };
  try {
    const original = new Uint8Array(await readFile(`${directory}/${name}`));
    const p = await Project.open(original);
    if (!equalBytes(original, await p.exportBytes()))
      throw new Error('unchanged archive differs');
    row.roundtrip = true;
    row.versions = [
      ...new Set(
        [...p.docs.values()]
          .map((d) =>
            d.nodes[0].children
              .filter((i) => d.tag(i) === 'fileVersion')
              .map((i) => d.value(i)),
          )
          .flat(),
      ),
    ];
    row.merges = {};
    for (const kind of ['font', 'paragraph']) {
      const styles = [...p.stylesFor(kind).keys()];
      let done = false;
      for (const source of styles
        .filter((id) => id.includes('.user.'))
        .concat(styles)
        .slice(0, 24)) {
        for (const target of styles.slice(0, 8)) {
          if (source === target) continue;
          try {
            const q = p.applyMerge([source], target, kind);
            const reloaded = await Project.open(await q.exportBytes());
            if (reloaded.stylesFor(kind).has(source))
              throw new Error('source remains');
            row.merges[kind] = { source, target, passed: true };
            done = true;
            break;
          } catch (error) {
            row.merges[kind] = { passed: false, reason: error.message };
          }
        }
        if (done) break;
      }
    }
  } catch (error) {
    row.error = error.message;
  }
  results.push(row);
  console.log(JSON.stringify(row));
  await writeFile(
    new URL('../../corpus-results.json', import.meta.url),
    JSON.stringify(results, null, 2),
  );
}
