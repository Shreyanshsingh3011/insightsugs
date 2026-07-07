"""Role-scoped UI smoke test.

Seeds 3 throwaway users via the admin API, signs each into the running dev
server at http://localhost:8080, screenshots /agent/approvals, /alerts, and
/admin/audit for each role, then cleans up.

Run:  python3 scripts/tests/rls-ui-smoke.py
Requires the dev server to be up and env SUPABASE_URL / _SERVICE_ROLE_KEY /
_PUBLISHABLE_KEY (all present in the sandbox).
"""
import asyncio, os, uuid, json, sys, urllib.request
from pathlib import Path
from playwright.async_api import async_playwright

URL = os.environ["SUPABASE_URL"]
SERVICE = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
PUB = os.environ["SUPABASE_PUBLISHABLE_KEY"]
TAG = f"rls-ui-{int(asyncio.get_event_loop().time())}"
OUT = Path("/tmp/browser/rls-ui")
OUT.mkdir(parents=True, exist_ok=True)


def _req(method, path, body=None, token=SERVICE):
    req = urllib.request.Request(
        f"{URL}{path}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={
            "apikey": token,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode() or "null"
        return json.loads(raw)


def create_user(role):
    email = f"{TAG}-{role}@test.local"
    password = uuid.uuid4().hex
    u = _req("POST", "/auth/v1/admin/users", {
        "email": email, "password": password, "email_confirm": True,
        "user_metadata": {"full_name": role},
    })
    uid = u["id"]
    _req("DELETE", f"/rest/v1/user_roles?user_id=eq.{uid}")
    _req("POST", "/rest/v1/user_roles", [{"user_id": uid, "role": role}])
    return {"id": uid, "email": email, "password": password, "role": role}


def cleanup(users, proj_ids, flag_ids):
    for f in flag_ids:
        _req("DELETE", f"/rest/v1/alerts?flag_id=eq.{f}")
    for p in proj_ids:
        _req("DELETE", f"/rest/v1/pending_actions?payload->>project_id=eq.{p}")
        _req("DELETE", f"/rest/v1/audit_log?project_id=eq.{p}")
        _req("DELETE", f"/rest/v1/projects?id=eq.{p}")
    for u in users:
        try: _req("DELETE", f"/auth/v1/admin/users/{u['id']}")
        except Exception: pass


async def run_role(playwright, user, label):
    browser = await playwright.chromium.launch(headless=True)
    ctx = await browser.new_context(viewport={"width": 1280, "height": 1800})
    page = await ctx.new_page()

    await page.goto("http://localhost:8080/login", wait_until="domcontentloaded")
    await page.get_by_placeholder("Email").fill(user["email"])
    await page.get_by_placeholder("Password").fill(user["password"])
    await page.get_by_role("button", name="Sign in").click()
    try:
        await page.wait_for_url("**/agent**", timeout=8000)
    except Exception:
        await page.wait_for_load_state("networkidle")

    for path in ["/agent/approvals", "/alerts", "/admin/audit"]:
        await page.goto(f"http://localhost:8080{path}", wait_until="networkidle")
        await page.wait_for_timeout(600)
        safe = path.strip("/").replace("/", "_")
        await page.screenshot(path=str(OUT / f"{label}__{safe}.png"))
        print(f"[{label}] {path} → {OUT}/{label}__{safe}.png")

    await browser.close()


async def main():
    users, proj_ids, flag_ids = [], [], []
    try:
        for role in ("super_admin", "admin", "user"):
            users.append(create_user(role))
        su, ad, us = users

        # Seed fixtures.
        proj_a, proj_b = str(uuid.uuid4()), str(uuid.uuid4())
        proj_ids += [proj_a, proj_b]
        _req("POST", "/rest/v1/projects", [
            {"id": proj_a, "name": f"{TAG} A", "owner_id": ad["id"]},
            {"id": proj_b, "name": f"{TAG} B", "owner_id": su["id"]},
        ])
        _req("POST", "/rest/v1/pending_actions", [
            {"kind": "create_alert", "summary": f"{TAG} A", "payload": {"project_id": proj_a}, "status": "pending"},
            {"kind": "create_alert", "summary": f"{TAG} B", "payload": {"project_id": proj_b}, "status": "pending"},
        ])
        for f, by in ((f"{TAG}-A", ad["id"]), (f"{TAG}-B", su["id"])):
            flag_ids.append(f)
            _req("POST", "/rest/v1/alerts", [{"flag_id": f, "activity": "x", "sent_by": by}])
        _req("POST", "/rest/v1/audit_log", [
            {"actor_id": su["id"], "event_type": f"{TAG}-a", "project_id": proj_a},
            {"actor_id": su["id"], "event_type": f"{TAG}-b", "project_id": proj_b},
            {"actor_id": su["id"], "event_type": f"{TAG}-g", "project_id": None},
        ])

        async with async_playwright() as p:
            for u in users:
                await run_role(p, u, u["role"])
    finally:
        cleanup(users, proj_ids, flag_ids)

    print(f"\n✅ Screenshots saved to {OUT}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)
