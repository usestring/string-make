# String Web Access for Make

Native Make connector source for the [String Web Access API](https://portal.usestring.ai/docs/api-reference/overview). Make runs the exported IML/JSON sections and calls the existing API. No separate backend is required; JavaScript runs during the local build and in Make's custom IML functions.

**Status:** connector source and private-app setup tooling. This app has not been uploaded, tested in Make, submitted for review, or published. A local build does not prove Make runtime behavior. See [release requirements](#release-path-and-remaining-gates) before installing it.

## Build and validate

Install [Bun](https://bun.sh/) 1.3.10 or newer, then run from the repository root:

```sh
git clone https://github.com/usestring/string-make.git
cd string-make
bun install --frozen-lockfile
bun run build
bun test
```

`dist/` contains the base, connection and module sections plus a manifest with metadata and SHA-256 hashes. Generated files are ignored. The build makes no HTTP requests. `src/app.js` is the source of truth; edit it and rebuild rather than editing `dist/`. Run the build and tests locally before pushing. The **Validate Make Connector** workflow runs the same checks on demand through `workflow_dispatch`.

Validation uses pinned Make editor schemas, with two compatibility settings: non-Unicode regular expressions for the editor's escaped hyphens, and whole-collection IML expressions for `qs`, which the runtime documentation supports. Vendored schemas remain unchanged. This validates section structure and selected credential/billing contracts. It does not evaluate IML, verify outputs against live responses, or prove that a Make scenario works.

## Connect

Create a String API key in the String portal. In the Make app's connection dialog, choose **String API Key** and paste it into **API Key**. The password field masks the key. Connection validation calls `GET https://request.usestring.ai/v1/contexts?limit=1`, a credit-free endpoint that does not fetch a third-party page. Zero-balance, invalid-key and revoked-key behavior still need verification in Make.

Each String API request adds the key as an Authorization header; the base does not, so the robots.txt request below never carries it. API redirects are disabled, and request authorization headers and bodies are sanitized in logs. Destination headers in Send a Request to a URL are separate from the String key.

## Create the private development app

The management scripts use the pinned `@makehq/sdk` 1.12.0. They run locally, outside the Make app runtime. The default command is offline and needs no account:

```sh
bun run make:plan
```

For a live setup, sign in to the intended Make account and provide a Make API token through your approved environment as `MAKE_API_KEY`, with its exact zone hostname in `MAKE_ZONE` (for example `us1.make.com`). Do not pass the token as an argument, put it in configuration, or paste it into an issue. The token needs `sdk-apps:read` and `sdk-apps:write`, plus access to the identity endpoints. A String API key is a separate credential used later in a Make test connection.

Run `bun run make:inventory` to read the current user ID, token scopes and existing app names/versions. It makes no writes. Its output contains account identifiers; keep it out of public reports. A failed inventory is an error, not an empty workspace.

Copy `make.config.example.json` to the ignored `make.config.json`. Set the zone, inventoried user ID, chosen app name, and the audience and action/search module type IDs verified for this Make account. Null values are deliberate: the uploader never guesses these creation settings. Leave `customFunctionsEnabled` false until Make has enabled custom IML functions for the app.

```sh
bun run make:upload
```

This creates a private app, verifies its visibility, uploads the Base, and creates and uploads the API-key connection. It then stops for custom IML enablement. Request enablement for that app through Make's helpdesk. After enablement, set `customFunctionsEnabled` true and resume:

```sh
bun run make:upload --resume
```

The resume uploads both robots helpers before creating the six modules. It binds each module to the returned connection identifier and compares every uploaded section with a fresh readback. Successful completion reports the remote app/version and component bindings; it does not prove that a scenario works. These scripts never publish the app, submit a review, create a runtime connection, run a scenario, or call the String API.

The ignored `.make/` directory contains a private upload journal, prior section text and an exclusive upload lock. Keep it with the working copy until setup is complete. Re-running without `--resume` refuses an existing journal. A changed source or target, unexpected component, or remote section change stops the upload. The script disables automatic retries. If a creation response is lost or incomplete, inspect Make and reconcile that operation before continuing; deleting the journal and trying again can create duplicates. A section whose write response was lost can resume only when its readback exactly matches the intended source. After an interrupted process, verify it is no longer running before removing its stale lock. Nothing is deleted or rolled back automatically.

## Modules

| Module | Inputs | Output |
| --- | --- | --- |
| Fetch a URL | HTTP/HTTPS URL; Markdown or JSON; optional main-content flag and proxy country | Requested/final URL, destination status and data |
| Extract Data From a URL | URL and JSON Schema text | Extracted object as Data, final URL and status; extraction fallback fails explicitly |
| Send a Request to a URL | URL, method, optional literal body and destination headers | Destination data, headers, status and final URL |
| Search the Web | Query, limit 1–300, optional country and language | One bundle per organic result, with paging metadata |
| Map a Site's URLs | Completed sitemap job ID and limit 1–10,000 | One bundle per discovered URL |
| Make an API Call | Path relative to `/v1`, method, query pairs and optional JSON text body | API status, headers and body |

Fetch a URL, Extract Data From a URL and Send a Request to a URL read the destination's `robots.txt` before calling the API and stop when it disallows the URL for every crawler (`User-agent: *`). Following RFC 9309, a missing or refused `robots.txt` (any 4xx) allows the request, and one that cannot be read (429 or 5xx) stops it. Matching runs in the custom IML functions `robotsUrl` and `robotsAllowed` (`src/functions/`, exported to `dist/functions/`); `tests/robots.test.js` covers each case. Map reads results of a sitemap job, which skips disallowed pages server-side.

Fetch and search explicitly disable CAPTCHA solving. A malformed JSON Schema fails during request construction. The API rejects incompatible destination request options, including a body on GET or HEAD. Native fetch modules return Markdown or JSON; binary/raw fetch is outside this source increment.

Search sends `searchCount=limit`. String performs Google pagination and deduplication inside that request, including pages with fewer than ten results. Make iterates the returned array and applies the same limit. It deliberately does not combine that backend pagination with separate `page` requests, which can repeat or skip results. Partial search responses fail with the reported stop reason. Each search page that answered is billed separately by String.

Map checks for `completed` before reading results and pages through `/urls` in batches of 100. It does not create, approve or poll a crawl. An unfinished or failed job produces an error with its ID; rerun with that same ID after inspecting it.

Make an API Call always prefixes the path with `https://request.usestring.ai/v1`. Headers cannot override the connection key. Raw JSON text is sent as written; leave the body empty for GET. This module can call mutating or paid endpoints, so inspect their inputs before running them.

HTTP 401 explains how to reconnect, 402 requests a balance top-up, and 403 identifies a permission restriction. Other errors include status and request ID where available. Make's default rate-limit and server-error types are preserved. A destination status such as 404 can arrive inside an HTTP 200 API response; use Destination Status Code to decide how the scenario should handle it.

## Example scenarios to verify in Make

These are setup recipes, not executed scenario evidence.

For a basic scenario, add **Fetch a URL**, connect a test key, set URL to `https://example.com/` and Format to Markdown, then run once. Map Data into a subsequent text module and verify Final URL and Destination Status Code.

For a sitemap:

1. Use **Make an API Call**, method POST, path `/sitemap`, and body `{"url":"https://example.com/","maxPages":1,"maxDepth":1,"budgetUsd":0.01}`. This creates a quote without crawling. Keep the returned `jobId`.
2. Inspect `estimatedCostUsd` and the requested scope. Approve only the intended quote with a separate API-call module: POST `/sitemap/JOB_ID/approve`, empty body. Approval starts the crawl and holds funds. Never recreate the quote automatically after an uncertain approval response.
3. Read `/sitemap/JOB_ID` until it reports `completed`. Inspect any terminal failure. Use the same ID across retries; the quote expires after one hour.
4. Set that ID in **Map a Site's URLs**, choose a limit, and run it. Its status check and result reads do not start another crawl.

Keep approval separate from any scenario retry loop. A successful approval followed by another module's failure does not undo the crawl.

## Release path and remaining gates

Start with a new private development app through the setup workflow above. Inventory the account first to avoid creating a duplicate. If an existing app is found, inspect its complete components and sections and prepare a separate update plan: this uploader does not adopt existing apps or replace their connection metadata. The generated manifest is a local artifact, not proof that remote IDs exist.

Outstanding work before installation/publication:

- Obtain the intended Make account, custom-app permissions, and a separate test team; create and upload the private app.
- Ask Make's helpdesk to enable custom IML functions for the app, then upload `robotsUrl` and `robotsAllowed` before the modules that call them. In Make, confirm that a 5xx or 429 `robots.txt` reaches the module's `valid` check rather than the base API error message, and that redirects are followed.
- Reconcile the Map job-ID workflow with the intended native URL-to-map experience and Make review requirements. This increment leaves quote/approval explicit to avoid retrying a paid job creation.
- Run every module in Make; cover valid/invalid/revoked and zero-balance connections, Markdown/JSON, extraction fallback, destination errors, search limits/empty and partial results, and sitemap pagination across more than 100 URLs. Preserve scenario links, exact source revision and fresh logs.
- Run a separate error scenario, verify masks in Make's logs, validate array/body expressions and the connection binding, and inspect retry behavior on 429/5xx.
- Confirm branding, support owner/contact, public source/release location, listing copy, review scenario links and logo. Obtain approval of the exact publication payload and any required external attestations before submitting public custom-app review. Publication is irreversible.

Keep remote publication blocked until these gaps are resolved. An invite-only app is not a public catalogue listing. No runtime acceptance criterion is met by the local build alone.

Once a remote app exists, record its zone/name/version and component bindings in reviewed release configuration, keep source in Git, rerun validation and scenario checks after API changes, and compare downloaded sections before modifying them. Connection sections are app-global rather than version-local. Support ownership and a public user guide must be settled before catalogue submission.

## References

- [Make AI coding-agent workflow](https://developers.make.com/custom-apps-documentation/get-started/make-apps-editor/ai-coding-agent)
- [Make TypeScript SDK](https://github.com/integromat/make-typescript-sdk)
- [Make review prerequisites](https://developers.make.com/custom-apps-documentation/app-review/prerequisites)
- [Pinned editor schema provenance and license](vendor/make_editor_schemas/README.md)
- [String API reference](https://portal.usestring.ai/docs/api-reference/overview)

## License

Original connector code is [MIT licensed](LICENSE). Vendored Make editor schemas retain their [upstream license](vendor/make_editor_schemas/LICENSE.md).
