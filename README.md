# Stickman Studio on Cloudflare Pages

Folder layout (upload this whole folder):

```
index.html
wrangler.toml
functions/api/ai.js
functions/api/transcribe.js
```

## Deploy

Pages Functions only deploy with the CLI or Git, not with the drag-and-drop dashboard upload.

```
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name stickman-studio
```

(Or push the folder to GitHub and connect it in Cloudflare Pages: build command empty, output directory `/`.)

## Settings (Pages project -> Settings)

1. **Bindings -> Workers AI**: add a binding named `AI`. (wrangler.toml already declares it for CLI deploys.) Needed for auto-captions, and for AI features if you have no Claude key.
2. **Secrets (optional)**:
   - `PASSCODE` - the site asks users for this once; stops strangers using your AI quota. Strongly recommended.
   - `ANTHROPIC_API_KEY` - if set, "Match with AI" and "Doc Starter" use Claude (better quality). Otherwise they use Workers AI Llama.
   - `CLAUDE_MODEL` - optional model override (default `claude-sonnet-5-5`).

```
wrangler pages secret put PASSCODE --project-name stickman-studio
wrangler pages secret put ANTHROPIC_API_KEY --project-name stickman-studio
```

## Notes

- Auto-captions accept narration up to 25 MB. For longer files, import an .srt.
- Video export happens in the browser (Chrome or Edge on a computer is best). Cloud render is optional and needs your own server.
