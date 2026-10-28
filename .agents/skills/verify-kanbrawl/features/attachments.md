# Image attachments

Tasks carry images on equal terms for humans and agents: humans paste from the
clipboard, drag files in or pick them in the dialog; agents use `attach_image`
over MCP. Images are stored content-addressed in `kanbrawl.db`, shown as
thumbnails on the card and in the dialog, and can be viewed full-size or
deleted. Uploads in view/edit mode happen immediately; in create mode files are
staged first and uploaded after the task exists.

## Sub-features

- `attach-create-staging` stages files in the create dialog and uploads them after the task is created.
- `attach-card-preview` shows up to three thumbnails and an image count on the card.
- `attach-viewer` opens the full-size image overlay from a dialog thumbnail, closed with Escape or a backdrop click.
- `attach-delete` removes an image from the dialog and drops it from the API and the card.
- `attach-edit-upload` uploads an image immediately while the dialog is in edit mode.

## How to get to it (user POV)

- Create mode: `+ Add task` → `Add image` in the Images section (or drop files on it, or paste an image). Thumbnails appear next to the drop zone before the task exists.
- View/edit mode: open a task, use `Add image` in the Images section; the thumbnail appears as soon as the upload finishes.
- Click a thumbnail in the dialog to open the full-size viewer; `Escape` or a backdrop click closes it.
- `✕` on a thumbnail deletes the image.

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs attachments`.
- **Stage while creating.** The runner opens `+ Add task` on Todo and feeds a PNG through `input.attachment-input` (a hidden `input[type=file]` inside the dialog). `.attachment-thumb img` appears in the staging grid before the task exists.
- **Create and persist.** After `Add task`, `GET /api/board` shows the task with one attachment: filename `verify.png`, `mimeType` `image/png`.
- **Card preview.** The card renders `.task-image-thumb` (one `<img>` per attachment, max three) and `.task-image-count` with the total.
- **Viewer.** Opening the task and clicking `.attachment-open` opens `dialog.image-viewer[open]` whose `<img src>` starts with `/api/attachments/`; `Escape` closes it.
- **Delete.** `.attachment-remove` empties the dialog's thumbnails and the API reports zero attachments.
- **Edit-mode upload.** `Edit` then another file upload shows the thumbnail immediately and the API reports the attachment before the form is saved.
- **Read the proof.** Exit code `0`, `✔ attachments: 5/5 checks passed`, `✔ attachments verified`, screenshots `00-create-dialog-staged.png`, `01-card-thumbnail.png`, `02-image-viewer.png`, `03-attachment-deleted.png`, `04-edit-mode-upload.png`, and host checks confirming the attachment rows in `kanbrawl.db` match the served board.

## Gotchas

- The upload endpoint sniffs PNG/JPEG/GIF/WebP magic bytes and ignores the declared `Content-Type`; fixtures must be real image bytes (the runner uses a minimal 1x1 PNG).
- The hidden `input.attachment-input` is driven with Playwright `setInputFiles`, which fires the same `change` event the file picker does. Only one such input exists at a time: the dialog renders create and view/edit content exclusively.
- In create mode nothing hits the server until the task is created; assert staged state in the DOM only, and assert persisted state only after the dialog closes.
- Deleting images does not touch the task's `updatedAt`; a task edited at the same time keeps its optimistic-concurrency stamp.
- Cards cap the thumbnail strip at three images; the count chip always shows the total, so assert the count rather than thumbnail count for tasks with more images.
- `attachments_changed` SSE events update other clients' task lists live; the running dialog re-renders from the latest stored task.
