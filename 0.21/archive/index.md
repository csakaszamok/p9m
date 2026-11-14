# Delete = archive

`DELETE /sandboxes/:name` never discards data. It:

1. stops the sandbox;
1. writes every Docker volume of the sandbox's compose project to `opt/archive/<owner>/<name>-<timestamp>/volumes/<volume>.tar.gz` (the DinD data volume holds all inner images, containers and volumes, except `claude_secrets`, the secrets a project brought with `/p9m:teleport`: they never go into an archive, and a restored sandbox is teleported into again to get them);
1. copies the regular files of `opt/sandboxes/<owner>/<name>/` (compose files, certs, credentials; no links, device nodes or other special files, and not its SSH host keys: a restored sandbox makes new ones) to `.../config/` and writes `manifest.json` (with the owner, and `secrets_excluded: true`). The archive directory is `0700`;
1. only then removes the containers, the volumes and `opt/sandboxes/<owner>/<name>/` (and the owner's directory once it is empty). If any archive step fails nothing is removed and the call returns 500.

Afterwards the name is free again and the sandbox URL returns 404. Archives are never pruned automatically; expect a few hundred MB per sandbox, more with large images.

The volume tarballs are the volumes as they were, so whatever root in the sandbox put there is in them too: setuid files and, from a `sysbox` or `dind` sandbox, device nodes. Treat them as untrusted. Restore them only onto a `nosuid,nodev` filesystem, or, as below, strip setuid and setgid bits and device nodes (other than the 0:0 overlay whiteouts) right after extracting, the sweep export-restore runs.

Restoring by hand:

```
A=opt/archive/alice@example.com/p9m-alice-2026-09-26T21-47-01-401Z
mkdir -p opt/sandboxes/alice@example.com
cp -r $A/config opt/sandboxes/alice@example.com/p9m-alice
chmod 700 opt/sandboxes/alice@example.com/p9m-alice   # as Purgatorium makes a sandbox directory
for f in $A/volumes/*.tar.gz; do
  v=$(basename $f .tar.gz)
  docker volume create --label com.docker.compose.project=p9m-alice $v
  docker run --rm --network none -v $v:/data -v "$PWD/$A/volumes":/archive alpine sh -ec '
    tar xzf /archive/$1.tar.gz -C /data
    find /data \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} +
    find /data \( -type b -o -type c \) -exec sh -c "for f; do [ \"\$(stat -c %t:%T \"\$f\")\" = 0:0 ] || rm -f \"\$f\"; done" _ {} +' _ $v
done
docker compose -f opt/sandboxes/alice@example.com/p9m-alice/docker-compose.yml up -d
```
