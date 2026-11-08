# SSH, terminal and logs

## SSH into a sandbox

Every sandbox runs an sshd: root, keys only, at `<name>-shell-tcp.<domain>:443` (the same TLS gateway as the TCP addresses). Add your public keys under **My area → SSH keys** (`/settings/ssh-keys`, API `GET/POST/DELETE /ssh-keys`): they let you into all your sandboxes, and a change takes effect at once. A create request can add keys for that sandbox only (`ssh_keys`, or **Advanced → Extra SSH public keys**). Inside, `docker` talks to the sandbox's own Docker.

```
ssh -o ProxyCommand="openssl s_client -quiet -connect %h:443 -servername %h" root@<name>-shell-tcp.<domain>
```

Each new sandbox also has a key of its own: **Download key** in its panel (API `GET /sandboxes/:name/ssh-key`; `POST` makes one for an SSH sandbox that has none yet), so nobody has to make or upload a key first. The **Connect…** recipe then reads `ssh -i ~/Downloads/<name>.key …`.

The name `shell` is reserved: an inner service with `p9m.subdomain: shell` gets no TCP address.

## Terminal in the browser

**Terminal** in a sandbox's panel opens a root shell in the sandbox in a new tab: nothing to install, no key. It wakes the sandbox if it is asleep, and keeps it awake while the tab is open. Inside, `docker` talks to the sandbox's own Docker. Only the sandbox's owner (and the admin) can open it, from the Purgatorium pages themselves (signed in; not with a token); at most 5 at once per user.

## Terminal in a container

The **Containers** tab of a sandbox's panel (not in Simple) lists the containers in the sandbox's own Docker: name, compose project and service, image, state (API `GET /sandboxes/:name/containers`). **Terminal** next to a running one opens the same browser terminal, in that container: as the container's own user (its `user:`), in its working directory, with that user's login shell (else bash, else sh). That is the way into an app that only has a console, e.g. Claude Code in a devcontainer.

Users have this terminal too, for their own sandboxes only, without the rest of the UI: `/sandboxes/<name>/terminal?container=<container>` on the users' address (signed out, it goes through sign-in and comes back). With `&resume=<conversation id>&dir=/home/agent/workspace/<folder>` it runs `claude --resume <id>` in that folder, then leaves a shell: the link [`/p9m:teleport`](https://csakaszamok.github.io/p9m/0.19/claude-plugin/index.md) ends with. Only those two values, strictly checked (a UUID and a teleported project's folder), so a link someone sends can at most open a conversation in your own container, never run a command. The websocket takes the same session, same-origin only, at most 5 terminals per user. The rules are the terminal's above; closing the tab ends the shell and what runs in it (Claude Code keeps its conversations: `claude --continue` picks up again; or run it in `tmux`).

## App logs

**Logs** in a sandbox's panel opens, in a new tab, what the apps in the sandbox write: the last 100 lines of every container (time, service name; errors in red), then new lines as they come. A filter shows one service; Pause holds new lines, Clear empties the view. It does not wake the sandbox or keep it awake: a sleeping one says *asleep* with a **Start** button. With a token: `curl -N -H "Authorization: Bearer $TOKEN" https://p9m.example.com/sandboxes/p9m-shop/logs/stream`. At most 5 viewers per sandbox at once.
