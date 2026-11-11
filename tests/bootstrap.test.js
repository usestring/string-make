import { describe, expect, test } from "bun:test";
import { bootstrap, describeError, sha256 } from "../scripts/bootstrap.js";

function fixture() {
  const config = { zone: "us1.make.com", userId: 7, appName: "demo", audience: "global",
    moduleTypeIds: { action: 4 }, customFunctionsEnabled: true };
  const plan = { digest: "test-export", manifest: { label: "Demo", files: Array(9),
    connections: { api_key: { label: "String API Key", type: "basic" } },
    modules: { fetch_url: { label: "Fetch", description: "Fetch a page.", type: "action", connection: "api_key" } } },
    files: { "base.json": "{}", "connections/api_key/api.json": "{}", "connections/api_key/parameters.json": "[]",
      "functions/robotsAllowed/code.js": "function robotsAllowed() {}", "functions/robotsUrl/code.js": "function robotsUrl() {}",
      "modules/fetch_url/api.json": "{}", "modules/fetch_url/expect.json": "[]",
      "modules/fetch_url/interface.json": "[]", "modules/fetch_url/samples.json": "{}" } };
  const writes = [];
  const remote = { app: null, connections: {}, functions: {}, modules: {}, sections: {} };
  const stepsAtWrite = [];
  const journal = { state: {}, saved: {}, async save() { this.saved = structuredClone(this.state); } };
  function write(kind, operation) {
    stepsAtWrite.push(structuredClone(journal.saved.steps));
    writes.push(kind);
    return operation();
  }
  const section = (kind, path) => ({
    get: async () => remote.sections[path] ?? "",
    set: async source => write(kind, () => { remote.sections[path] = source; }),
  });
  const client = { users: { me: async () => ({ id: 7 }), currentAuthorization: async () => ({ scope: ["sdk-apps:read", "sdk-apps:write"] }) }, sdk: {
    apps: {
      list: async () => remote.app ? [remote.app] : [],
      create: async body => write("app.create", () => remote.app = { ...body, version: 2, public: false }),
      get: async () => remote.app,
      getSection: async () => section("base", "base").get(),
      setSection: async (name, version, key, source) => section("base", "base").set(source),
    },
    connections: {
      list: async () => Object.values(remote.connections),
      create: async (name, body) => write("connection.create", () => remote.connections["demo-api-key"] = { ...body, name: "demo-api-key" }),
      get: async name => remote.connections[name],
      getSection: async (name, key) => section("connection.section", `${name}/${key}`).get(),
      setSection: async (name, key, source) => section("connection.section", `${name}/${key}`).set(source),
    },
    functions: {
      list: async () => Object.values(remote.functions),
      create: async (name, version, body) => write("function.create", () => remote.functions[body.name] = body),
      get: async (name, version, key) => remote.functions[key],
      getCode: async (name, version, key) => section("function.code", key).get(),
      setCode: async (name, version, key, source) => section("function.code", key).set(source),
    },
    modules: {
      list: async () => Object.values(remote.modules),
      create: async (name, version, body) => write("module.create", () => remote.modules[body.name] = { ...body, public: false, connection: null, altConnection: null, webhook: null }),
      get: async (name, version, key) => remote.modules[key],
      update: async (name, version, key, body) => write("module.bind", () => Object.assign(remote.modules[key], body)),
      getSection: async (name, version, key, sectionName) => section("module.section", `${key}/${sectionName}`).get(),
      setSection: async (name, version, key, sectionName, source) => section("module.section", `${key}/${sectionName}`).set(source),
    },
  } };
  return { config, plan, client, journal, remote, writes, stepsAtWrite,
    run: () => bootstrap(client, plan, config, config.zone, journal) };
}

describe("private Make app upload boundaries", () => {
  test("binds modules to the returned remote connection and resumes without repeating writes", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.version).toBe(2);
    expect(result.runtimeTested).toBe(false);
    expect(f.remote.modules.fetch_url.connection).toBe("demo-api-key");
    expect(f.remote.app.private).toBe(true);
    const writes = f.writes.length;
    await f.run();
    expect(f.writes.length).toBe(writes);
    expect(f.stepsAtWrite.every(steps => Object.values(steps).some(step => step.status === "pending"))).toBe(true);
  });

  test("rejects a different account, missing scopes and a mismatched zone before creating anything", async () => {
    for (const change of [
      f => { f.config.userId = 8; },
      f => { f.client.users.currentAuthorization = async () => ({ scope: ["sdk-apps:read"] }); },
      f => { f.config.zone = "https://us1.make.com"; },
    ]) {
      const f = fixture();
      change(f);
      await expect(f.run()).rejects.toThrow();
      expect(f.writes).toEqual([]);
    }
  });

  test("never uploads sections when Make cannot confirm private visibility", async () => {
    const f = fixture();
    f.client.sdk.apps.get = async () => ({ name: "demo", version: 2 });
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toEqual(["app.create"]);
  });

  test("does not create another app after a lost creation response", async () => {
    const f = fixture();
    const create = f.client.sdk.apps.create;
    f.client.sdk.apps.create = async body => { await create(body); throw new Error("lost response"); };
    await expect(f.run()).rejects.toThrow();
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toEqual(["app.create"]);
    expect(f.journal.saved.steps.app.status).toBe("pending");
  });

  test("does not create a connection again after an incomplete creation response", async () => {
    const f = fixture();
    const create = f.client.sdk.connections.create;
    f.client.sdk.connections.create = async (...args) => { await create(...args); return {}; };
    await expect(f.run()).rejects.toThrow();
    await expect(f.run()).rejects.toThrow();
    expect(f.writes.filter(kind => kind === "connection.create")).toHaveLength(1);
    expect(Object.keys(f.remote.modules)).toHaveLength(0);
  });

  test("persists creation intent before sending a remote write", async () => {
    const f = fixture();
    const save = f.journal.save.bind(f.journal);
    f.journal.save = async () => {
      if (f.journal.state.steps?.app?.status === "pending") throw new Error("disk failure");
      await save();
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  test("leaves an existing name-matched app untouched", async () => {
    const f = fixture();
    f.remote.app = { name: "demo", version: 1, public: false };
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  test("can pause for custom IML enablement after saving the private app and connection", async () => {
    const f = fixture();
    f.config.customFunctionsEnabled = false;
    await expect(f.run()).rejects.toThrow();
    expect(Object.keys(f.remote.connections)).toHaveLength(1);
    expect(Object.keys(f.remote.functions)).toHaveLength(0);
    expect(Object.keys(f.remote.modules)).toHaveLength(0);
    f.config.customFunctionsEnabled = true;
    await f.run();
    expect(f.writes.filter(kind => kind === "app.create")).toHaveLength(1);
    expect(f.writes.filter(kind => kind === "connection.create")).toHaveLength(1);
  });

  test("recovers a confirmed section after a lost acknowledgement without writing it again", async () => {
    const f = fixture();
    const set = f.client.sdk.apps.setSection;
    f.client.sdk.apps.setSection = async (...args) => { await set(...args); throw new Error("lost response"); };
    await expect(f.run()).rejects.toThrow();
    await f.run();
    expect(f.writes.filter(kind => kind === "base")).toHaveLength(1);
    expect(f.journal.saved.steps.base.sha256).toBe(sha256(f.plan.files["base.json"]));
  });

  test("stops on source or remote drift rather than overwriting it", async () => {
    for (const change of [
      f => { f.plan.digest = "changed-export"; },
      f => { f.remote.sections.base = "changed remotely"; },
      f => { f.remote.modules.fetch_url.connection = "other-key"; },
    ]) {
      const f = fixture();
      await f.run();
      const writes = f.writes.length;
      change(f);
      await expect(f.run()).rejects.toThrow();
      expect(f.writes.length).toBe(writes);
    }
  });

  test("blocks an unrecorded extra component instead of declaring the upload complete", async () => {
    const f = fixture();
    await f.run();
    f.remote.connections.extra = { name: "unrelated" };
    await expect(f.run()).rejects.toThrow();
  });

  test("does not echo provider diagnostic bodies or credentials", () => {
    const error = Object.assign(new Error("secret-canary"), { statusCode: 401, apiError: { token: "secret-canary" } });
    expect(describeError(error)).not.toContain("secret-canary");
  });
});
