# Repository Agent Notes

## Local authentication for trace investigation

- For local API replay, trace debugging, and regression probes, do not copy the browser's `qasey_session` cookie. Use the dedicated development Bearer token instead.
- The real `QASEY_DEV_AUTH_TOKEN` lives in the Git-ignored `.env.local`. Never print, log, paste into chat, or commit its value.
- Load repository environment files through the canonical loader so `.env.local` and the encoded `.env.secret` use the correct precedence:

  ```bash
  pnpm exec moego-aws-secret-env run --default-environment testing -- <command>
  ```

- The child command should read `process.env.QASEY_DEV_AUTH_TOKEN` and send `Authorization: Bearer <token>`. Check only whether the variable exists; do not use `cat`, `echo`, or other commands that reveal it.
- The token resolves only under `NODE_ENV=development` to the server-owned `local-developer` subject in tenant `local-development`, with `platform-admin` privileges. Test runs ignore it, and production configuration rejects it.
- The header is for protected Admin/API/Studio API calls. It does not replace Slack/Jira request signatures and must not be added to signed channel webhook replays.
- Browser Admin UI and Studio sessions continue to use Google OAuth cookies; never compile the development token into frontend assets.
