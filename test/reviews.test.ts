import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../config.ts';
import { ownerNameFromReply, parseRelativeDate, type RawReview, scrapeReviews, summarizeReviews } from '../src/maps/reviews.ts';

const now = new Date('2026-11-19T12:00:00Z');
const daysAgo = (d: Date | null) => (d ? Math.round((now.getTime() - d.getTime()) / 86_400_000) : null);

describe('parseRelativeDate', () => {
  it('reads Google relative dates', () => {
    expect(daysAgo(parseRelativeDate('a week ago', now))).toBe(7);
    expect(daysAgo(parseRelativeDate('3 months ago', now))).toBe(90);
    expect(daysAgo(parseRelativeDate('Edited 2 years ago', now))).toBe(730);
    expect(daysAgo(parseRelativeDate('5 hours ago', now))).toBe(0);
    expect(parseRelativeDate('Great trailer, ago', now)).toBeNull();
  });
});

describe('ownerNameFromReply', () => {
  it('finds signed names', () => {
    expect(ownerNameFromReply('Thanks for renting with us! - Mike')).toBe('Mike');
    expect(ownerNameFromReply('We appreciate you.\nThanks again, Sarah Jensen, Owner')).toBe('Sarah Jensen');
    expect(ownerNameFromReply('Glad it worked out. Cheers, Dave (owner)')).toBe('Dave');
  });
  it('ignores unsigned replies and team sign-offs', () => {
    expect(ownerNameFromReply('Thank you for the review!')).toBeNull();
    expect(ownerNameFromReply('Thanks, The Team')).toBeNull();
  });
});

const review = (id: string, date: string, reply?: string): RawReview => ({
  id,
  lines: ['Reviewer Name', 'Local Guide · 12 reviews', date, 'Great trailer.', ...(reply ? ['Response from the owner', '2 days ago', reply] : [])],
});

describe('summarizeReviews', () => {
  it('counts recent reviews, reply share and the signing owner', () => {
    const s = summarizeReviews(
      [review('1', '2 weeks ago', 'Thanks! - Mike'), review('2', '2 months ago', 'Thanks, Mike'), review('3', '8 months ago'), review('4', '2 years ago', 'Appreciate it')],
      now,
    );
    expect(s).toEqual({ loaded: 4, lastReviewAt: '2026-11-05', reviews12m: 3, reviews90d: 2, ownerRepliesPct: 75, ownerName: 'Mike' });
  });
  it('handles places with no reviews', () => {
    expect(summarizeReviews([], now)).toEqual({ loaded: 0, lastReviewAt: null, reviews12m: 0, reviews90d: 0, ownerRepliesPct: null, ownerName: null });
  });
});

// Mocked Maps place page: Reviews tab, Sort → Newest menu, 10 reviews per scroll.
const ages = ['a day ago', '3 weeks ago', '2 months ago', '4 months ago', '6 months ago', '9 months ago', '11 months ago', 'a year ago', '2 years ago', '3 years ago'];
const placePage = `<!doctype html><html><body><div role="main">
  <h1>Acme Trailers</h1><span role="img" aria-label="4.8 stars"></span><span aria-label="312 reviews">(312)</span>
  <div aria-label="Monday, 8 AM to 6 PM; Tuesday, 8 AM to 6 PM; Wednesday, 8 AM to 6 PM; Sunday, Closed. Hide open hours for the week"></div>
  <div role="tablist"><button role="tab" aria-label="Overview">Overview</button><button role="tab" aria-label="Reviews for Acme">Reviews</button></div>
  <div id="pane" style="height:300px;overflow:auto"></div></div>
<script>
  const pane = document.getElementById('pane'); let batch = 0, sorted = false;
  const add = () => { for (let i = 0; i < 10; i++) { const k = batch * 10 + i; const d = document.createElement('div');
    d.setAttribute('data-review-id', 'r' + k); d.style.height = '80px';
    d.innerText = 'Person ' + k + '\\n' + (sorted ? ages[Math.min(batch, 9)] : '2 years ago') + '\\nNice.' + (k % 2 ? '' : '\\nResponse from the owner\\n' + 'a week ago' + '\\nThank you! - Mike');
    pane.appendChild(d); } batch++; };
  const ages = ${JSON.stringify(ages)};
  document.querySelector('[aria-label^="Reviews for"]').onclick = () => {
    const b = document.createElement('button'); b.setAttribute('aria-label', 'Sort reviews'); b.innerText = 'Sort';
    b.onclick = () => { const m = document.createElement('div'); m.setAttribute('role', 'menuitemradio'); m.innerText = 'Newest';
      m.onclick = () => { sorted = true; pane.innerHTML = ''; batch = 0; add(); }; document.body.appendChild(m); };
    document.querySelector('[role=main]').insertBefore(b, pane); add(); };
  pane.addEventListener('scroll', () => { if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5) add(); });
</script></body></html>`;

describe.skipIf(!process.env.BROWSER_TESTS)('scrapeReviews (mocked Maps)', () => {
  it('sorts by newest, scrolls past 12 months and summarises', async () => {
    const { launchContext } = await import('../src/maps/browser.ts');
    config.profileDir = mkdtempSync(join(tmpdir(), 'profiles-'));
    config.delays.actionMs = [50, 100];
    config.delays.scrollMs = [150, 200];
    const ctx = await launchContext(0);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.route('https://www.google.com/**', (route) => route.fulfill({ contentType: 'text/html', body: placePage }));
      const r = await scrapeReviews(page, '123');
      expect(r).toMatchObject({ reviewCount: 312, claimed: true, ownerName: 'Mike', ownerRepliesPct: 50 });
      expect(r.hours).toBe('Monday, 8 AM to 6 PM; Tuesday, 8 AM to 6 PM; Wednesday, 8 AM to 6 PM; Sunday, Closed');
      // Batches 0-6 are within 12 months (10 reviews each); loading stops once "a year ago" appears.
      expect(r.reviews12m).toBe(70);
      expect(r.reviews90d).toBe(30);
      expect(r.loaded).toBe(80);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});
