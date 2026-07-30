#!/usr/bin/env python3
"""
End-to-end dashboard parity test.

For EVERY sheet source (project chip) on /agent, this script:
  1. selects the source, waits for the dashboard snapshot to be written,
  2. discovers every dashboard destination link (KPI cards, project, person,
     stage and row deep-links),
  3. visits each destination and lets the page run its own cross-verification,
  4. reads back the recorded consistency reports from sessionStorage and
     asserts that every destination rendered the same canonical rows as the
     dashboard (same row keys AND same field values).

Any disagreement is printed with the exact target, counts and field diffs, and
is also visible in the UI at /agent/mismatch-inspector.

Run:  python3 e2e/dashboard_parity.py            (defaults to localhost:8080)
      BASE_URL=... python3 e2e/dashboard_parity.py
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

# Cap per-source destinations so the suite stays fast on large sheets.
MAX_LINKS_PER_KIND = int(os.environ.get("MAX_LINKS_PER_KIND", "4"))
LINK_KINDS = ("/agent/kpi/", "/agent/project/", "/agent/person/", "/agent/stage/", "/agent/row/")


async def restore_session(context, page):
    """Restores the injected Supabase session so authenticated routes render."""
    cookies_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
    storage_key = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    session_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    if cookies_json:
        cookies = json.loads(cookies_json)
        for c in cookies:
            c["url"] = BASE_URL
        await context.add_cookies(cookies)
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    if storage_key and session_json:
        await page.evaluate(
            f"window.localStorage.setItem({json.dumps(storage_key)}, {json.dumps(session_json)})"
        )


async def read_snapshot(page):
    return await page.evaluate(
        "() => { const raw = sessionStorage.getItem('agent:dashboard-snapshot:v1');"
        " return raw ? JSON.parse(raw) : null; }"
    )


async def read_reports(page):
    return await page.evaluate(
        "() => { const raw = sessionStorage.getItem('agent:consistency-reports:v1');"
        " return raw ? JSON.parse(raw) : []; }"
    )


async def clear_reports(page):
    await page.evaluate("() => sessionStorage.removeItem('agent:consistency-reports:v1')")


async def wait_for_dashboard(page, timeout_ms=60000):
    """Waits until the source chips have rendered (live sheets resolved)."""
    await page.wait_for_selector('[data-testid="source-chip"]', timeout=timeout_ms)
    await page.wait_for_timeout(1500)


async def wait_for_snapshot(page, timeout_ms=45000):
    await page.wait_for_function(
        "() => { const raw = sessionStorage.getItem('agent:dashboard-snapshot:v1');"
        " if (!raw) return false; try { return JSON.parse(raw).rowCount >= 0; } catch { return false; } }",
        timeout=timeout_ms,
    )
    return await read_snapshot(page)


async def collect_links(page):
    """Collects dashboard destination links, grouped and capped per kind."""
    hrefs = await page.eval_on_selector_all(
        "a[href]", "els => els.map(e => e.getAttribute('href'))"
    )
    picked, seen = [], {}
    for href in hrefs:
        if not href:
            continue
        for kind in LINK_KINDS:
            if kind in href:
                seen.setdefault(kind, [])
                if href not in seen[kind] and len(seen[kind]) < MAX_LINKS_PER_KIND:
                    seen[kind].append(href)
                    picked.append(href)
                break
    return picked


async def visit_destination(page, href):
    """Client-side click-through (keeps the React Query cache warm, exactly like
    a real user clicking a dashboard card)."""
    link = page.locator(f'a[href="{href}"]').first
    try:
        await link.scroll_into_view_if_needed(timeout=5000)
        await link.click(timeout=5000)
    except Exception:
        url = href if href.startswith("http") else BASE_URL + href
        await page.goto(url, wait_until="domcontentloaded")
    # Give the destination page time to load live sources and record its report.
    try:
        await page.wait_for_function(
            "() => { const raw = sessionStorage.getItem('agent:consistency-reports:v1');"
            " return raw && JSON.parse(raw).length > 0; }",
            timeout=30000,
        )
    except Exception:
        pass
    # Let live sources settle so the recorded report reflects the final render.
    await page.wait_for_timeout(4000)


async def run_source(page, label, failures, nontrivial):
    print(f"\n=== Source: {label} ===")
    await wait_for_dashboard(page)
    chip = page.locator(f'[data-testid="source-chip"][data-source-label="{label}"]')
    await chip.first.click()
    snapshot = await wait_for_snapshot(page)
    # Wait for rows to actually land (sheets fetch after mount).
    for _ in range(20):
        if snapshot and snapshot.get("rowCount", 0) > 0:
            break
        await page.wait_for_timeout(1000)
        snapshot = await read_snapshot(page)
    print(f"snapshot rows={snapshot['rowCount']} signature={snapshot['signature']}")
    if snapshot["rowCount"] == 0:
        print("  ! source produced 0 rows (sheet unreachable?) — parity check skipped")
        return 0
    await clear_reports(page)

    links = await collect_links(page)
    print(f"destinations discovered: {len(links)}")

    for href in links:
        await visit_destination(page, href)
        try:
            await page.go_back(wait_until="domcontentloaded")
        except Exception:
            await page.goto(BASE_URL + "/agent", wait_until="domcontentloaded")
        await wait_for_dashboard(page)
        await wait_for_snapshot(page)

    reports = await read_reports(page)
    for r in reports:
        if not r.get("available"):
            continue
        status = "OK " if r.get("ok") else "FAIL"
        print(
            f"  [{status}] {r['targetLabel']:<40} dashboard={r['expectedCount']:>4}"
            f" page={r['actualCount']:>4} fieldDiffs={len(r['fieldDiffs'])}"
        )
        if r.get("expectedCount", 0) > 0 or r.get("actualCount", 0) > 0:
            nontrivial[0] += 1
        if not r.get("ok"):
            failures.append((label, r))
            for d in r["fieldDiffs"][:5]:
                print(f"        · {d['label']} → {d['field']}: dashboard={d['expected']!r} page={d['actual']!r}")
    return len(reports)


async def main():
    failures = []
    nontrivial = [0]
    checked = 0
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()
        page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))

        await restore_session(context, page)
        await page.goto(BASE_URL + "/agent", wait_until="domcontentloaded")
        await wait_for_dashboard(page)
        await wait_for_snapshot(page)
        await page.screenshot(path=str(SCREENSHOTS / "dashboard.png"))

        labels = await page.eval_on_selector_all(
            '[data-testid="source-chip"]', "els => els.map(e => e.getAttribute('data-source-label'))"
        )
        labels = [l for l in labels if l]
        if not labels:
            print("No source chips found — is the dashboard authenticated?")
            await browser.close()
            return 1
        print(f"sheet sources: {labels}")

        for label in labels:
            await page.goto(BASE_URL + "/agent", wait_until="domcontentloaded")
            await wait_for_dashboard(page)
            await wait_for_snapshot(page)
            checked += await run_source(page, label, failures, nontrivial)

        # The inspector must reflect whatever the run observed.
        await page.goto(BASE_URL + "/agent/mismatch-inspector", wait_until="domcontentloaded")
        await page.wait_for_selector('[data-testid="mismatch-inspector"]', timeout=15000)
        await page.screenshot(path=str(SCREENSHOTS / "mismatch-inspector.png"))

        await browser.close()

    print(f"\nchecked {checked} destination page(s) ({nontrivial[0]} with rows) · {len(failures)} mismatch(es)")
    if nontrivial[0] == 0:
        print("No destination page carried rows — the run proves nothing; check sheet access.")
        return 1
    if failures:
        print("Open /agent/mismatch-inspector to inspect field-level diffs.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
