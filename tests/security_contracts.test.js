import { describe, expect, test } from "bun:test";
import app from "../src/app.js";
import { validateApp } from "../scripts/validate.js";

const changedApp = change => {
  const copy = structuredClone(app);
  change(copy);
  return copy;
};

describe("credential and billing regression guards", () => {
  test("accepts the native app with the protected contracts intact", () => {
    expect(() => validateApp(app)).not.toThrow();
  });

  test.each([
    ["missing authorization", copy => { delete copy.modules.search_web.api.headers; }],
    ["key on every request", copy => { copy.base.headers = { Authorization: "Bearer {{connection.apiKey}}" }; }],
    ["key sent to robots.txt host", copy => { copy.modules.fetch_url.api[0].headers = { Authorization: "Bearer {{connection.apiKey}}" }; }],
    ["fetch without robots check", copy => { copy.modules.fetch_url.api.shift(); }],
    ["robots check that never stops", copy => { copy.modules.send_request.api[0].response.valid.condition = "{{true}}"; }],
    ["unmasked destination request", copy => { copy.base.log.sanitize = copy.base.log.sanitize.filter(path => path !== "request.body"); }],
    ["billed validation", copy => { copy.connections.api_key.api.url = "https://request.usestring.ai/v1/fetch"; }],
    ["visible key field", copy => { copy.connections.api_key.parameters[0].type = "text"; }],
    ["key in module output", copy => { copy.modules.api_call.api.response.output.key = "{{connection.apiKey}}"; }],
    ["external request origin", copy => { copy.modules.api_call.api.url = "https://example.com/{{parameters.path}}"; }],
    ["external pagination origin", copy => { copy.modules.map_site.api[1].pagination.url = "https://example.com/"; }],
    ["redirect credential egress", copy => { copy.base.followRedirects = true; }],
    ["connection redirect egress", copy => { copy.connections.api_key.api.followAllRedirects = true; }],
    ["unmasked header logs", copy => { copy.base.log.sanitize = []; }],
    ["module log override", copy => { copy.modules.fetch_url.api[1].log = { sanitize: [] }; }],
    ["automatic paid crawl", copy => { copy.modules.map_site.api.unshift({ url: "/sitemap", method: "POST", body: {} }); }],
    ["repeated write", copy => { copy.modules.fetch_url.api[1].repeat = { condition: "{{true}}", delay: 1000, limit: 2 }; }],
  ])("rejects %s", (_name, change) => {
    expect(() => validateApp(changedApp(change))).toThrow();
  });
});
