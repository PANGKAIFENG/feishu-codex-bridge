# Feishu Setup

## Feishu app

Create a custom self-built app with a bot enabled.

Required pieces:

- App ID
- App Secret
- Event subscription
- Bot message send capability

Subscribe to `im.message.receive_v1`.

For the first deployment, keep event payload encryption disabled. The bundled bridge validates the verification token from the callback payload and rejects encrypted payloads.

## Preferred mode

Prefer long connection.

In the Feishu app console, choose `使用长连接接收事件`.

This avoids:

- registering a public domain
- exposing a callback path
- using a reverse proxy only for event delivery

The bundled bridge supports both `websocket` and `webhook`, but `websocket` should be the default.

## Callback exposure

Feishu must reach the bridge over the public internet. If the Mac Mini stays at home, expose the local bridge with one of these:

- Cloudflare Tunnel
- A reverse proxy on a public VPS forwarding to the Mac Mini
- Any stable HTTPS tunnel with a fixed callback URL

Do not expose raw SSH or VNC to the public internet just to make the bot work.

Recommended local listen address:

- `HOST=127.0.0.1`
- `PORT=8787`

Expose the route:

- `https://your-public-domain.example/feishu/events`

## Event subscription expectations

The bridge expects the current Feishu callback flow:

- URL verification requests with a `challenge`
- Event callbacks with `header.event_type = im.message.receive_v1`
- Text message payloads in `event.message.content`

If Feishu sends a different payload shape in your tenant, inspect the raw request body from the bridge logs and patch the extractor in `scripts/bridge-server.mjs`.

## Bot permissions

Grant the minimum set needed to:

- Receive message events
- Send text messages back to the same chat

If replies fail after the event is accepted, check the app permission scopes and tenant approval state first.
