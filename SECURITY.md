# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or leaked credential.
Use the repository's **Security → Report a vulnerability** form so maintainers
can coordinate privately. Include affected versions, impact, reproduction
steps, and any suggested mitigation. Do not access data that is not yours.

Maintainers should acknowledge a complete report within five business days and
provide status updates while triage or remediation is in progress. Disclosure
timing will be coordinated with the reporter after a fix is available.

## Supported versions

Until the first stable release, security fixes are applied to the latest commit
on `main`. Published support windows will be added when versioned releases begin.

## Deployment responsibility

Qasey handles OAuth credentials, API tokens, repository access, and code-task
execution. Operators must use a secret manager, restrict Studio and sandbox
network access, rotate exposed credentials, and review the deployment guide
before enabling external integrations.
