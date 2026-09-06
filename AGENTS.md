# Repository agent instructions

Use public dependencies and redacted fixtures only. Before submitting changes, run:

```bash
pnpm check
pnpm check:open-source
```

Never commit runtime `.env` files, tenant data, credentials, private endpoints,
or organization-specific repository names.

Every Mastra agent added to this repository must be fully visible and directly
usable in Mastra Studio by default. Studio list, detail, chat, and execute paths
must not be metadata-only, hidden behind an `internal` flag, or require a private
runtime binding. Add regression coverage for Studio discovery and direct use.
Only introduce a Studio restriction when the user explicitly requests it.
