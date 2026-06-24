# Echo Documents

> Document management service for ECHO Prime — organize documents in folders,
> search across them, and share them. A Cloudflare Worker.

Private to Echo Prime Technologies.

## What it does

Store and organize **documents** inside **folders**, full-text **search** across
them, and **share** documents (link / recipient based). An **activity** log tracks
changes.

## API (auth: `X-Echo-API-Key`)

| Route | Resource |
|---|---|
| `/health` | Liveness |
| `/documents` · `/documents/:id` | List / create / read / update / delete documents |
| `/folders` · `/folders/:id` | Folder management |
| `/search` | Search documents |
| `/shared` | Shared documents |
| `/activity` | Activity log |

Each resource path responds to `GET` (list/read) and `POST` (create), plus
`PUT`/`DELETE` on `/:id` where applicable.

## Develop

```bash
npm install
npx wrangler dev       # local Worker
npx wrangler deploy    # deploy
```

The D1 binding and `ECHO_API_KEY` live in `wrangler.toml` / the Cloudflare
dashboard. `.gitignore` excludes `node_modules`. Never commit secrets.

## License

Proprietary — © Echo Prime Technologies. All rights reserved.
