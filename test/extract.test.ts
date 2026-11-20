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

describe('glued text and vendor addresses', () => {
  const html = `<html><body>
    <div><span>Contact us</span><span>928-358-8404</span><span>info@wmtrailers.com</span><a href="/">Home</a></div>
    <p>Call 814-0182</p><p>Email</p><p>workhorsetrailersutah@gmail.com</p><p>Quick links</p>
    <footer>Hours: 8-5 rentals@acme.com</footer>
    <div>Powered by Booqable — support@booqable.com · 20privacy@lodgify.com</div>
  </body></html>`;
  const raw = `<html><body><p>Contact us928-358-8404info@wmtrailers.comhours</p><p>usworkhorsetrailersutah@gmail.com</p>
    <a href="mailto:workhorsetrailersutah@gmail.com">mail</a></body></html>`;

  it('keeps emails separate from neighbouring elements', () => {
    const emails = extractFromHtml(html, 'https://wmtrailers.com/').emails.map((e) => e.email).sort();
    expect(emails).toEqual(['info@wmtrailers.com', 'rentals@acme.com', 'workhorsetrailersutah@gmail.com']);
  });

  it('strips phone numbers and words glued on in a single text node', () => {
    const emails = extractFromHtml(raw, 'https://wmtrailers.com/').emails.map((e) => e.email).sort();
    expect(emails).toEqual(['info@wmtrailers.com', 'workhorsetrailersutah@gmail.com']);
  });

  it('unglues TLDs but keeps real long TLDs', () => {
    expect(cleanEmail('info@acme.comhours')).toBe('info@acme.com');
    expect(cleanEmail('a@acme.netquick')).toBe('a@acme.net');
    expect(cleanEmail('a@acme.network')).toBe('a@acme.network');
    expect(cleanEmail('a@acme.info')).toBe('a@acme.info');
    expect(cleanEmail('a@acme.co')).toBe('a@acme.co');
  });

  it('does not read URL-encoded spaces as part of the address, and drops placeholders', () => {
    const r = extractFromHtml('<html><body><a data-x="mailto:%20sales@acme.com">x</a><input placeholder="john@doe.com"></body></html>', 'https://acme.com/');
    expect(r.emails.map((e) => e.email)).toEqual(['sales@acme.com']);
  });

  it('drops booking-platform addresses', () => {
    expect(cleanEmail('support@booqable.com')).toBeNull();
    expect(cleanEmail('privacy@lodgify.com')).toBeNull();
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
