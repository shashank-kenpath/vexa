import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { getSegmentPublisher } from "../../index";
import type { TranscriptionSegment } from "../../services/segment-publisher";

// Google Meet captions DOM is volatile — Google rotates CSS class names
// periodically. We rely on stable hooks first (aria-labels, jsname,
// role="region") and fall back to class/text heuristics. Each selector
// here is tried in order; the first match wins.

const CC_BUTTON_SELECTORS: string[] = [
  'button[aria-label*="captions" i]',
  'button[aria-label*="Turn on captions" i]',
  'button[aria-label*="cc" i][role="button"]',
  'button[jsname="r8qRAd"]',
  '[role="button"][aria-label*="captions" i]',
];

const CC_CONTAINER_SELECTORS: string[] = [
  '[role="region"][aria-label*="captions" i]',
  'div[jsname="YSxPC"]',
  'div[jsname="tgaKEf"]',
  '.iOzk7',
];

/**
 * Click Meet's CC button so this bot's browser receives live captions.
 * Captions are per-viewer in Google Meet — enabling them does not affect
 * other participants. Idempotent: returns true if already on.
 */
export async function enableGoogleMeetCaptions(page: Page): Promise<boolean> {
  log("[GMeet Captions] Attempting to enable Google Meet live captions...");
  await page.waitForTimeout(2000);

  const already = await page.evaluate((selectors) => {
    for (const sel of selectors) if (document.querySelector(sel)) return true;
    return false;
  }, CC_CONTAINER_SELECTORS);
  if (already) {
    log("[GMeet Captions] Live captions already active");
    return true;
  }

  // Some Meet builds hide controls until the mouse moves.
  try {
    await page.mouse.move(400, 400);
    await page.waitForTimeout(300);
  } catch {}

  for (const sel of CC_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) === 0) continue;
      await btn.click({ timeout: 3000 });
      log(`[GMeet Captions] Clicked CC button via ${sel}`);
      await page.waitForTimeout(1500);
      const ok = await page.evaluate((selectors) => {
        for (const s of selectors) if (document.querySelector(s)) return true;
        return false;
      }, CC_CONTAINER_SELECTORS);
      if (ok) {
        log("[GMeet Captions] ✅ Captions enabled");
        return true;
      }
    } catch (err: any) {
      log(`[GMeet Captions] click ${sel} failed: ${err?.message || err}`);
    }
  }

  // Keyboard shortcut 'c' toggles captions on Meet.
  try {
    await page.keyboard.press("c");
    await page.waitForTimeout(1500);
    const ok = await page.evaluate((selectors) => {
      for (const s of selectors) if (document.querySelector(s)) return true;
      return false;
    }, CC_CONTAINER_SELECTORS);
    if (ok) {
      log("[GMeet Captions] ✅ Captions enabled via keyboard shortcut");
      return true;
    }
  } catch {}

  log("[GMeet Captions] ⚠️ Could not enable captions; observer will keep polling");
  return false;
}

/**
 * Attach a MutationObserver to the caption region and emit caption-source
 * segments via the SegmentPublisher. Each detected (speaker, text)
 * change is published as its own final segment with a unique segment_id
 * `{sessionUid}:caption:{N}` — downstream dedup is by segment_id index.
 */
export async function startGoogleMeetCaptionObserver(
  page: Page,
  botConfig: BotConfig,
): Promise<void> {
  const sessionUid = botConfig.connectionId || `gm-${Date.now()}`;
  const language = (botConfig.language || "en").toLowerCase();
  let segmentCounter = 0;

  // Inbound bridge: page → Node.
  await page.exposeFunction(
    "__vexaGMeetCaption",
    async (rawSpeaker: string, rawText: string) => {
      const text = (rawText || "").trim();
      if (!text) return;
      const speaker = (rawSpeaker || "").trim() || "Unknown";

      const publisher = getSegmentPublisher();
      if (!publisher) {
        log("[GMeet Captions] no publisher available; dropping caption");
        return;
      }

      const nowMs = Date.now();
      const sessStart = publisher.sessionStartMs || nowMs;
      const elapsedSec = Math.max(0, (nowMs - sessStart) / 1000);
      const estUtterance = estimateUtteranceLength(text);
      const startSec = Math.max(0, elapsedSec - estUtterance);
      const endSec = elapsedSec;

      segmentCounter += 1;
      const segId = `${sessionUid}:caption:${segmentCounter}`;
      const seg: TranscriptionSegment = {
        speaker,
        text,
        start: startSec,
        end: endSec,
        language,
        completed: true,
        source: "caption",
        caption_text: text,
        speaker_source: "caption",
        segment_id: segId,
        absolute_start_time: new Date(sessStart + startSec * 1000).toISOString(),
        absolute_end_time: new Date(sessStart + endSec * 1000).toISOString(),
      };
      try {
        await publisher.publishSegment(seg);
        log(
          `[GMeet Captions] +1 ${speaker}: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`,
        );
      } catch (err: any) {
        log(`[GMeet Captions] publishSegment failed: ${err?.message || err}`);
      }
    },
  );

  // Install the page-side observer. Lives entirely in the browser; calls
  // back into Node via the exposed function above whenever a *new*
  // (speaker, text) tuple appears or text mutates.
  await page.evaluate(
    ({ containerSelectors }) => {
      const w: any = window;
      if (w.__vexaGMeetCaptionObserverInstalled) return;
      w.__vexaGMeetCaptionObserverInstalled = true;

      const findContainer = (): Element | null => {
        for (const sel of containerSelectors) {
          const el = document.querySelector(sel);
          if (el) return el;
        }
        return null;
      };

      const extractSpeakerAndText = (block: Element): { speaker: string; text: string } | null => {
        let speaker = "";
        let text = "";

        const nameCandidates = block.querySelectorAll<HTMLElement>(
          'div[class*="zs7s8d"], div[class*="NWpY1d"], span[class*="zs7s8d"], span[class*="NWpY1d"], [data-self-name], [data-participant-name]',
        );
        for (const el of Array.from(nameCandidates)) {
          const t = (el.textContent || "").trim();
          if (t && t.length <= 60) {
            speaker = t;
            break;
          }
        }

        const textCandidates = block.querySelectorAll<HTMLElement>(
          'div[class*="bh44bd"], div[class*="VbkSUe"], div[class*="ygicle"], span[class*="bh44bd"], span[class*="VbkSUe"], span[class*="ygicle"]',
        );
        for (const el of Array.from(textCandidates)) {
          const t = (el.textContent || "").trim();
          if (t.length > text.length) text = t;
        }

        if (!text) {
          const all = (block.textContent || "").trim();
          if (speaker && all.startsWith(speaker)) {
            text = all.slice(speaker.length).trim();
          } else {
            text = all;
          }
        }

        if (!text) return null;
        return { speaker, text };
      };

      // Per-block dedup: emit only when a block's (speaker, text) tuple
      // changes. Meet mutates the same block while a speaker is talking;
      // this fires once per stable update.
      const lastByBlock: Map<string, string> = new Map();

      const processOnce = () => {
        const container = findContainer();
        if (!container) return;
        let blocks = container.querySelectorAll<HTMLElement>(
          'div[jsname="tgaKEf"], div[class*="iTTPOb"], div[role="presentation"]',
        );
        const list: Element[] =
          blocks.length > 0 ? (Array.from(blocks) as Element[]) : Array.from(container.children);
        let idx = 0;
        for (const block of list) {
          const parsed = extractSpeakerAndText(block);
          if (!parsed || !parsed.text) {
            idx += 1;
            continue;
          }
          const key =
            (parsed.speaker || "?") +
            "::" +
            (block.id || (block as HTMLElement).dataset?.participantId || idx);
          idx += 1;
          const last = lastByBlock.get(key);
          if (last === parsed.text) continue;
          lastByBlock.set(key, parsed.text);
          if (typeof w.__vexaGMeetCaption === "function") {
            try {
              w.__vexaGMeetCaption(parsed.speaker, parsed.text);
            } catch (err) {
              w.logBot?.("[GMeet Captions] bridge call failed: " + (err as Error).message);
            }
          }
        }
      };

      let attached: Element | null = null;
      let mo: MutationObserver | null = null;

      const attach = () => {
        const container = findContainer();
        if (!container || attached === container) return;
        if (mo) mo.disconnect();
        attached = container;
        mo = new MutationObserver(() => processOnce());
        mo.observe(container, { childList: true, subtree: true, characterData: true });
        w.logBot?.("[GMeet Captions] observer attached");
        processOnce();
      };

      const tick = () => {
        try { attach(); } catch {}
      };
      tick();
      setInterval(tick, 3000);
    },
    { containerSelectors: CC_CONTAINER_SELECTORS },
  );

  log("[GMeet Captions] Page-side observer installed");
}

function estimateUtteranceLength(text: string): number {
  // Rough: ~3 words per second.
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(0.5, words / 3);
}
