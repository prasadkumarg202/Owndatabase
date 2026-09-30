# Storage

Buckets and objects per project, stored in one backend (`STORAGE_BACKEND=fs|s3`: MinIO, SeaweedFS,
AWS S3, R2, B2, Wasabi) under `<projectId>/<bucketId>/<path>`. The API follows Supabase Storage;
supabase-js `storage.from(...)` works as is ([supabase-js.md](supabase-js.md)).

## Resumable uploads (TUS)

Large files, and uploads over unreliable connections, use the TUS 1.0 protocol at
`/storage/v1/<projectId>/upload/resumable`. It's the same protocol and metadata as Supabase, so
`tus-js-client` and Uppy work as in the Supabase docs:

```js
import * as tus from 'tus-js-client';

new tus.Upload(file, {
  endpoint: `${PROJECT_URL}/storage/v1/upload/resumable`,   // PROJECT_URL = https://<host>/p/<projectId> or a custom domain
  headers: { authorization: `Bearer ${session.access_token}`, 'x-upsert': 'true' },
  uploadDataDuringCreation: true,
  removeFingerprintOnSuccess: true,
  metadata: { bucketName: 'videos', objectName: 'folder/clip.mp4', contentType: 'video/mp4', cacheControl: '3600' },
  chunkSize: 6 * 1024 * 1024,
  onError: console.error,
  onSuccess: () => console.log('done'),
}).start();
```

- **Auth:** either an `apikey` header or a user access token in `Authorization: Bearer`. The same
  bucket permissions as normal uploads apply. Only the key or user that started an upload can
  continue or cancel it.
- **Protocol:** `POST` creates an upload (the first chunk may come with it), `HEAD` returns the offset
  to resume from, `PATCH` sends a chunk, `DELETE` cancels. Extensions supported: creation,
  creation-with-upload, termination, expiration.
- **Limits:** the bucket's size limit, MIME types and the project's storage quota are checked when
  the upload starts and again when it completes. Maximum size: `RESUMABLE_MAX_SIZE` (5 GB). Each
  chunk must be under the gateway's 100 MB request limit; 6 MB chunks are recommended.
- **Storage:** chunks are streamed straight to the backend, never held in memory. When the last byte
  arrives, they're joined into the object (a streamed multipart upload on S3), and it then appears
  like any other upload.
- **Expiry:** unfinished uploads expire after `RESUMABLE_EXPIRY_HOURS` (24) and are removed.
