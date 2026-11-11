const apiBase = "https://request.usestring.ai/v1";
const field = (name, label, type, extra = {}) => ({ name, label, type, ...extra });
const inputUrl = field("url", "URL", "url", {
  required: true,
  pattern: "^https?://",
  help: "The HTTP or HTTPS URL to request. The module reads the site's robots.txt first and stops if it disallows the URL.",
});
const auth = { Authorization: "Bearer {{connection.apiKey}}" };
// Runs before any String request that contacts the destination. It goes to the destination itself,
// so it carries no String credential; an unreadable robots.txt stops the module.
const robotsCheck = {
  url: "{{robotsUrl(parameters.url)}}", method: "GET", followRedirects: true,
  response: {
    type: "text",
    valid: {
      condition: "{{robotsAllowed(statusCode, body, parameters.url)}}",
      message: "{{if(statusCode === 429 || statusCode >= 500, 'Could not read ' + robotsUrl(parameters.url) + ' (HTTP ' + statusCode + '), so the page was not fetched. Try again later.', robotsUrl(parameters.url) + ' disallows ' + parameters.url + ', so the page was not fetched.')}}",
    },
  },
};
const limit = (max) => field("limit", "Limit", "uinteger", {
  required: true, default: 10, validate: { min: 1, max },
});
const errors = {
  message: "String API returned HTTP {{statusCode}}. Request ID: {{headers.`x-request-id`}}.",
  "400": { message: "Invalid input. Check the module fields against the String API reference." },
  "401": { type: "InvalidAccessTokenError", message: "The String API key is invalid or revoked. Reconnect with a valid key." },
  "402": { message: "The String account has insufficient balance. Add credit before retrying." },
  "403": { message: "The String account is not permitted to access this destination or feature." },
};
const sanitize = { sanitize: ["request.headers.authorization", "request.headers.Authorization", "request.body"] };
const destinationInterface = [
  field("url", "Requested URL", "url"),
  field("finalUrl", "Final URL", "url"),
  field("statusCode", "Destination Status Code", "uinteger"),
  field("data", "Data", "any"),
];
const destinationOutput = {
  url: "{{parameters.url}}",
  finalUrl: "{{headers.`x-final-url`}}",
  statusCode: "{{parseNumber(headers.`x-status-code`)}}",
  data: "{{body.data}}",
};
const countryCode = field("countryCode", "Proxy Country", "text", {
  advanced: true, pattern: "^[A-Za-z]{2}$", help: "Optional two-letter ISO country code, such as US.",
});
const jsonSample = {
  url: "https://example.com/", finalUrl: "https://example.com/", statusCode: 200,
  data: "<h1>Example Domain</h1>",
};
const module = (label, description, type, api, expect, outputInterface, samples) => ({
  label, description, type, connection: "api_key", api, expect,
  interface: outputInterface, samples,
});

export default {
  name: "string-web-access",
  label: "String Web Access",
  version: 1,
  base: {
    baseUrl: apiBase,
    timeout: 120000,
    followRedirects: false,
    followAllRedirects: false,
    log: sanitize,
    response: { type: "json", error: errors },
  },
  connections: {
    api_key: {
      label: "String API Key",
      type: "basic",
      parameters: [field("apiKey", "API Key", "password", {
        required: true, help: "Create a key on the API keys page in the String portal.",
      })],
      api: {
        url: `${apiBase}/contexts`, method: "GET", qs: { limit: 1 },
        headers: { Authorization: "Bearer {{parameters.apiKey}}" },
        followRedirects: false, followAllRedirects: false,
        log: sanitize,
        response: {
          type: "json", valid: "{{statusCode === 200}}", error: errors,
          metadata: { type: "text", value: "String API Key" },
        },
      },
    },
  },
  modules: {
    fetch_url: module(
      "Fetch a URL", "Fetches a page as Markdown or a JSON response.", "action",
      [robotsCheck, {
        url: "/fetch", method: "POST", headers: auth,
        body: {
          url: "{{parameters.url}}", format: "{{parameters.format}}",
          mainContentOnly: "{{parameters.mainContentOnly}}",
          countryCode: "{{parameters.countryCode}}", solveCaptcha: false,
        },
        response: {
          type: { "200": "{{if(parameters.format === 'markdown', 'text', 'json')}}", "*": "json" },
          output: {
            ...destinationOutput,
            data: "{{if(parameters.format === 'markdown', body, body.data)}}",
          },
        },
      }],
      [inputUrl, field("format", "Format", "select", {
        required: true, default: "markdown",
        options: [{ label: "Markdown", value: "markdown" }, { label: "JSON", value: "json" }],
      }), field("mainContentOnly", "Main Content Only", "boolean", { default: false, advanced: true }), countryCode],
      destinationInterface,
      { ...jsonSample, data: "# Example Domain" },
    ),
    extract_data: module(
      "Extract Data From a URL", "Extracts structured data using a JSON Schema.", "action",
      [robotsCheck, {
        url: "/fetch", method: "POST", headers: auth,
        body: {
          url: "{{parameters.url}}", format: "json", jsonSchema: "{{parseJSON(parameters.jsonSchema)}}",
          countryCode: "{{parameters.countryCode}}", solveCaptcha: false,
        },
        response: {
          valid: {
            condition: "{{headers.`x-json-schema-applied` === 'true'}}", type: "DataError",
            message: "The page was not extracted. Fallback reason: {{headers.`x-json-schema-fallback-reason`}}.",
          },
          output: { ...destinationOutput, data: "{{body}}" },
        },
      }],
      [inputUrl, field("jsonSchema", "JSON Schema", "text", {
        required: true, multiline: true,
        help: 'A JSON object describing the data, for example {"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}.',
      }), countryCode],
      destinationInterface,
      { ...jsonSample, data: { title: "Example Domain" } },
    ),
    send_request: module(
      "Send a Request to a URL", "Sends an HTTP request to a destination through String.", "action",
      [robotsCheck, {
        url: "/fetch", method: "POST", headers: auth,
        body: {
          url: "{{parameters.url}}", method: "{{parameters.method}}", format: "json",
          body: "{{parameters.body}}", headers: "{{toCollection(parameters.headers, 'name', 'value')}}",
          countryCode: "{{parameters.countryCode}}", solveCaptcha: false,
        },
        response: { output: { ...destinationOutput, headers: "{{body.headers}}" } },
      }],
      [inputUrl, field("method", "Method", "select", {
        required: true, default: "GET",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(value => ({ label: value, value })),
      }), field("body", "Body", "text", {
        multiline: true, help: "Optional literal request body. Leave empty for GET and HEAD. JSON is sent as written.",
      }), field("headers", "Destination Headers", "array", {
        default: [], spec: [field("name", "Name", "text", { required: true }), field("value", "Value", "password", { required: true })],
        help: "These headers go to the destination. String's connection key is added separately to the API request.",
      }), countryCode],
      [...destinationInterface, field("headers", "Destination Headers", "collection")], jsonSample,
    ),
    search_web: module(
      "Search the Web", "Returns individual organic search results, up to the chosen limit.", "search",
      {
        url: "/search", method: "POST", headers: auth,
        body: {
          query: "{{parameters.query}}", engine: "google", searchCount: "{{parameters.limit}}",
          country: "{{parameters.country}}", language: "{{parameters.language}}", solveCaptcha: false,
        },
        response: {
          valid: {
            condition: "{{body.paging.complete === true}}", type: "IncompleteDataError",
            message: "Search stopped before completion: {{body.paging.stoppedBy}}. Lower the limit and rerun if appropriate.",
          },
          iterate: "{{body.results}}", limit: "{{parameters.limit}}",
          output: {
            position: "{{item.position}}", rank: "{{item.rank}}", title: "{{item.title}}",
            url: "{{item.url}}", displayUrl: "{{item.displayUrl}}", snippet: "{{item.snippet}}",
            paging: "{{body.paging}}",
          },
        },
      },
      [field("query", "Query", "text", { required: true }), limit(300),
        field("country", "Country", "text", { advanced: true, pattern: "^[A-Za-z]{2}$" }),
        field("language", "Language", "text", { advanced: true })],
      [field("position", "Position", "uinteger"), field("rank", "Rank", "uinteger"),
        field("title", "Title", "text"), field("url", "URL", "url"),
        field("displayUrl", "Display URL", "text"), field("snippet", "Snippet", "text"),
        field("paging", "Paging", "collection", { spec: [
          field("pages", "Pages", "uinteger"), field("complete", "Complete", "boolean"), field("stoppedBy", "Stopped By", "text"),
        ] })],
      { position: 1, rank: 1, title: "Example Domain", url: "https://example.com/", displayUrl: "example.com", snippet: "An example page.", paging: { pages: 1, complete: true, stoppedBy: "search_count" } },
    ),
    map_site: module(
      "Map a Site's URLs", "Returns URLs from a completed sitemap job. Quote and approve the job with Make an API Call first.", "search",
      [
        {
          url: "/sitemap/{{encodeURL(parameters.jobId)}}", method: "GET", headers: auth,
          response: {
            valid: {
              condition: "{{body.status === 'completed'}}", type: "IncompleteDataError",
              message: "Sitemap job {{parameters.jobId}} is {{body.status}}. Approve an awaiting quote or wait for completion, then rerun with this same job ID.",
            },
          },
        },
        {
          url: "/sitemap/{{encodeURL(parameters.jobId)}}/urls", method: "GET", headers: auth, qs: { limit: 100, offset: 0 },
          response: { iterate: "{{body.urls}}", limit: "{{parameters.limit}}", output: {
            jobId: "{{body.jobId}}", url: "{{item.url}}", statusCode: "{{item.statusCode}}",
            depth: "{{item.depth}}", isSitemap: "{{item.isSitemap}}", parentUrl: "{{item.parentUrl}}",
            sourceType: "{{item.sourceType}}", error: "{{item.error}}",
          } },
          pagination: {
            qs: { limit: 100, offset: "{{(pagination.page - 1) * 100}}" },
            condition: "{{pagination.page <= ceil(body.total / 100) && length(body.urls) > 0}}",
          },
        },
      ],
      [field("jobId", "Job ID", "text", { required: true, help: "The ID returned by POST /sitemap. This module never creates or approves a paid crawl." }), limit(10000)],
      [field("jobId", "Job ID", "text"), field("url", "URL", "url"), field("statusCode", "Destination Status Code", "uinteger"),
        field("depth", "Depth", "uinteger"), field("isSitemap", "Is Sitemap", "boolean"), field("parentUrl", "Parent URL", "url"),
        field("sourceType", "Source Type", "text"), field("error", "Error", "text")],
      { jobId: "example-job", url: "https://example.com/", statusCode: 200, depth: 0, isSitemap: false, parentUrl: null, sourceType: "seed" },
    ),
    api_call: module(
      "Make an API Call", "Calls an endpoint on the String Web Access API.", "action",
      {
        url: `${apiBase}{{parameters.path}}`, method: "{{parameters.method}}",
        qs: "{{toCollection(parameters.query, 'name', 'value')}}",
        body: "{{parameters.body}}", type: "text",
        headers: { ...auth, "Content-Type": "application/json" },
        response: { type: "automatic", output: { statusCode: "{{statusCode}}", headers: "{{headers}}", body: "{{body}}" } },
      },
      [field("path", "Path", "text", {
        required: true, pattern: "^/[^/\\\\?#][^\\\\?#]*$",
        help: "A path relative to /v1, such as /contexts. Add query parameters below. Only the String API origin is used.",
      }), field("method", "Method", "select", {
        required: true, default: "GET",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"].map(value => ({ label: value, value })),
      }), field("query", "Query Parameters", "array", { default: [], spec: [
        field("name", "Name", "text", { required: true }), field("value", "Value", "text", { required: true }),
      ] }), field("body", "JSON Body", "text", { multiline: true, help: "Literal JSON text. Leave empty for GET. Mutating endpoints may start paid jobs; check the quote before approving a crawl." })],
      [field("statusCode", "API Status Code", "uinteger"), field("headers", "Response Headers", "collection"), field("body", "Body", "any")],
      { statusCode: 200, headers: {}, body: { contexts: [] } },
    ),
  },
};
