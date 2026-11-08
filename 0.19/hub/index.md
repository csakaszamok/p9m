# Hub

The **Hub** lists the apps your team has built, in one place, for the people who *use* them: colleagues who never run a sandbox find an app and open it with one click. It is a web app of its own, at its own address (by default `hub.<HOST_DOMAIN>`), served by Purgatorium but apart from its UI: no sandboxes, no *New sandbox*, no quota.

An app appears on the Hub when a label on its container says so; it shows its title, description, owner and whether it runs or sleeps, and **Open** opens it in a new tab. An app that is asleep wakes on that click, as any request wakes it.

## Turn it on

```
# .env
HUB_ENABLED=true
# HUB_HOST=hub.example.com     # default: hub.<HOST_DOMAIN>
# HUB_TITLE=Example Ltd        # shown in its header
```

then `docker compose up -d`. HTTPS uses the same wildcard certificate as everything else under the domain.

**Single sign-on:** add `https://hub.<HOST_DOMAIN>/auth/callback` at your provider as a second allowed redirect URI (next to Purgatorium's `https://p9m.<HOST_DOMAIN>/auth/callback`). The administrator can also sign in to the Hub with the password, so it can be tried without single sign-on.

## Who sees it

| Who      | Settings                                      | May                                                         |
| -------- | --------------------------------------------- | ----------------------------------------------------------- |
| Builders | `OIDC_ALLOWED_DOMAINS`, `OIDC_ALLOWED_EMAILS` | use Purgatorium, create sandboxes, publish, and use the Hub |
| Viewers  | `HUB_ALLOWED_DOMAINS`, `HUB_ALLOWED_EMAILS`   | sign in to the Hub only                                     |

- With `HUB_ALLOWED_*` empty, only builders (and the administrator) use the Hub.
- A viewer who tries Purgatorium's own sign-in is refused with *"You have access to the Hub only: https://hub.example.com"*, and gets no Purgatorium session or token.
- Taken off a list: signed out of the Hub at the next request.

## Publish an app

Add labels to its container in the stack you deploy into the sandbox:

```
services:
  web:
    image: my-stock-room
    ports: ["8080:8080"]          # on all interfaces: it needs a web address
    labels:
      p9m.publish: "true"         # "true" or "1" publishes; anything else does not
      p9m.title: "Stock room"     # optional, at most 80 characters; default: the service name
      p9m.description: "Who took what from the stock room"   # optional, at most 280
```

- A description over several lines keeps its line breaks on the Hub (YAML's `|`):

  ```
  p9m.description: |
    Who took what from the stock room.
    Ask Anna for access.
  ```

- **An image on its card:** `p9m.image: "/screenshot.png"`, a path inside the app (PNG, JPEG, WebP or GIF, at most 2 MB and 4096 × 4096 pixels). Without it the Hub uses the page's own `<meta property="og:image">` if it has one, and otherwise the title's first letter on a colour. Purgatorium fetches the image in the background straight from the sandbox, only while the app runs (it never wakes an app for it), refreshes it once a day or when the label changes, and never fetches anything from another site: a URL in the label, or an og:image on another host, is ignored.

- What is published is the app's **web address**, the one its sandbox's *Apps* tab shows; with several ports, the lowest one published on all interfaces. A published container with no such port is not on the Hub: the sandbox's *Details* tab warns *published, but has no web address*.

- It appears on the Hub within half a minute, without approval. Remove the label (and deploy again) to take it off; archiving the sandbox does too. Deep sleep keeps it on the Hub.

- Apps started by hand or by an agent count as well: Purgatorium reads the labels from the sandbox's own Docker.

- On the *Apps* tab, a published app has an **On the Hub** marker.

## Votes

Everyone signed in to the Hub can vote for an app once (👍), their own too (as a GitHub star), and take the vote back. The Hub sorts by votes (*Popular*) or by date (*New*); only the count is shown, not who voted. Votes stay when an app leaves the Hub and count on if it is published again at the same address.

## Feed

The Hub has an RSS feed (`/feed.xml`) and a JSON Feed (`/feed.json`), so a new app shows up by itself where the team looks: a Slack, Teams or Mattermost channel (their RSS integrations), Linkwarden, an RSS reader, or n8n and bots for anything else.

Readers cannot sign in, so the feed takes a secret key: the administrator creates the link in Purgatorium's **Overview → Hub feed → Create feed link**. Only the key's hash is kept, so the link is shown once; creating a new one ends the old link. Without the key the feed answers 404.

## Not yet

A webhook on new apps, a Hub per team (with teams), and a Hub open on the internal network without signing in are on the [roadmap](https://csakaszamok.github.io/p9m/0.19/roadmap/index.md).

## App access

An app open only to its owner (`p9m.access: owner`, see [App access](https://csakaszamok.github.io/p9m/0.19/app-access/index.md)) is not published, even with `p9m.publish`: its **Details** tab says so. A `domain` app shows to Hub viewers who can sign in to Purgatorium itself; viewers allowed only on the Hub (`HUB_ALLOWED_DOMAINS`, `HUB_ALLOWED_EMAILS`) see public apps only. Opening a `domain` app makes the usual sign-in hop.
