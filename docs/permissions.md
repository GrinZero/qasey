# Permissions and trusted identity

Authentication uses platform-owned Google OAuth/OIDC or single-tenant password credentials with opaque browser sessions for people, deployment-owned Bearer tokens for service callers, and verified Slack/Jira ingress for channels. The official Mastra orchestration Worker has a dedicated token resolved by the platform middleware; it receives only workflow step permissions and does not reuse `PLATFORM_SERVICE_TOKEN`. Mastra Enterprise auth is not configured. `platform-admin` is a bootstrap bypass only when the email is verified by Google and comes from `PLATFORM_BOOTSTRAP_ADMIN_EMAILS`; an unverified local-password email and request data can never activate it.

The permission middleware classifies each request as `{ applicationId, resourceType, resourceId, action }`, checks audience and tenant-scoped role permissions, writes an audit decision, and then injects trusted RequestContext. Unknown routes and unknown primitive IDs are denied.

Important platform permissions:

- `platform.admin-ui.access`: open the management UI and its read-only BFF endpoints.
- `platform.permissions.manage`: grant role permissions and bind subjects to roles.
- `platform.catalog.read`: native global/list endpoints.
- `platform.runtime.inspect`: observability, storage, channel-management, stored-primitive surfaces, and the development-only Mastra Studio UI.

Qasey permissions include `qasey.agent.execute` for the public workflow-backed task ingress, internal `qasey.task.execute`, `qasey.e2e.execute`, `qasey.runs.read`, `qasey.runs.write`, `qasey.cases.read`, `qasey.cases.write`, `qasey.results.read`, `qasey.results.approve`, service-only `qasey.test-environments.provision`, and `qasey.channel.receive`. Review is intentionally granted only at the immutable Case Result level; there is no run-level approval permission.

Tenant API Tokens can be granted the read-only Studio platform scopes `platform.runtime.inspect`, `platform.catalog.read`, `platform.background-tasks.read`, `platform.schedules.read`, and `platform.internal-workflow.read`. Native workflow execution scopes (`qasey.task.execute`, `qasey.e2e.execute`, and `qasey.case-workflow.execute`) and `qasey.scorers.read` remain available to trusted runtime identities but are intentionally excluded from the API Token issuance UI.

Permission changes require a same-origin browser request and are audited. For break-glass recovery, temporarily configure one trusted OAuth email as a bootstrap admin, restore the intended binding, verify the audit record, and remove the bootstrap entry.
