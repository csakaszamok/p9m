# Export an app

The admin can pack one compose project of a sandbox so that it runs on a plain Docker, without Purgatorium: on another machine, for a handover. To copy a whole sandbox to another Purgatorium, see [Copy a sandbox](copy-sandbox.md).

The sandbox must be awake. On the server, in the folder of Purgatorium's `docker-compose.yml`:

```bash
docker compose exec p9m node /app/scripts/export-app.mjs p9m-shop shop --stop
```

`shop` is the compose project (a wrong name lists the sandbox's projects). `--stop` stops the app for the copy and starts it again: use it for anything with a database, whose files copied while it runs may not be consistent. It needs the [owner's permission](copy-sandbox.md#the-owners-permission), like a copy, and `--no-consent --reason "..."` works the same way.

It writes a folder, `data/exports/<export>`, with `compose.yaml`, one settings file per service in `env/`, the images, the data, `restore.sh` and a `README.md`. **It holds the app's data and passwords: keep it safe, delete it when done.**

Copy the folder to the other machine (it needs Docker with the compose plugin) and run:

```bash
./restore.sh
```

It checks the files, loads the images and the data, and starts the app. It stops if the app's volumes exist already; `FORCE=1 ./restore.sh` replaces them. With `DOCKER_CONTEXT` set it loads into that Docker, unless the app bind-mounts folders.

!!! warning "Nothing guards the app there"
    Purgatorium's sign-in, HTTPS and addresses do not come along. The app's published ports are open to anyone who can reach the machine: put a reverse proxy in front of it. An app that knew its visitor from the `X-P9m-User` header needs a sign-in of its own, as anyone can send that header to an open port.

## What the export is, and is not

`compose.yaml` is made from what the containers ran, without Purgatorium's labels. If you have the project's own compose file, it is the better one to keep.

- It has no `build:` sections: it runs the images in the export.
- The settings in `env/` are the source's: check them, they may point at the sandbox's addresses or send mail.
- One replica per service, and no fixed addresses on networks. The export says so when it drops these.
- The images are for the processor they were built on: from an `amd64` server they need emulation on an `arm64` machine, or do not run. `restore.sh` warns about it.
- An app that runs privileged, mounts the Docker socket or uses the machine's network keeps that, and gets control over the machine it runs on: the export and `restore.sh` list these. A socket's or a device's own files are not copied.
