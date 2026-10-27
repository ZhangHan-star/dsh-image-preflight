# Image Preflight

> The whole project — plugin, tests, docs — was written with DeepSeek.

A DSH plugin that does one thing: before you send a picture, it looks at the picture, fixes it if it can, and only then hands it over to DSH.

If it can't fix it, the image goes through untouched — so you get exactly the error you'd get without the plugin installed.

## You've probably run into this

You drop an image in, and DSH says:

> only PNG / JPG / WebP / GIF images are supported

Except the image *is* a PNG. It opens fine in the viewer. Another photo from the same batch uploads without a problem, but this one keeps getting rejected.

## Why it happens

The browser decides what an image is by looking at the file extension, not the contents. The file ends in `.png`, so the browser tells DSH "this is a PNG".

DSH doesn't take that at face value — it opens the file and finds a JPEG inside. The two disagree, so it refuses the upload, with a message that has nothing to do with what actually went wrong.

Where those files come from: pictures saved from shopping sites, images forwarded through chat apps, right-click "save image as", screenshots that got renamed somewhere along the way. They've usually been converted at least once, and the extension stopped telling the truth.

## What it actually does

- **When the extension lies**: it changes the type label and leaves the image bytes alone. No re-encoding, no quality loss at all.
- **When the format isn't one DSH takes** (AVIF, TIFF, SVG and friends): it converts to JPEG — or WebP if the image has transparency, so the transparency survives.
- **When the image is too big or too wide**: it scales it down proportionally, drops the quality a little if that isn't enough, and stops as soon as it fits.
- **When the MIME type is just sloppy** (`image/jpg`, `image/x-png`): it understands those too.

The limits aren't hard-coded. It reads whatever DSH currently accepts on every upload, so if you change the limits in DSH, the plugin follows.

## What it won't do

- **Won't rescue broken files.** Half-downloaded, zero bytes, a text file renamed to png — those stay broken. It won't push a bad image through just to make the upload "succeed".
- **Won't drop your images.** Twenty-five images is over the limit; it won't quietly delete five to make room.
- **Won't see real `.avif` / `.heic` files, or files with no extension.** The browser rejects those before they ever reach the host.
- **Won't help if your model can't look at images.** That's a model capability, not an attachment problem.

## Install

1. Open DSH's plugin manager (Plugins in the sidebar).
2. Choose install from a local directory and point it at this folder.
3. Restart DSH.

"Image Preflight" shows up in the plugin list. To confirm it's working, try the image that used to be rejected.

If you'd rather use the CLI:

```
dsh plugin --profile desktop add dsh-image-preflight
```

## Settings, if you need them

The defaults are fine for most people. To change something, put it under `config` on the plugin row:

```yaml
- id: dsh-image-preflight
  name: dsh-image-preflight
  config:
    logLevel: debug
```

The two you're most likely to touch:

| Key | Default | |
| --- | --- | --- |
| `logLevel` | `info` | `silent` turns logging off; `debug` shows every encoding attempt |
| `animated` | `shrink` | what to do with an oversized animation: `shrink` keeps every frame, `first-frame` keeps only the first, `passthrough` leaves it alone |

Everything else — limit overrides, output format, quality ladder, concurrency, timeout — lives in `lib/config.js`, also with defaults.

## Logs

One line per repaired image. No image data, no paths:

```
[image-preflight] 1793029414251.png: 872x1920 574.2 KB image/png -> 872x1920 574.2 KB image/jpeg [relabel: declared image/png but bytes are image/jpeg; 0ms]
```

## Questions you might have

**Will it mess up my images?**
It only ever moves an image toward "acceptable". The relabel path touches zero bytes, and re-encoding only happens when you're actually over a limit. Anything already valid passes through exactly as it was.

**Does it send my pictures anywhere?**
No. Everything happens in memory, on your machine. No network calls, no temp files.

**Do I need to install anything else?**
It uses sharp. If sharp isn't available, the plugin quietly does nothing and your uploads behave exactly as they did before — no error, no hang.

**Does it change the chat UI?**
No. It only steps in on the host side, at the moment an image is accepted. The composer, thumbnails, draft strip and history are all still DSH's own.

## If you want to hack on it

```bash
node test/repair.test.mjs     # pipeline
node test/plugin.test.mjs     # wrapping and unload
node test/verify.mjs          # end-to-end cases
```

The test images are generated with sharp at run time; there are no binaries in the repo.

## License

MIT.
