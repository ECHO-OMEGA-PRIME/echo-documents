# echo-documents (superseded)

> ## TESTED AND TRANSFERRED
>
> Superseded. The canonical, security-audited version now lives at
> **https://github.com/echoomegaprime/echo-documents**
>
> - **Certified commit:** `fecef79f7f3894062021c024c1e176f448e85496`
> - **Certification Forge:** `PRODUCTION_READY` —
>   [`cert_77d72775ee83bf8fb296896c6811adb747552fd4`](https://cert-api.echosforge.com/v1/certifications/cert_77d72775ee83bf8fb296896c6811adb747552fd4/verdict)
> - **GitHub App Suite conformance:** [`.echo/repo-health.md`](https://github.com/echoomegaprime/echo-documents/blob/main/.echo/repo-health.md)
> - **Transferred:** 2026-08-12
>
> ### ⚠️ Do not deploy this copy — anyone can download any stored file
>
> Preserved unchanged for provenance. It **still contains all four defects** fixed in the
> destination:
>
> 1. **Every read route is public.** Auth is gated on the HTTP method, so all 18 `GET` routes answer
>    anyone supplying an arbitrary `X-Tenant-ID`. **`GET /documents/:id/download` fetches the object
>    from the R2 bucket and returns its body** — so raw customer file *content* is downloadable with
>    no credential, not merely metadata. `/search`, `/trash`, `/storage`, `/folders` likewise.
> 2. **`/status` discloses cross-tenant counts**, including the total number of tenants.
> 3. **Expired share links still download.** `/shared/:token` returns `410` when expired;
>    `/shared/:token/download` never checked — its query does not even `SELECT expires_at`. Anyone
>    holding an old share URL keeps download access indefinitely.
> 4. **Auth fails open** when `ECHO_API_KEY` is unset.
>
> Full detail: the destination's
> [`SECURITY.md`](https://github.com/echoomegaprime/echo-documents/blob/main/SECURITY.md).

