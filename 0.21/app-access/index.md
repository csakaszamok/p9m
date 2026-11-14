# App access

By default a web app in a sandbox opens only for its sandbox's owner (and the admin): an app is made public on purpose, not by forgetting a label. A builder chooses, app by app, who opens it, with a label on the app's container:

| `p9m.access` | Who opens the app's web address                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `public`     | Anyone.                                                                                                                              |
| `domain`     | Anyone who can sign in to this Purgatorium (its sign-in allowlist, `OIDC_ALLOWED_DOMAINS` and `OIDC_ALLOWED_EMAILS`), and the admin. |
| `owner`      | The sandbox's owner, and the admin.                                                                                                  |

```
services:
  admin:
    build: .
    ports: ["8080:8080"]
    restart: unless-stopped
    labels:
      p9m.access: public    # or domain; owner when there is no label
```

An app without the label gets the server's default, `APPS_ACCESS_DEFAULT` (`owner` unless set; a company may set `domain`; `public` is how it was before 0.12.12). A value that is not one of the three (a typo such as `privat`) means `owner`, and the sandbox's **Details** tab says so. The **App ports** tab marks each app that is not public: *Owner only*, *Your domain*.

## What a visitor sees

The first time someone opens an app that is not public, their browser makes a short hop to Purgatorium: they sign in if they are not signed in yet, and come straight back to the app. That gives them a cookie for that one app's address, for 8 hours. Someone who may not open it sees a page that says so (*This app is open only to its owner*) and which account they are signed in with.

Purgatorium's own sign-in never reaches an app: the cookie an app's address gets says only that this person may view this app, and Purgatorium takes it off every request before the app sees it, so an app cannot use it to act as its visitor.

An asleep app is woken only for someone who may open it: an anonymous visitor of an owner-only app gets the sign-in hop, not a waking sandbox.

## The app knows who is viewing

Behind `domain` and `owner`, every request to the app carries `X-P9m-User: <their e-mail>` (`admin` for the admin). An app can greet its visitor with it, or use it as its own sign-in. Purgatorium removes an `X-P9m-User` that a visitor sends themselves, also for public apps, so the header can be trusted, but only behind Purgatorium.

## Streaming

An app's web address passes a response on as the app writes it: Server-Sent Events and streamed answers work behind `domain` and `owner` as well. A long-open stream or WebSocket does not by itself keep a sandbox awake: without other web requests it sleeps after its idle timeout and the connection drops, so a client should reconnect.

## Not covered

- **The TCP addresses** (databases, SSH, Docker) are not HTTP, so no sign-in stands in front of them. That is why an app that is not `public` has no TCP address (since 0.18.11): only a container that asks for one with `p9m.tcp: "true"`, protected by its own password (the label overrides `p9m.access`, so never put it on a web app); SSH and Docker by their keys. See [Isolation and TCP addresses](https://csakaszamok.github.io/p9m/0.21/networking/#tls-tcp-addresses).
- **Other sandboxes do not get a way around it** since 0.12.23: a sandbox is on its own network, so another sandbox reaches its apps only through their addresses, like anyone ([Isolation and TCP addresses](https://csakaszamok.github.io/p9m/0.21/networking/index.md)).
- **Webhooks and API clients without a browser** cannot make the sign-in hop. Keep an app that receives webhooks, or that a script or a mobile app calls, `public` for now.
- **A coding agent's own `curl`** to an app that is not public gets the sign-in redirect. The agent checks whether an app answers from inside (`GET /sandboxes/:name` → `apps[].answers`), which is not affected.

## Timing and failures

- A new or changed label applies within about 12 seconds of the deploy (Purgatorium reads the running sandboxes' labels every 10 s; Traefik asks Purgatorium every 2 s). Until then the sandbox goes by what Purgatorium last knew of it: in a sandbox whose apps were all public, a newly deployed `owner` app (with the label, or without one) is open for those seconds. For an app that must never be open, not even briefly, publish its port on `127.0.0.1` first and on all interfaces only after a few seconds, or deploy it into a sandbox that already has a `domain` or `owner` app.
- A sandbox whose apps are all public does not depend on Purgatorium while it runs, as before. One with a `domain` or `owner` app does: while Purgatorium is down, those apps do not open (it fails closed); public sandboxes keep working.
- The check is per sandbox (one router serves all its apps): in a sandbox with a `domain` or `owner` app, its **public** apps also need Purgatorium. Keep an app that must stay reachable while Purgatorium is down (a webhook receiver, a status page) in a sandbox whose apps are all public.
- If Traefik restarts while Purgatorium is down, no sandbox app opens until Purgatorium is back (Traefik has not yet read the access middlewares).

## On the Hub

An owner-only app is not published on the [Hub](https://csakaszamok.github.io/p9m/0.21/hub/index.md), even with `p9m.publish` (the **Details** tab says so: set `p9m.access: domain`). A `domain` app shows to Hub viewers who can sign in to Purgatorium itself; viewers who can sign in only to the Hub (`HUB_ALLOWED_*`) see the public apps.

## Settings

| Variable              | Default   |                                                                                                                                       |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `APPS_ACCESS_DEFAULT` | `owner`   | The level of an app without `p9m.access`: `owner`, `domain` or `public`.                                                              |
| `APP_ACCESS_SECRET`   | generated | Signs the app cookies and the one-time sign-in tickets. Without it Purgatorium generates one into `data/app-access.key` and keeps it. |
