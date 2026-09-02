# Repository agent instructions

Use public dependencies and redacted fixtures only. Before submitting changes, run:

```bash
pnpm check
pnpm check:open-source
```

Never commit runtime `.env` files, tenant data, credentials, private endpoints,
or organization-specific repository names.
