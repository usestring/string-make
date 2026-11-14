import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const isName = value => typeof value === "string" && safeName.test(value);
export const isMakeZone = value => typeof value === "string" && /^(?:eu|us)\d+\.make\.com$/.test(value);

export class SetupError extends Error {}
const check = (condition, message) => { if (!condition) throw new SetupError(message); };

export function describeError(error) {
  if (error instanceof SetupError) return error.message;
  const status = Number.isInteger(error?.statusCode) ? `HTTP ${error.statusCode}` : "No usable response";
  // Make diagnostics can echo credentials or section content.
  return `${status}. Stopped without retrying; inspect the recorded operation before resuming.`;
}

export async function loadPlan(directory) {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  const files = {};
  for (const file of manifest.files) {
    check(/^(?:base\.json|connections\/[a-z_]+\/(?:api|parameters)\.json|modules\/[a-z_]+\/(?:api|expect|interface|samples)\.json|functions\/[A-Za-z]+\/code\.js)$/.test(file.path), "Unexpected export path; rebuild the connector.");
    const source = await readFile(new URL(file.path, directory), "utf8");
    check(sha256(source) === file.sha256, "Export hash mismatch; rebuild the connector.");
    check(!(file.path in files), "Duplicate export path.");
    files[file.path] = source;
  }
  check(isName(manifest.name) && Number.isInteger(manifest.version), "Invalid app metadata.");
  const expected = ["base.json"];
  for (const name of Object.keys(manifest.connections)) {
    check(isName(name), "Invalid connection identifier.");
    expected.push(`connections/${name}/api.json`, `connections/${name}/parameters.json`);
  }
  for (const [name, module] of Object.entries(manifest.modules)) {
    check(isName(name) && module.connection in manifest.connections, "Invalid module connection.");
    for (const section of ["api", "expect", "interface", "samples"]) expected.push(`modules/${name}/${section}.json`);
  }
  expected.push("functions/robotsAllowed/code.js", "functions/robotsUrl/code.js");
  check(expected.length === Object.keys(files).length && expected.every(path => path in files), "Incomplete connector export; rebuild it.");
  return { manifest, files, digest: sha256(JSON.stringify({ manifest, files })) };
}

export function validateConfig(config, zone, plan) {
  check(isMakeZone(zone) && config.zone === zone, "MAKE_ZONE must match the configured bare Make zone (for example us1.make.com).");
  check(Number.isSafeInteger(config.userId) && config.userId > 0, "Set userId from the read-only Make inventory.");
  check(isName(config.appName), "Set a valid appName.");
  check(isName(config.audience), "Set the audience verified for this Make account; no default is assumed.");
  for (const module of Object.values(plan.manifest.modules)) {
    check(Number.isSafeInteger(config.moduleTypeIds?.[module.type]) && config.moduleTypeIds[module.type] > 0, "Set the module type IDs verified in Make for every module type.");
  }
}

export async function inventory(client) {
  const user = await client.users.me();
  const authorization = await client.users.currentAuthorization();
  const apps = await client.sdk.apps.list({ cols: ["name", "version", "public"] });
  check(Number.isSafeInteger(user?.id) && Array.isArray(authorization?.scope) && Array.isArray(apps), "Incomplete Make inventory response.");
  return { userId: user.id, scopes: authorization.scope, organizationId: authorization.organizationId ?? null,
    apps: apps.map(({ name, version, public: isPublic }) => ({ name, version, public: isPublic })) };
}

export async function bootstrap(client, plan, config, zone, journal) {
  validateConfig(config, zone, plan);
  const identity = await inventory(client);
  check(identity.userId === config.userId, "Make account differs from the configured owner; no writes were made.");
  check(["sdk-apps:read", "sdk-apps:write"].every(scope => identity.scopes.includes(scope)), "The Make credential needs sdk-apps:read and sdk-apps:write.");
  const target = { zone, userId: config.userId, appName: config.appName, audience: config.audience,
    moduleTypeIds: Object.fromEntries([...new Set(Object.values(plan.manifest.modules).map(module => module.type))].sort().map(type => [type, config.moduleTypeIds[type]])), digest: plan.digest };
  const state = journal.state;
  check(!state.target || JSON.stringify(state.target) === JSON.stringify(target), "The saved target or source differs. Inspect the existing app before starting a different upload.");
  state.target = target;
  state.steps ??= {};
  await journal.save();
  const sdk = client.sdk;

  async function createOnce(key, write) {
    const prior = state.steps[key];
    if (prior) {
      check(prior.status === "done", "A creation outcome is uncertain. Reconcile the saved operation in Make before resuming; do not delete the journal and retry.");
      return prior.result;
    }
    state.steps[key] = { status: "pending" };
    await journal.save();
    const result = await write();
    state.steps[key] = { status: "done", result };
    await journal.save();
    return result;
  }

  if (!state.steps.app) {
    check(!identity.apps.some(item => item.name === config.appName), "An app with this name already exists; inspect it instead of creating or adopting another app.");
  }
  const appMetadata = { label: plan.manifest.label,
    description: "Fetch pages, extract data, send requests, search the web, and read sitemap results with String Web Access.",
    theme: "#000000", language: "en" };
  const app = await createOnce("app", async () => {
    const result = await sdk.apps.create({ ...appMetadata, name: config.appName, private: true, audience: config.audience });
    check(result?.name === config.appName && Number.isSafeInteger(result.version) && result.version > 0, "App creation response is incomplete. Inspect Make before resuming.");
    return { name: result.name, version: result.version };
  });
  const { name, version } = app;

  async function verifyPrivate() {
    const full = await sdk.apps.get(name, version, { cols: ["*"] });
    check(full?.name === name && full.version === version && full.public === false, "The target app/version is not confirmed private; upload stopped.");
    check(Object.entries(appMetadata).every(([key, value]) => full[key] === value), "App metadata changed; inspect Make before resuming.");
  }
  await verifyPrivate();

  async function writeSection(key, source, read, write) {
    const actual = await read();
    check(typeof actual === "string", "Make returned a non-text section; upload stopped.");
    const prior = state.steps[key];
    if (prior) {
      check(actual === source, "A saved section differs in Make. Inspect remote changes before resuming.");
    } else {
      await verifyPrivate();
      state.steps[key] = { status: "pending", before: actual, sha256: sha256(source) };
      await journal.save();
      await write(source);
      check(await read() === source, "Make section readback differs; upload stopped.");
    }
    state.steps[key] = { ...state.steps[key], status: "done", sha256: sha256(source) };
    await journal.save();
  }

  await writeSection("base", plan.files["base.json"], () => sdk.apps.getSection(name, version, "base"),
    source => sdk.apps.setSection(name, version, "base", source));

  const bindings = {};
  for (const [local, definition] of Object.entries(plan.manifest.connections)) {
    const remote = await createOnce(`connection:${local}`, async () => {
      const existing = await sdk.connections.list(name);
      check(Array.isArray(existing) && existing.length === Object.keys(bindings).length, "Unexpected connection inventory; inspect the app before creating a connection.");
      await verifyPrivate();
      const result = await sdk.connections.create(name, { label: definition.label, type: definition.type });
      check(isName(result?.name), "Connection creation response is incomplete. Inspect Make before resuming.");
      return { name: result.name };
    });
    const full = await sdk.connections.get(remote.name);
    check(full?.name === remote.name && full.label === definition.label && full.type === definition.type, "Connection metadata differs from the source.");
    bindings[local] = remote.name;
    for (const section of ["api", "parameters"]) {
      await writeSection(`connection:${local}:${section}`, plan.files[`connections/${local}/${section}.json`],
        () => sdk.connections.getSection(remote.name, section), source => sdk.connections.setSection(remote.name, section, source));
    }
  }

  check(config.customFunctionsEnabled === true, "Private app and connection are saved. Enable custom IML functions for this app through Make, set customFunctionsEnabled, then resume.");
  const functionNames = Object.keys(plan.files).filter(path => path.startsWith("functions/")).map(path => path.split("/")[1]);
  for (const functionName of functionNames) {
    await createOnce(`function:${functionName}`, async () => {
      const existing = await sdk.functions.list(name, version);
      const recorded = functionNames.filter(item => state.steps[`function:${item}`]?.status === "done");
      check(Array.isArray(existing) && existing.length === recorded.length && existing.every(item => recorded.includes(item.name)), "Unexpected helper inventory; inspect the app.");
      await verifyPrivate();
      const result = await sdk.functions.create(name, version, { name: functionName });
      check(result?.name === functionName, "Helper creation response is incomplete. Inspect Make before resuming.");
      return { name: result.name };
    });
    const full = await sdk.functions.get(name, version, functionName);
    check(full?.name === functionName, "Helper identity differs.");
    await writeSection(`function:${functionName}:code`, plan.files[`functions/${functionName}/code.js`],
      () => sdk.functions.getCode(name, version, functionName), source => sdk.functions.setCode(name, version, functionName, source));
  }

  for (const [moduleName, definition] of Object.entries(plan.manifest.modules)) {
    const typeId = config.moduleTypeIds[definition.type];
    await createOnce(`module:${moduleName}`, async () => {
      const existing = await sdk.modules.list(name, version);
      const recorded = Object.keys(plan.manifest.modules).filter(item => state.steps[`module:${item}`]?.status === "done");
      check(Array.isArray(existing) && existing.length === recorded.length && existing.every(item => recorded.includes(item.name)), "Unexpected module inventory; inspect the app.");
      await verifyPrivate();
      const result = await sdk.modules.create(name, version, { name: moduleName, typeId, label: definition.label,
        description: definition.description, moduleInitMode: "blank" });
      check(result?.name === moduleName, "Module creation response is incomplete. Inspect Make before resuming.");
      return { name: result.name };
    });
    const connection = bindings[definition.connection];
    function verifyModule(full) {
      check(full?.name === moduleName && full.typeId === typeId && full.label === definition.label && full.description === definition.description && full.public === false && full.altConnection === null && full.webhook === null, "Module metadata or private visibility differs.");
    }
    let full = await sdk.modules.get(name, version, moduleName);
    verifyModule(full);
    const bindingKey = `module:${moduleName}:binding`;
    if (state.steps[bindingKey] || full.connection === connection) {
      check(full.connection === connection, "A saved module connection differs in Make.");
    } else {
      check(full.connection === null, "The module already has a different connection; upload stopped.");
      await verifyPrivate();
      state.steps[bindingKey] = { status: "pending" };
      await journal.save();
      await sdk.modules.update(name, version, moduleName, { connection });
      full = await sdk.modules.get(name, version, moduleName);
      check(full.connection === connection, "Module connection readback differs.");
    }
    state.steps[bindingKey] = { status: "done" };
    await journal.save();
    for (const section of ["api", "expect", "interface", "samples"]) {
      await writeSection(`module:${moduleName}:${section}`, plan.files[`modules/${moduleName}/${section}.json`],
        () => sdk.modules.getSection(name, version, moduleName, section), source => sdk.modules.setSection(name, version, moduleName, section, source));
    }
    full = await sdk.modules.get(name, version, moduleName);
    verifyModule(full);
    check(full.connection === connection, "Module connection changed during upload.");
  }

  await verifyPrivate();
  const [connections, functions, modules] = await Promise.all([
    sdk.connections.list(name), sdk.functions.list(name, version), sdk.modules.list(name, version),
  ]);
  const sameNames = (items, names) => Array.isArray(items) && items.length === names.length && items.every(item => names.includes(item.name));
  check(sameNames(connections, Object.values(bindings)) && sameNames(functions, functionNames) && sameNames(modules, Object.keys(plan.manifest.modules)), "Final component inventory differs; inspect Make.");
  return { zone, app: name, version, private: true, sections: plan.manifest.files.length,
    connections: bindings, modules: modules.map(module => module.name), runtimeTested: false };
}
