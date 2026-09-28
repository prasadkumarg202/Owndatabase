"""Phase 4 — storage: buckets, upload/download, public vs private, owner rules, limits, MIME types, signed URLs, image transforms."""
import io
import struct
import time
import uuid
import zlib

import pytest
import requests

from odb import URLS


def png(width=64, height=48, rgb=(200, 30, 30)) -> bytes:
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


@pytest.fixture(scope="module")
def buckets(project):
    s = project.service_key
    for body in [
        {"name": "avatars", "public": True, "allowed_mime_types": ["image/*"], "file_size_limit": 200_000},
        {"name": "private-docs", "public": False},
        {"name": "shared", "public": False, "read_access": "authenticated", "write_access": "authenticated"},
    ]:
        r = project.storage("POST", "bucket", key=s, json=body)
        assert r.status_code in (201, 409), r.text
    return project


def test_bucket_management_requires_service_role(buckets, project):
    assert project.storage("POST", "bucket", json={"name": "nope"}).status_code == 403
    names = [b["name"] for b in project.storage("GET", "bucket", key=project.service_key).json()]
    assert {"avatars", "private-docs", "shared"} <= set(names)
    assert project.storage("POST", "bucket", key=project.service_key, json={"name": "Bad Name!"}).status_code == 400
    assert project.storage("POST", "bucket", key=project.service_key, json={"name": "public"}).status_code == 400


def test_dashboard_token_can_manage_buckets(project):
    r = requests.post(f"{URLS['storage']}/v1/{project.id}/bucket", json={"name": f"dash-{uuid.uuid4().hex[:6]}"},
                      headers={"Authorization": f"Bearer {project.owner.token}"}, timeout=10)
    assert r.status_code == 201, r.text


def test_upload_download_public(buckets, project):
    user = project.new_user()
    img = png()
    r = project.storage("POST", "object/avatars/u/me.png", token=user["access_token"], files={"file": ("me.png", img, "image/png")})
    assert r.status_code == 200, r.text
    assert r.json()["public_url"].endswith(f"/object/public/avatars/u/me.png")
    pub = requests.get(f"{URLS['storage']}/v1/{project.id}/object/public/avatars/u/me.png", timeout=10)
    assert pub.status_code == 200 and pub.content == img and pub.headers["content-type"] == "image/png"
    # duplicate without upsert → 409; with x-upsert → ok
    assert project.storage("POST", "object/avatars/u/me.png", token=user["access_token"], files={"file": ("me.png", img, "image/png")}).status_code == 409
    assert project.storage("POST", "object/avatars/u/me.png", token=user["access_token"], headers={"x-upsert": "true"}, files={"file": ("me.png", img, "image/png")}).status_code == 200


def test_raw_body_upload(buckets, project):
    r = project.storage("POST", "object/private-docs/raw.txt", key=project.service_key, data=b"hello raw", headers={"content-type": "text/plain"})
    assert r.status_code == 200, r.text
    got = project.storage("GET", "object/private-docs/raw.txt", key=project.service_key)
    assert got.content == b"hello raw" and got.headers["content-type"].startswith("text/plain")


def test_mime_and_size_limits(buckets, project):
    user = project.new_user()
    r = project.storage("POST", "object/avatars/x.txt", token=user["access_token"], files={"file": ("x.txt", b"text", "text/plain")})
    assert r.status_code == 415
    big = png(400, 400) + b"\x00" * 250_000
    r = project.storage("POST", "object/avatars/big.png", token=user["access_token"], files={"file": ("big.png", big, "image/png")})
    assert r.status_code == 413


def test_private_bucket_owner_rules(buckets, project):
    alice, bob = project.new_user(), project.new_user()
    r = project.storage("POST", "object/private-docs/alice/cv.pdf", token=alice["access_token"], files={"file": ("cv.pdf", b"%PDF-1.4 alice", "application/pdf")})
    assert r.status_code == 200, r.text
    assert project.storage("GET", "object/private-docs/alice/cv.pdf", token=alice["access_token"]).status_code == 200
    assert project.storage("GET", "object/private-docs/alice/cv.pdf", token=bob["access_token"]).status_code == 404
    assert project.storage("GET", "object/private-docs/alice/cv.pdf").status_code == 404          # anon
    assert requests.get(f"{URLS['storage']}/v1/{project.id}/object/public/private-docs/alice/cv.pdf", timeout=10).status_code == 400
    # bob cannot overwrite or delete alice's file
    assert project.storage("POST", "object/private-docs/alice/cv.pdf", token=bob["access_token"], headers={"x-upsert": "true"}, files={"file": ("cv.pdf", b"x", "application/pdf")}).status_code == 403
    assert project.storage("DELETE", "object/private-docs/alice/cv.pdf", token=bob["access_token"]).status_code == 403
    # anon cannot upload
    assert project.storage("POST", "object/private-docs/anon.txt", files={"file": ("a.txt", b"x", "text/plain")}).status_code == 403
    # listing shows only own files
    listing = project.storage("POST", "object/list/private-docs", token=bob["access_token"], json={"prefix": "alice"}).json()
    assert listing == []


def test_shared_bucket_authenticated_access(buckets, project):
    a, b = project.new_user(), project.new_user()
    project.storage("POST", "object/shared/team/plan.txt", token=a["access_token"], data=b"plan", headers={"content-type": "text/plain"})
    assert project.storage("GET", "object/shared/team/plan.txt", token=b["access_token"]).content == b"plan"
    assert project.storage("GET", "object/shared/team/plan.txt").status_code == 404


def test_list_folders_move_copy_delete(buckets, project):
    s = project.service_key
    for p in ["docs/a.txt", "docs/b.txt", "docs/sub/c.txt", "root.txt"]:
        assert project.storage("POST", f"object/private-docs/{p}", key=s, data=p.encode(), headers={"content-type": "text/plain", "x-upsert": "true"}).status_code == 200
    top = {o["name"]: o["is_folder"] for o in project.storage("POST", "object/list/private-docs", key=s, json={}).json()}
    assert top.get("docs") is True and top.get("root.txt") is False
    docs = {o["name"] for o in project.storage("POST", "object/list/private-docs", key=s, json={"prefix": "docs/"}).json()}
    assert docs == {"a.txt", "b.txt", "sub"}
    assert project.storage("POST", "object/move", key=s, json={"bucketId": "private-docs", "sourceKey": "docs/a.txt", "destinationKey": "docs/moved.txt"}).status_code == 200
    assert project.storage("GET", "object/private-docs/docs/a.txt", key=s).status_code == 404
    assert project.storage("GET", "object/private-docs/docs/moved.txt", key=s).content == b"docs/a.txt"
    assert project.storage("POST", "object/copy", key=s, json={"bucketId": "private-docs", "sourceKey": "root.txt", "destinationKey": "copy.txt"}).status_code == 200
    r = project.storage("DELETE", "object/private-docs", key=s, json={"prefixes": ["copy.txt", "root.txt"]})
    assert sorted(x["name"] for x in r.json()) == ["copy.txt", "root.txt"]
    info = project.storage("GET", "object/info/private-docs/docs/b.txt", key=s).json()
    assert info["size_bytes"] == len(b"docs/b.txt") and info["mime_type"] == "text/plain"


def test_path_traversal_blocked(buckets, project):
    r = project.storage("POST", "object/private-docs/..%2F..%2Fetc%2Fpasswd", key=project.service_key, data=b"x", headers={"content-type": "text/plain"})
    assert r.status_code == 400


def test_signed_urls(buckets, project):
    s = project.service_key
    project.storage("POST", "object/private-docs/signed.txt", key=s, data=b"top secret", headers={"content-type": "text/plain", "x-upsert": "true"})
    r = project.storage("POST", "object/sign/private-docs/signed.txt", key=s, json={"expiresIn": 2})
    assert r.status_code == 200, r.text
    url = f"{URLS['storage']}{r.json()['signedURL']}"
    assert requests.get(url, timeout=10).content == b"top secret"
    tampered = url.replace("signed.txt", "raw.txt")
    assert requests.get(tampered, timeout=10).status_code == 400
    time.sleep(3.2)
    assert requests.get(url, timeout=10).status_code == 400   # expired


def test_image_transformation(buckets, project):
    user = project.new_user()
    project.storage("POST", "object/avatars/t/big.png", token=user["access_token"], headers={"x-upsert": "true"}, files={"file": ("big.png", png(400, 300), "image/png")})
    r = requests.get(f"{URLS['storage']}/v1/{project.id}/render/image/public/avatars/t/big.png?width=100&format=webp", timeout=20)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "image/webp"
    assert r.content[:4] == b"RIFF" and r.content[8:12] == b"WEBP"
    r2 = requests.get(f"{URLS['storage']}/v1/{project.id}/object/public/avatars/t/big.png?width=50&format=png", timeout=20)
    w, h = struct.unpack(">II", r2.content[16:24])
    assert w == 50 and h in (37, 38)


def test_bucket_delete(buckets, project):
    s = project.service_key
    project.storage("POST", "bucket", key=s, json={"name": "tmp-bucket"})
    project.storage("POST", "object/tmp-bucket/f.txt", key=s, data=b"x", headers={"content-type": "text/plain"})
    assert project.storage("DELETE", "bucket/tmp-bucket", key=s).status_code == 409
    assert project.storage("POST", "bucket/tmp-bucket/empty", key=s).json()["deleted"] == 1
    assert project.storage("DELETE", "bucket/tmp-bucket", key=s).status_code == 200
