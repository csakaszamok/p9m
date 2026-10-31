# Delete = archive

`DELETE /sandboxes/:name` never discards data. It:

1. stops the sandbox;
2. writes every Docker volume of the sandbox's compose project to `opt/archive/<owner>/<name>-<timestamp>/volumes/<volume>.tar.gz` (the DinD data volume holds all inner images, containers and volumes, except `claude_secrets`, the secrets a project brought with `/p9m:teleport`: they never go into an archive, and a restored sandbox is teleported into again to get them);
3. copies `opt/sandboxes/<owner>/<name>/` (compose files, certs, credentials) to `.../config/` and writes `manifest.json` (with the owner, and `secrets_excluded: true`);
4. only then removes the containers, the volumes and `opt/sandboxes/<owner>/<name>/` (and the owner's directory once it is empty). If any archive step fails nothing is removed and the call returns 500.

Afterwards the name is free again and the sandbox URL returns 404. Archives are never pruned automatically; expect a few hundred MB per sandbox, more with large images.

Restoring by hand:

```bash
A=opt/archive/alice@example.com/p9m-alice-2026-09-26T21-47-01-401Z
mkdir -p opt/sandboxes/alice@example.com
cp -r $A/config opt/sandboxes/alice@example.com/p9m-alice
for f in $A/volumes/*.tar.gz; do
  v=$(basename $f .tar.gz)
  docker volume create --label com.docker.compose.project=p9m-alice $v
  docker run --rm -v $v:/data -v "$PWD/$A/volumes":/archive alpine tar xzf /archive/$v.tar.gz -C /data
done
docker compose -f opt/sandboxes/alice@example.com/p9m-alice/docker-compose.yml up -d
```
