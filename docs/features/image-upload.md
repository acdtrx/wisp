# Image upload

Agreed with the user on 2026-11-26, as the third step of making Wisp work out of the
box. It follows the `agent` token scope; the `wisp` CLI follows it.

## What it is for

A container runs an image containerd holds, and an image gets there by a pull from a
registry. To run an image built on another machine, a user needs a registry, which wants
HTTPS, or a shell on the host and `ctr -n wisp image import`.

With this feature an image archive, the tar `docker save` writes, is uploaded to Wisp
and imported, from the image library's page or with an API token of the `agent` scope.
A registry is no longer needed to run one's own image.

## The specs it changes

Written by the design session with this file, and agreed with it:

- `specs/CONTAINERS.md`, Image Management: uploaded images (the archive, the
  `localhost/` name, the platform, never pulled, replaced by a new upload). Image
  updates: a `localhost/` image is skipped.
- `specs/API-CONTAINERS.md`: `POST /api/containers/images/upload`; the update check's
  `skipped` for a `localhost/` image.
- `specs/API.md`: the job kind `container-image-import`. `specs/AUTH.md`: the `agent`
  scope's Images row.
- `specs/IMAGE-LIBRARY.md`, `specs/UI-HOST.md`, `specs/UI.md`: the Upload action under
  the OCI filter, no **Check this image** on a `localhost/` row, the empty state's text.
- `specs/MCP.md`: `update_container_image` on a `localhost/` image.

The builder edits none of these. It reports each sentence its work makes untrue, with
file and line. `README.md` and `CHANGELOG.md` are the builder's.

**The one exception: `specs/ERROR-HANDLING.md`.** `npm run check` holds its code table in
step with the code, so these rows, agreed here, are added by the builder in the commit
that first throws each code:

| Code | Status | Meaning |
|------|--------|---------|
| `CONTAINER_IMAGE_ARCHIVE_INVALID` | 422 | The upload is not an image archive containerd can import; the detail carries its message. A job's error only |
| `CONTAINER_IMAGE_ARCHIVE_UNNAMED` | 422 | The uploaded archive names no image. A job's error only |
| `CONTAINER_IMAGE_PLATFORM_MISMATCH` | 422 | The uploaded archive holds no image for the host's platform. A job's error only |
| `CONTAINER_IMAGE_LOCAL` | 422 | The image is under `localhost/`, this host's own, so it is not pulled. A check's `skipped` event only |

## Decisions

- **An archive, not a registry endpoint.** `docker push` wants HTTPS and a registry's
  whole protocol; `docker save` writes one file any client can send.
- **Through containerd's API**, the Transfer service the pull already uses, with the
  archive streamed to it. No `ctr` exec.
- **The name is the mark.** An upload is stored under `localhost/`, the registry host
  podman gives an image that came from no registry, and Wisp's naming rule already keeps
  as written. No label, no file of Wisp's, no `uploaded` field: nothing to keep in step
  with the image. Not `wisp/`: by Docker's naming rule that is the Docker Hub account
  `wisp`.
- **One rule keeps an upload from being replaced:** a `localhost/` ref is not pulled,
  anywhere. It holds for an image loaded with `ctr` under that name too.
- **No MCP tool.** A tool call cannot carry an archive; agents upload over the REST API.

## Open point for the builder, before anything is built

Check on tini (containerd 2.4) that the Transfer service imports a `docker save` archive
streamed over its Streaming service, with the host platform's filter, and that the
images can be stored under their `localhost/` names without an image under the archive's
own name being created or changed on the way, even for a moment. If any of that is not
so, report it before building: the specs above assume it.

## Verification

- Unit tests for what is decided before containerd is called (the route's upload
  answers, the `localhost/` name of an archive's name, the pull rule for a `localhost/`
  ref, the check's skip).
- Manager paths on tini (`CODING-RULES.md` §14), with throwaway containers and images
  only, removed when the builder is done.

## Milestones

### 1. An uploaded image runs

- On tini, `POST /api/containers/images/upload` with the archive of a small image built
  for the host's architecture and saved as `myapp:v1` answers 202; its job ends `done`
  with `localhost/myapp:v1` and its digest; `GET /api/containers/images` lists it.
- Archive names map as `CONTAINERS.md` says: a bare name, one with a registry host, a
  Docker Hub `library/` one, and one already under `localhost/`.
- A container created with `localhost/myapp:v1` is created with the `using-local` step
  and no pull, and starts.
- The staging file is gone after the job, and after a job that failed.
- An upload with an `agent` token is let through; one with a `read` token answers
  **403** `SCOPE_INSUFFICIENT`.
- An archive built for another architecture ends the job with
  `CONTAINER_IMAGE_PLATFORM_MISMATCH`, and the image list is unchanged.
- A file that is not an image archive ends the job with
  `CONTAINER_IMAGE_ARCHIVE_INVALID`; an archive that names no image with
  `CONTAINER_IMAGE_ARCHIVE_UNNAMED`.
- No file part, two file parts and a stalled body answer as the mount uploads do.

### 2. An upload is never replaced by a pull, and updates its containers

- On tini, with the registry's `docker.io/library/busybox:latest` in the library, an
  upload of an archive saved as `busybox:latest` is stored as
  `localhost/busybox:latest`, and the registry's image keeps its digest.
- An image update check of every image, and one of `localhost/busybox:latest`, each
  report it `skipped` with `CONTAINER_IMAGE_LOCAL`, and its digest is unchanged.
- MCP `update_container_image` and a `PATCH` of `image` to that name pull nothing.
- A create with a `localhost/` name containerd does not hold ends with
  `CONTAINER_IMAGE_NOT_FOUND`, and no pull was tried.
- A second upload under the same name changes the image's digest; a running container
  on it reads `updateAvailable: true`, and its restart runs the new image.

### 3. Upload from the image library

- Under the OCI filter the header's **Upload** takes a `.tar`; the import shows in the
  jobs tray and the image appears in the table when it ends, with no reload.
- A `localhost/` image's row has no **Check this image**.
- A failed import shows its message in the jobs tray, and the table is unchanged.
