# Permissions and trusted identity

Authentication uses platform-owned Google OAuth/OIDC with encrypted browser cookies for people, deployment-owned Bearer tokens for service callers, and verified Slack/Jira ingress for channels. The official Mastra orchestration Worker has a dedicated token resolved by the platform middleware; it receives only workflow step permissions and does not reuse `PLATFORM_SERVICE_TOKEN`. Mastra Enterprise auth is not configured. `platform-admin` is a bootstrap bypass only when the email comes from `PLATFORM_BOOTSTRAP_ADMIN_EMAILS`; it must not be accepted from request data.

The permission middleware classifies each request as `{ applicationId, resourceType, resourceId, action }`, checks audience and tenant-scoped role permissions, writes an audit decision, and then injects trusted RequestContext. Unknown routes and unknown primitive IDs are denied.

Important platform permissions:

- `platform.admin-ui.access`: open the management UI and its read-only BFF endpoints.
- `platform.permissions.manage`: grant role permissions and bind subjects to roles.
- `platform.catalog.read`: native global/list endpoints.
- `platform.runtime.inspect`: observability, storage, channel-management, stored-primitive surfaces, and the development-only Mastra Studio UI.

Qasey permissions include `qasey.agent.execute` for the public workflow-backed task ingress, internal `qasey.task.execute`, `qasey.e2e.execute`, `qasey.runs.read`, `qasey.runs.write`, `qasey.runs.approve`, and `qasey.channel.receive`.

Permission changes require a same-origin browser request and are audited. For break-glass recovery, temporarily configure one trusted OAuth email as a bootstrap admin, restore the intended binding, verify the audit record, and remove the bootstrap entry.
