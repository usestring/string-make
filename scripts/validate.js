import Ajv from "ajv";
import { readdir, readFile } from "node:fs/promises";

const schemaDirectory = new URL("../vendor/make_editor_schemas/", import.meta.url);
const schemaId = name => `https://make.invalid/schemas/${name}.json`;
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, unicodeRegExp: false });
for (const file of await readdir(schemaDirectory)) {
  if (!file.endsWith(".json")) continue;
  const schema = JSON.parse(await readFile(new URL(file, schemaDirectory), "utf8"));
  if (file === "sources.json") {
    // The editor schema predates whole-collection IML in query parameters.
    schema.definitions.qs = { oneOf: [schema.definitions.qs, { $ref: "#/definitions/stringWithIml" }] };
  }
  ajv.addSchema(schema, schemaId(file.slice(0, -5)));
}

export function sections(app) {
  return [
    { path: "base.json", schema: "base", value: app.base },
    ...Object.entries(app.connections).flatMap(([name, connection]) => [
      { path: `connections/${name}/api.json`, schema: "api", value: connection.api },
      { path: `connections/${name}/parameters.json`, schema: "parameters", value: connection.parameters },
    ]),
    ...Object.entries(app.modules).flatMap(([name, module]) => [
      { path: `modules/${name}/api.json`, schema: "api", value: module.api },
      { path: `modules/${name}/expect.json`, schema: "parameters", value: module.expect },
      { path: `modules/${name}/interface.json`, schema: "parameters", value: module.interface },
      { path: `modules/${name}/samples.json`, schema: "samples", value: module.samples },
    ]),
  ];
}

function requireContract(condition, message) {
  if (!condition) throw new Error(message);
}

function checkCredentialReferences(value, path = []) {
  if (typeof value === "string" && /(?:connection|parameters)\.apiKey/.test(value)) {
    requireContract(
      path.join(".") === "connections.api_key.api.headers.Authorization" ||
        /^modules\.[a-z_]+\.api(?:\.\d+)?\.headers\.Authorization$/.test(path.join(".")),
      `Credential reference outside an authorization header: ${path.join(".")}`,
    );
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) checkCredentialReferences(child, [...path, key]);
  }
}

const robotsUrl = "{{robotsUrl(parameters.url)}}";

function checkRequest(request) {
  if (request.url === robotsUrl) {
    requireContract(!request.headers && !request.qs && !request.body, "The robots.txt request must carry no String credential or input");
    requireContract(/^\{\{robotsAllowed\(statusCode, body, parameters\.url\)\}\}$/.test(request.response?.valid?.condition), "The robots.txt request must stop on a disallowed URL");
    return;
  }
  const prefix = request.url.split("{{")[0];
  requireContract(
    prefix.startsWith("https://request.usestring.ai/") || /^\/[a-z][a-z0-9_/]*$/i.test(prefix),
    `Request URL must have a fixed String API prefix: ${request.url}`,
  );
  for (const key of ["followRedirects", "followAllRedirects"]) {
    requireContract(request[key] !== true, "Authenticated API requests must not follow redirects");
  }
  requireContract(!request.repeat || request.method === "GET", "Only read requests may repeat");
  if (request.pagination?.url) checkRequest({ url: request.pagination.url });
}

function checkSecurityContracts(app) {
  requireContract(app.base.baseUrl === "https://request.usestring.ai/v1", "Unexpected authenticated API origin");
  const connection = app.connections.api_key;
  requireContract(!app.base.headers, "The base must not send the String key to every request");
  requireContract(connection.api.headers.Authorization === "Bearer {{parameters.apiKey}}", "Connection validation must use the entered API key");
  requireContract(connection.parameters.find(field => field.name === "apiKey")?.type === "password", "The API key must use a password field");
  requireContract(
    connection.api.method === "GET" && connection.api.url === "https://request.usestring.ai/v1/contexts" && connection.api.qs.limit === 1,
    "Connection validation must use the credit-free contexts endpoint",
  );
  for (const request of [app.base, connection.api]) {
    requireContract(request.followRedirects === false && request.followAllRedirects === false, "Authenticated API requests must not follow redirects");
    for (const path of ["request.headers.authorization", "request.headers.Authorization"]) {
      requireContract(request.log.sanitize.includes(path), `Missing credential log sanitization: ${path}`);
    }
  }
  requireContract(app.base.log.sanitize.includes("request.body"), "Destination headers and request bodies must be sanitized");
  checkCredentialReferences(app);
  checkRequest(connection.api);
  for (const module of Object.values(app.modules)) {
    const requests = Array.isArray(module.api) ? module.api : [module.api];
    if (module.expect.some(parameter => parameter.name === "url")) {
      requireContract(requests[0].url === robotsUrl, "Modules that contact a destination must check robots.txt first");
    }
    for (const request of requests) {
      checkRequest(request);
      if (request.url !== robotsUrl) {
        requireContract(request.headers?.Authorization === "Bearer {{connection.apiKey}}", "String API requests must send the connected API key");
      }
      requireContract(!request.log, "Modules must inherit base log sanitization");
      requireContract(!(request.method === "POST" && request.url.startsWith("/sitemap")), "Crawl creation and approval must remain explicit API calls");
    }
  }
}

export function validateApp(app) {
  for (const section of sections(app)) {
    if (!ajv.validate(schemaId(section.schema), section.value)) {
      throw new Error(`${section.path}: ${ajv.errorsText(ajv.errors, { separator: "\n" })}`);
    }
  }
  checkSecurityContracts(app);
}
