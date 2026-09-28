import { describe, expect, it } from 'vitest';
import { cleanEmail, decodeCfEmail, extractFromHtml, scoreEmail } from '../src/emails/extract.ts';

describe('extractFromHtml', () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">{"@type":"LocalBusiness","email":"rentals@acmetrailers.com"}</script></head>
    <body><a href="mailto:Info@AcmeTrailers.com?subject=Hi">Email us</a>
    <p>Or write to bob [at] acmetrailers [dot] com. Logo: logo@2x.png, errors: abc@sentry.io</p>
    <a href="/contact-us">Contact</a><a href="https://other.com/contact">Elsewhere</a>
    <span class="__cf_email__" data-cfemail="${cf('sales@acmetrailers.com')}">[email protected]</span>
    </body></html>`;

  it('finds mailto, JSON-LD, Cloudflare and obfuscated text emails and drops junk', () => {
    const r = extractFromHtml(html, 'https://www.acmetrailers.com/');
    const emails = r.emails.map((e) => e.email).sort();
    expect(emails).toEqual(['bob@acmetrailers.com', 'info@acmetrailers.com', 'rentals@acmetrailers.com', 'sales@acmetrailers.com']);
    expect(r.emails.find((e) => e.email === 'info@acmetrailers.com')?.source).toBe('mailto');
  });

  it('collects same-site contact links only', () => {
    expect(extractFromHtml(html, 'https://www.acmetrailers.com/').contactLinks).toEqual(['https://www.acmetrailers.com/contact-us']);
  });
});

describe('helpers', () => {
  it('rejects junk', () => {
    expect(cleanEmail('noreply@acme.com')).toBeNull();
    expect(cleanEmail('image@2x.png')).toBeNull();
    expect(cleanEmail('user@example.com')).toBeNull();
    expect(cleanEmail('mailto:Owner@Acme.com')).toBe('owner@acme.com');
  });
  it('decodes cfemail', () => {
    expect(decodeCfEmail(cf('a@b.co'))).toBe('a@b.co');
  });
  it('ranks domain matches above freemail above others', () => {
    const d = scoreEmail('info@acme.com', 'mailto', 'acme.com');
    const f = scoreEmail('acme@gmail.com', 'mailto', 'acme.com');
    const o = scoreEmail('x@agency.com', 'text', 'acme.com');
    expect(d).toBeGreaterThan(f);
    expect(f).toBeGreaterThan(o);
  });
});

function cf(email: string) {
  const key = 0x5a;
  return [key, ...[...email].map((c) => c.charCodeAt(0) ^ key)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
