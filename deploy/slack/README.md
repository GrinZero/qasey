# Optional Slack integration

Slack is not required to run Qasey. Enable it only after the standalone API is
healthy and its public HTTPS origin is stable.

## Managed webhook mode

1. Copy `manifest.example.json` outside the repository and replace
   `https://qasey.example.com` with the deployment origin.
2. Create a Slack app from the copied manifest and install it to a workspace.
3. In Qasey's Admin UI, add the Slack app using its Bot User OAuth Token and
   Signing Secret. Qasey encrypts those values in PostgreSQL and returns a
   stable webhook URL.
4. In Slack, set both **Event Subscriptions → Request URL** and
   **Interactivity → Request URL** to the generated URL. Reinstall the app if
   Slack reports a scope change.

The example includes scopes used by messaging, files, channel discovery,
reactions, and optional user-token search. Remove capabilities and scopes that
your deployment does not use. Never commit the copied manifest after adding a
workspace URL, app ID, or token.

## Local Socket Mode

For local development without a public webhook, enable Socket Mode in Slack
and configure the ignored `.env.local` file with:

```dotenv
SLACK_CHANNEL_MODE=socket
SLACK_BOT_TOKEN=
SLACK_SOCKET_MODE_APP_TOKEN=
```

The app-level token needs the `connections:write` scope. Socket Mode is a
single-app compatibility path; managed webhook installations are the intended
multi-tenant production setup.
