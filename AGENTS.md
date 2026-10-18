<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Flujo de integración (obligatorio para toda rama)

1. **Antes de pushear**, loop de revisión interna: code review del diff (skill `code-review` o equivalente) → corregir → code review de nuevo, hasta que no queden hallazgos. Además `pnpm test && pnpm typecheck && pnpm lint` en verde, con la rama base mergeada.
2. **Push y PR** contra la rama base que corresponda. Esperar la revisión de `tenki-reviewer` sobre el último commit.
3. **Si Tenki deja hallazgos**, volver al paso 1 con ellos: corregir, repetir el loop interno, pushear y esperar a Tenki otra vez. Si un hallazgo es incorrecto, responderlo en su hilo con la justificación técnica; no ignorarlo en silencio.
4. **Si Tenki queda sin hallazgos**, mergear el PR.
5. **Si el merge a `main` cambia `seeds/templates.ts`**, después del deploy, contra Supabase: `pnpm cli seed && pnpm cli template-upgrade --keys <las cambiadas>` (ver `docs/superpowers/notes/despliegue.md`, "Seeds después de un merge").
