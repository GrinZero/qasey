# Adding an Agent Application

1. Create `src/agent-apps/<id>/application.ts`. The ID must be lower-case kebab-case.
2. Keep internal agents/workflows inside the application module or service closure. Add only server-facing primitives to the bundle.
3. Name every registered primitive `${applicationId}-${name}` and use the exact same value for the registry key and primitive `id`.
4. Add a `PrimitiveAccessPolicy` for every registered agent, workflow, scorer, channel, and custom route. Choose the narrowest audiences.
5. Use `PlatformRequestContextSchema` for Agent, Workflow, Tool, and Step definitions. Derive owner scope with `ownerScopeFromRequestContext`; never accept tenant, roles, resource ID, or thread ID from input.
6. Add the bundle to the application list in `src/mastra/index.ts`. Do not instantiate another `Mastra`.
7. Add tests proving startup validation, native execution, memory/workspace separation, and that the new Application does not import Qasey internals.

Application bundles must not expose an `execute`/dispatcher method. Admin UI and API clients call native Mastra endpoints.
