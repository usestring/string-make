# Repository guidance

This repository contains a native Make connector for the public String Web Access API. It is an independent Bun package. Keep its build and tests runnable from the repository root.

- Run `bun install --frozen-lockfile`, `bun run build`, and `bun test` before opening a PR.
- Edit `src/app.js` and `src/functions/`; `dist/` is generated and ignored.
- Keep vendored Make schemas and their license unchanged when updating application code.
- Never commit credentials or put the String API key in destination requests, module outputs, or logs.
- Keep paid sitemap creation and approval explicit; reading results must not start another crawl.
- Inventory the intended Make app and its connections before uploading. Verify uploaded sections and run live scenarios before claiming runtime support.
- Publication through Make requires a separate release decision. Local validation does not establish installation, review acceptance, or a catalogue listing.
