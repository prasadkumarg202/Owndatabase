"""Resumable uploads (TUS 1.0.0) at /storage/v1/<project>/upload/resumable, as used by tus-js-client / Uppy."""
import base64
import hashlib
import os

import pytest
import requests
from odb import BASE, URLS, create_project

TUS = {"Tus-Resumable": "1.0.0"}


def meta(**kv) -> str:
    return ",".join(f"{k} {base64.b64encode(v.encode()).decode()}" for k, v in kv.items())


@pytest.fixture(scope="module")
def proj(owner):
    p = create_project(owner, "tus")
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "big", "public": False}).status_code in (200, 201)
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "small", "public": False, "file_size_limit": 1000,
                                                                 "allowed_mime_types": ["text/plain"]}).status_code in (200, 201)
    return p


def start(p, length: int, name: str, bucket="big", key=None, headers=None, base=None):
    h = {**TUS, "apikey": key or p.service_key, "Upload-Length": str(length),
         "Upload-Metadata": meta(bucketName=bucket, objectName=name, contentType="application/octet-stream"), **(headers or {})}
    return requests.post(base or f"{URLS['storage']}/v1/{p.id}/upload/resumable", headers=h, timeout=30)


def patch(p, loc: str, offset: int, data: bytes, key=None):
    return requests.patch(f"{BASE}{loc}", data=data, timeout=60, headers={
        **TUS, "apikey": key or p.service_key, "Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream"})


def head(p, loc: str, key=None):
    return requests.head(f"{BASE}{loc}", headers={**TUS, "apikey": key or p.service_key}, timeout=30)


def test_upload_in_chunks_and_resume(proj):
    data = os.urandom(3 * 1024 * 1024 + 123)          # 3 MiB + change, sent in 1 MiB chunks
    r = start(proj, len(data), "videos/clip.bin")
    assert r.status_code == 201, r.text
    loc = r.headers["Location"]
    assert loc.startswith(f"/storage/v1/{proj.id}/upload/resumable/") and r.headers["Tus-Resumable"] == "1.0.0"
    assert "Upload-Expires" in r.headers

    step = 1024 * 1024
    assert patch(proj, loc, 0, data[:step]).headers["Upload-Offset"] == str(step)
    # "connection dropped": the client asks where to continue
    h = head(proj, loc)
    assert h.status_code == 200 and h.headers["Upload-Offset"] == str(step) and h.headers["Upload-Length"] == str(len(data))
    assert h.headers["Cache-Control"] == "no-store"
    # a stale offset is refused
    assert patch(proj, loc, 0, data[:10]).status_code == 409
    off = step
    while off < len(data):
        r = patch(proj, loc, off, data[off:off + step])
        assert r.status_code == 204, r.text
        off = int(r.headers["Upload-Offset"])
    assert off == len(data)

    # the object is in the bucket with the right content; the upload is gone
    dl = proj.storage("GET", "object/big/videos/clip.bin", key=proj.service_key)
    assert dl.status_code == 200 and hashlib.sha256(dl.content).digest() == hashlib.sha256(data).digest()
    info = proj.storage("GET", "object/info/big/videos/clip.bin", key=proj.service_key).json()
    assert int(info["size_bytes"]) == len(data)
    assert head(proj, loc).status_code == 404


def test_creation_with_upload_and_upsert(proj):
    body = b"hello resumable"
    r = requests.post(f"{URLS['storage']}/v1/{proj.id}/upload/resumable", data=body, timeout=30, headers={
        **TUS, "apikey": proj.service_key, "Upload-Length": str(len(body)), "Content-Type": "application/offset+octet-stream",
        "Upload-Metadata": meta(bucketName="big", objectName="notes/one.txt", contentType="text/plain")})
    assert r.status_code == 201 and r.headers["Upload-Offset"] == str(len(body)), r.text
    assert proj.storage("GET", "object/big/notes/one.txt", key=proj.service_key).content == body
    # the same name again needs x-upsert
    assert start(proj, 3, "notes/one.txt").status_code == 409
    r = start(proj, 3, "notes/one.txt", headers={"x-upsert": "true"})
    assert r.status_code == 201
    assert patch(proj, r.headers["Location"], 0, b"new").status_code == 204
    assert proj.storage("GET", "object/big/notes/one.txt", key=proj.service_key).content == b"new"


def test_limits_and_permissions(proj):
    # bucket size limit and MIME types are checked when the upload starts
    assert start(proj, 5000, "x.txt", bucket="small").status_code == 413
    r = requests.post(f"{URLS['storage']}/v1/{proj.id}/upload/resumable", timeout=30, headers={
        **TUS, "apikey": proj.service_key, "Upload-Length": "10",
        "Upload-Metadata": meta(bucketName="small", objectName="x.png", contentType="image/png")})
    assert r.status_code == 415
    # a chunk longer than the rest of the upload
    r = start(proj, 4, "short.bin")
    assert patch(proj, r.headers["Location"], 0, b"too long").status_code == 413
    assert head(proj, r.headers["Location"]).headers["Upload-Offset"] == "0"
    # anon may not write to an owner-only bucket; other keys cannot see someone's upload
    assert start(proj, 10, "anon.bin", key=proj.anon_key).status_code == 403
    loc = start(proj, 10, "private.bin").headers["Location"]
    assert head(proj, loc, key=proj.anon_key).status_code == 404
    assert patch(proj, loc, 0, b"0123456789", key=proj.anon_key).status_code == 404
    # missing metadata / length, wrong content type
    assert requests.post(f"{URLS['storage']}/v1/{proj.id}/upload/resumable", headers={**TUS, "apikey": proj.service_key, "Upload-Length": "1"}, timeout=30).status_code == 400
    assert requests.patch(f"{BASE}{loc}", data=b"x", headers={**TUS, "apikey": proj.service_key, "Upload-Offset": "0", "Content-Type": "text/plain"}, timeout=30).status_code == 415


def test_cancel(proj):
    r = start(proj, 100, "cancel.bin")
    loc = r.headers["Location"]
    assert patch(proj, loc, 0, b"x" * 50).status_code == 204
    assert requests.delete(f"{BASE}{loc}", headers={**TUS, "apikey": proj.service_key}, timeout=30).status_code == 204
    assert head(proj, loc).status_code == 404
    assert proj.storage("GET", "object/info/big/cancel.bin", key=proj.service_key).status_code == 404


def test_supabase_style_path(proj):
    """supabase-js / tus-js-client endpoint: <project url>/storage/v1/upload/resumable"""
    r = start(proj, 2, "via-p.bin", base=f"{BASE}/p/{proj.id}/storage/v1/upload/resumable")
    assert r.status_code == 201, r.text
    assert patch(proj, r.headers["Location"], 0, b"ok").status_code == 204
    assert proj.storage("GET", "object/big/via-p.bin", key=proj.service_key).content == b"ok"
    caps = requests.options(f"{URLS['storage']}/v1/{proj.id}/upload/resumable", timeout=10)
    assert "creation" in caps.headers.get("Tus-Extension", "") and caps.headers.get("Tus-Version") == "1.0.0"
