"""Rate limits: made-up API keys are cut off per client IP (they cost a database lookup each) without
locking out keys already in use, and storage has per-minute request limits like the REST API."""
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import requests
from odb import URLS, create_project


def wait_for_next_minute():
    """The limits use one-minute windows: leave a clean window for the tests that follow."""
    time.sleep(61 - time.time() % 60)


@pytest.mark.slow
def test_invalid_api_keys_are_throttled_per_ip(owner):
    p = create_project(owner, "rl keys")
    assert p.rest("GET", "?select=*").status_code in (200, 404)  # the real key is now known (cached)
    # start at the beginning of a window so the whole flood lands in one
    if time.time() % 60 > 40:
        wait_for_next_minute()
    try:
        url = f"{URLS['rest']}/v1/{p.id}/"
        statuses = []
        with requests.Session() as s:
            for _ in range(130):
                statuses.append(s.get(url, headers={"apikey": f"odb_anon_{uuid.uuid4().hex}"}, timeout=10).status_code)
        assert statuses[:50].count(401) == 50, statuses[:50]
        assert 429 in statuses[100:], statuses[95:]
        r = requests.get(url, headers={"apikey": f"odb_anon_{uuid.uuid4().hex}"}, timeout=10)
        assert r.status_code == 429 and "Try again" in r.json()["message"]
        # a key already in use keeps working from the same address
        assert p.rest("GET", "?select=*").status_code in (200, 404)
    finally:
        wait_for_next_minute()


@pytest.mark.slow
def test_storage_requests_per_minute(owner):
    p = create_project(owner, "rl storage")
    assert p.storage("POST", "bucket", key=p.service_key, json={"name": "rl", "public": False}).status_code in (200, 201)
    url = f"{URLS['storage']}/v1/{p.id}/object/list/rl"
    if time.time() % 60 > 30:
        wait_for_next_minute()

    def batch(n):  # one kept-alive connection per worker
        with requests.Session() as s:
            return [s.post(url, headers={"apikey": p.anon_key}, json={"prefix": ""}, timeout=30) for _ in range(n)]

    with ThreadPoolExecutor(4) as pool:
        results = [r for rs in pool.map(batch, [160] * 4) for r in rs]
    codes = [r.status_code for r in results]
    assert codes.count(429) >= 30, sorted(set(codes))
    limited = next(r for r in results if r.status_code == 429)
    assert "requests/minute" in limited.json()["message"]
    # other callers (another key) are not affected
    assert p.storage("POST", "object/list/rl", key=p.service_key, json={"prefix": ""}).status_code == 200
