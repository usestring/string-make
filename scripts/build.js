import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import app from "../src/app.js";
import { sections, validateApp } from "./validate.js";

validateApp(app);
const output = new URL("../dist/", import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output);
const files = [];
for (const { path, value } of sections(app)) {
  const file = new URL(path, output);
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(new URL(".", file), { recursive: true });
  await writeFile(file, source);
  files.push({ path, sha256: createHash("sha256").update(source).digest("hex") });
}
const functionDirectory = new URL("../src/functions/", import.meta.url);
for (const file of (await readdir(functionDirectory)).sort()) {
  const name = file.slice(0, -3);
  const source = await readFile(new URL(file, functionDirectory), "utf8");
  // Make runs one named function per custom IML function, with a 5,000-character limit.
  if (!source.includes(`function ${name}(`) || source.length > 5000) throw new Error(`Invalid custom IML function: ${file}`);
  const path = `functions/${name}/code.js`;
  await mkdir(new URL(`functions/${name}/`, output), { recursive: true });
  await writeFile(new URL(path, output), source);
  files.push({ path, sha256: createHash("sha256").update(source).digest("hex") });
}
await writeFile(new URL("manifest.json", output), `${JSON.stringify({
  name: app.name, label: app.label, version: app.version,
  connections: Object.fromEntries(Object.entries(app.connections).map(([name, { label, type }]) => [name, { label, type }])),
  modules: Object.fromEntries(Object.entries(app.modules).map(([name, { label, description, type, connection }]) => [
    name, { label, description, type, connection },
  ])),
  files,
}, null, 2)}\n`);
console.log(`Validated and exported ${files.length} native sections and functions for ${Object.keys(app.modules).length} modules. No Make requests were sent.`);
