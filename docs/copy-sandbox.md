# Copy a sandbox

The admin can copy a sandbox to a new one: to another server (a development sandbox becomes a test one), or on the same server under another name. The copy holds everything: its apps, their images and data, and the files in `/root`, `/home`, `/srv` and `/opt`.

A new sandbox is made for the copy and only its data is replaced, so its name, addresses, Docker certificates and SSH host keys are its own. The apps' addresses follow its name. The source goes on running; it stops for the time of the copy.

## How

On the source server, in the folder of Purgatorium's `docker-compose.yml`:

```bash
docker compose exec p9m node /app/scripts/clone-sandbox.mjs pack p9m-shop
```

This writes the copy to `data/copies/<copy>`. For another server, copy that folder to `data/copies/` there, with its files as they are (`scp -rp`, as root). Then, on the server that gets it:

```bash
docker compose exec p9m node /app/scripts/clone-sandbox.mjs unpack <copy> shop-uat
```

The sandbox belongs to the source's owner, who must be able to sign in to this server; `--owner <e-mail>` names another. **Delete `data/copies/<copy>` when you are done**: it holds the sandbox's data and passwords.

Both servers must run the same Purgatorium version and the sandbox's runtime must be allowed on the target: the copy says so and stops otherwise. A damaged copy is refused before anything is made.

## The owner's permission

A user's sandbox is copied only with its owner's permission. Without it, `pack` stops and prints a link to send them. They open it, sign in and allow one copy, for 24 hours; they can withdraw it there until it is used. It is used up when the copy starts, so a copy that fails needs a new one. Only the owner can give it, from the browser: not the admin, and not a token or a coding agent. An admin's own sandbox needs none.

If the owner cannot give it (they have left, say), the copy can go without it, with a reason that is recorded:

```bash
docker compose exec p9m node /app/scripts/clone-sandbox.mjs pack p9m-shop --no-consent --reason "owner left, handover to the team"
```

!!! warning "A rule and a trace, not a lock"
    Whoever runs the server's Docker can read every sandbox anyway. The permission makes the normal way go through the owner, and every copy leaves a record: in the server's log (`[copy]`) and on the owner's page.

## Before you start the copy

`unpack` leaves the sandbox stopped. **Check its apps' settings first**: they are the source's. An app may point at the source's database, send mail or call webhooks as soon as it runs, and every app with a restart policy starts with the sandbox. Opening one of its addresses starts it too.

## What does not come with it

- Tokens and the `.p9m` folder: run `/p9m:init` for the new sandbox.
- Secrets brought with `/p9m:teleport`: teleport again.
- Images in Purgatorium's registry: push them again if the apps pull them from there.
- An address written into an app's own settings, and a template's generated passwords in the panel (Portainer, say): the panel shows the new sandbox's, the data has the source's.

During the copy, opening the sandbox's address wakes it. The copy notices that and is thrown away: run it again.

To move one app to a machine without Purgatorium instead, see [Export an app](export-app.md).
