# Read-only control panel

The panel is served by the existing Cloudflare Worker at `/control`.

## Security model

- The panel is read-only: it shows queue counts, today's published count, schedule settings, and recent queued/processing/failed items.
- Dashboard endpoints require the separate `CONTROL_READ_SECRET` credential.
- The publisher continues to use `WORKER_API_SECRET`. The dashboard credential cannot claim, complete, fail, or force-publish jobs.
- The browser keeps the entered key only in tab memory. It is not written to local storage, cookies, or the page URL. Closing or reloading the tab clears it.
- Do not share the dashboard key. Use HTTPS and open the panel only on a trusted device.

## Enable it

1. Generate a new random secret of at least 32 characters. Do not reuse another token.
2. Add it to GitHub repository Actions secrets with the exact name `CONTROL_READ_SECRET`.
3. Deploy the `chat-control-interface` branch only after reviewing the changes and explicitly deciding to deploy.

The deploy workflow treats this secret as optional, so existing deployments continue to work without it. If absent, the panel loads but the data endpoints return a configuration message.

## URLs

- Panel: `https://YOUR-WORKER.workers.dev/control`
- Health: `https://YOUR-WORKER.workers.dev/health`

The panel has no buttons to publish, retry, delete, or otherwise change videos.
