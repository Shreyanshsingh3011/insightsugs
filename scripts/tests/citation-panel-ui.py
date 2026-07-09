"""UI snapshot + interaction tests for the citation refusal card and side panel.

Drives the dev fixture route /dev/citations, which renders the same refusal
card markup and citation chip buttons that AgentChatWidget produces, plus
the real CitationPanel. Verifies:

  1. Refusal card renders with the amber warning + missing-fields list.
  2. Clicking each chip (sheet/doc/dashboard) opens the side panel with the
     correct title.
  3. The "Open in dashboard" button is present and enabled in the panel.

Run: python3 scripts/tests/citation-panel-ui.py
"""
import asyncio
import sys
from pathlib import Path
from playwright.async_api import async_playwright

SCREENSHOTS = Path("/tmp/browser/citations")
SCREENSHOTS.mkdir(parents=True, exist_ok=True)
URL = "http://localhost:8080/dev/citations"

async def main() -> int:
    failures: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await ctx.new_page()
        await page.goto(URL, wait_until="networkidle")
        await page.wait_for_timeout(500)

        # 1. Refusal card
        try:
            await page.get_by_test_id("refusal-card").wait_for(state="visible", timeout=5000)
            text = await page.get_by_test_id("refusal-card").inner_text()
            if "Not found in your dashboard data" not in text:
                failures.append("refusal card missing headline")
            if "Q3 revenue by region" not in text:
                failures.append("refusal card missing missing-fields list")
            await page.screenshot(path=str(SCREENSHOTS / "1_refusal.png"))
        except Exception as e:
            failures.append(f"refusal card not rendered: {e}")

        # 2. Chip -> panel checks
        chip_checks = [
            ("citation-chip-sheet", "Sheet: Projects Master · row 12"),
            ("citation-chip-doc", "Document: Kickoff Notes · p.3"),
            ("citation-chip-dashboard", "Dashboard: overdue_count"),
        ]
        for i, (tid, expected_title_fragment) in enumerate(chip_checks, start=2):
            try:
                await page.get_by_test_id(tid).click()
                await page.wait_for_timeout(700)
                panel = page.locator('[data-testid="citation-panel"]').first
                if await panel.count() == 0:
                    failures.append(f"{tid}: panel did not mount after click")
                    continue
                title = await panel.inner_text()
                if expected_title_fragment not in title:
                    failures.append(
                        f"{tid}: panel title missing '{expected_title_fragment}', got:\n{title[:200]}"
                    )
                open_btn = page.locator('[data-testid="open-in-dashboard"]').first
                if await open_btn.count() == 0:
                    failures.append(f"{tid}: 'Open in dashboard' button missing")
                elif not await open_btn.is_enabled():
                    failures.append(f"{tid}: 'Open in dashboard' button disabled")
                await page.screenshot(path=str(SCREENSHOTS / f"{i}_{tid}.png"))
                await page.keyboard.press("Escape")
                await page.wait_for_timeout(500)
            except Exception as e:
                failures.append(f"{tid}: interaction failed: {e}")


        # 3. Verify Open-in-dashboard navigates for the sheet chip
        try:
            await page.get_by_test_id("citation-chip-sheet").click()
            await page.wait_for_timeout(700)
            await page.locator('[data-testid="open-in-dashboard"]').first.click()
            await page.wait_for_url("**/sheets**", timeout=5000)
            if "/sheets" not in page.url:
                failures.append(f"navigation did not reach /sheets: {page.url}")
            await page.screenshot(path=str(SCREENSHOTS / "5_navigated.png"))
        except Exception as e:
            failures.append(f"open-in-dashboard navigation failed: {e}")

        await browser.close()

    if failures:
        print("FAIL")
        for f in failures:
            print(" -", f)
        return 1
    print("OK — refusal card + citation panel + open-in-dashboard all pass")
    return 0

sys.exit(asyncio.run(main()))
