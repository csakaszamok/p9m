# Files

The **Files** tab of a sandbox's panel shows its files: open folders, upload files (**Upload…**, or drop them on the list, several at once) or whole folders with everything in them (**Upload folder…**, or drop the folder; folders on the way that are not there yet are made, empty ones too when dropped), download a file, or a whole folder as a `.tar` (**Download folder**), make folders and delete.

It shows four folders, the ones that are kept when the sandbox goes into deep sleep or its container is recreated: `/root` (where it opens), `/home`, `/srv` and `/opt`. Anything else in the sandbox container is gone then, so it is not offered here.

## The apps' volumes

**Volumes**, next to the four folders, lists the volumes of the apps in the sandbox's own Docker (a database's data, an app's uploads), with their compose project and the containers that use them; open one to browse, upload and download as above. Their files are in the sandbox container already (the sandbox's Docker keeps them under `/var/lib/docker/volumes/<volume>/_data`, in the `docker_data` volume), so nothing extra is started, and they are kept over a deep sleep too. Only the local driver's volumes are shown; a container's own files outside its volumes are not (use `docker cp` in the sandbox for those).

- **A running app:** while a container that uses the volume runs, the tab says so. A copy of a database's files taken while it runs may not be consistent, and the app may not expect files changed under it: stop it first (`docker compose stop db` in the sandbox), or use the database's own dump.
- **Owners:** uploaded files and new folders belong to root, readable by everyone (`0644`). An app running as another user that has to write them needs a `chown` in the sandbox.
- A volume's own folder cannot be deleted here: remove the volume with `docker volume rm`.

The sandbox has to be running: asleep, the tab offers to wake it. A file can be up to `FILES_MAX_UPLOAD` (100 MB by default, see [Configuration](https://csakaszamok.github.io/p9m/0.21/configuration/index.md)).

## API and MCP

| Method   | Path                                    |                                                                                                                                                                         |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/sandboxes/:name/files?path=/root/app` | The folder's entries (folders first): `name`, `type` (`dir`, `file`, `link`, `other`), `size`, `mtime`                                                                  |
| `GET`    | `/sandboxes/:name/files/content?path=…` | A file's bytes, or a folder as a tar                                                                                                                                    |
| `PUT`    | `/sandboxes/:name/files/content?path=…` | Upload: the body is the file (`curl -T report.pdf`); missing folders on the path are made                                                                               |
| `GET`    | `/sandboxes/:name/files/text?path=…`    | A text file as `{ path, text }` (UTF-8, up to 1 MB)                                                                                                                     |
| `POST`   | `/sandboxes/:name/files/mkdir`          | `{"path": "/srv/data"}`                                                                                                                                                 |
| `DELETE` | `/sandboxes/:name/files?path=…`         | A file, or a folder with everything in it                                                                                                                               |
| `GET`    | `/sandboxes/:name/volumes`              | The apps' volumes: `name`, `path` (e.g. `/var/lib/docker/volumes/shop_db/_data`, for the routes above), `project`, `containers` (`name`, `service`, `running`, `mount`) |

```
curl -T notes.md -H "Authorization: Bearer $P9M_TOKEN" "https://p9m.example.com/sandboxes/p9m-shop/files/content?path=/root/notes.md"
```

A token limited to the sandbox may use all of them. Over [MCP](https://csakaszamok.github.io/p9m/0.21/mcp/index.md) they are `list_sandbox_files`, `read_sandbox_file`, `write_sandbox_file` (text), `create_sandbox_folder`, `delete_sandbox_file` and `list_sandbox_volumes`; a download is left out, since a tool result carries no file.
