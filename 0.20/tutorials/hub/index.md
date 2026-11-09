# Share your app with your team on the Hub

The Hub is your team's showcase: a page at `https://hub.<your Purgatorium domain>` where colleagues find the apps you published, open them with one click, and vote for the ones they like. Colleagues who only use apps can sign in to the Hub alone.

**What you need:** an app already online in your sandbox (see [Put your app online with Claude Code](https://csakaszamok.github.io/p9m/0.20/tutorials/claude-code/index.md)), and the Hub turned on in your Purgatorium (ask whoever runs it; it is `HUB_ENABLED=true`).

## 1. Publish

Tell your agent:

> Publish the web app on the Hub, titled "Stock room", described as "Who took what from the stock room".

It adds labels to the app's service in its compose file and deploys again:

```
services:
  web:
    labels:
      p9m.publish: "true"
      p9m.title: "Stock room"
      p9m.description: "Who took what from the stock room"
```

Within about a minute and a half the app is on the Hub. In Purgatorium its **App ports** tab marks it **On the Hub**.

## 2. A picture on its card

> Use /screenshot.png as its Hub image.

That adds `p9m.image: "/screenshot.png"`: a picture the app itself serves (PNG, JPEG, WebP or GIF, up to 2 MB). Without it the Hub uses the page's own preview image, if it has one, or the title's first letter.

## 3. Share

Send colleagues the Hub's address. They see whether your app is running or asleep; **Open** wakes it if it sleeps. Everyone signed in can vote once for each app, yours too.

To take it off the Hub: *remove the app from the Hub* (the agent removes `p9m.publish`), or archive the sandbox.

All labels and settings: [Hub](https://csakaszamok.github.io/p9m/0.20/hub/index.md).
