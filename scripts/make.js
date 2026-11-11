import { Make } from "@makehq/sdk";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { bootstrap, describeError, inventory, isMakeZone, loadPlan, SetupError, validateConfig } from "./bootstrap.js";

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--live", "--inventory", "--resume", "--config"]);
  let configPath = "make.config.json";
  for (let index = 0; index < args.length; index++) {
    if (!allowed.has(args[index])) throw new SetupError("Unknown argument. Use --inventory, --live, --resume, or --config PATH; credentials belong in the environment.");
    if (args[index] === "--config") {
      configPath = args[++index];
      if (!configPath || configPath.startsWith("--")) throw new SetupError("--config requires a path.");
    }
  }
  const live = args.includes("--live");
  const readOnly = args.includes("--inventory");
  if (live && readOnly || args.includes("--resume") && !live) throw new SetupError("Use --inventory separately; --resume requires --live.");
  const plan = readOnly ? undefined : await loadPlan(new URL("../dist/", import.meta.url));
  if (!live && !readOnly) {
    console.log(JSON.stringify({ mode: "offline", app: plan.manifest.name, connections: plan.manifest.connections,
      modules: plan.manifest.modules, sections: plan.manifest.files.length, sha256: plan.digest,
      required: ["MAKE_API_KEY", "MAKE_ZONE", "reviewed make.config.json", "custom IML enablement before helper upload"],
      effects: "Creates a private development app and uploads definitions. Does not publish or execute scenarios." }, null, 2));
    return;
  }
  const { MAKE_API_KEY: token, MAKE_ZONE: zone } = process.env;
  if (!token || !isMakeZone(zone)) throw new SetupError("Set MAKE_API_KEY and the exact bare MAKE_ZONE through your approved environment. Do not pass credentials in arguments.");
  let config;
  if (live) {
    config = JSON.parse(await readFile(configPath, "utf8"));
    validateConfig(config, zone, plan);
  }
  const client = new Make(token, zone, { retry: { maxRetries: 0, onRateLimit: false, onServerError: false } });
  if (readOnly) {
    console.log(JSON.stringify({ zone, ...await inventory(client) }, null, 2));
    return;
  }
  const directory = new URL("../.make/", import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = new URL("bootstrap.lock", directory);
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw new SetupError("An upload lock exists. Inspect the running upload before removing a stale lock."); });
  try {
    const statePath = new URL("bootstrap.json", directory);
    let state;
    if (args.includes("--resume")) {
      state = JSON.parse(await readFile(statePath, "utf8"));
    } else {
      const file = await open(statePath, "wx", 0o600).catch(() => { throw new SetupError("An upload journal already exists. Inspect it and use --resume; do not create another app."); });
      state = {};
      await file.writeFile("{}\n");
      await file.sync();
      await file.close();
    }
    const journal = { state, async save() {
      const temporary = new URL("bootstrap.json.tmp", directory);
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, statePath);
    } };
    console.log(JSON.stringify(await bootstrap(client, plan, config, zone, journal), null, 2));
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().catch(error => {
  console.error(describeError(error));
  process.exitCode = 1;
});
