/**
 * The edge configuration, checked against the application it fronts.
 *
 * WHY THIS EXISTS. The nginx config and the Express config have to agree about
 * one thing - who the client is - and nothing in either file says so. nginx
 * rewrites the client address from CF-Connecting-IP and sends exactly one
 * X-Forwarded-For value; Express reads that value because TRUST_PROXY_HOPS is
 * 1. Change either half alone and the system still starts, still serves pages,
 * and silently attributes every request to a proxy: one rate-limit bucket for
 * the whole internet, and audit rows naming Cloudflare instead of a till. That
 * is the kind of break a test has to catch, because nothing else will.
 *
 * The same applies to the response headers. The SPA document is served from
 * disk by nginx and never touches Express, so helmet cannot protect it - the
 * document's CSP lives in nginx or nowhere. And that CSP has to keep matching
 * what the bundle actually loads: Google Fonts, canvas-generated images, and
 * the localhost WebSocket that QZ Tray uses for thermal printing. Tighten it
 * by hand and receipts stop printing in a shop, with no error anyone sees.
 *
 * Run as part of `npm test` (and alone with `npm run test:edge -w server`).
 * Reads files and starts a local Express app. No network, no Docker, no Redis.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import express from 'express';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

let passed = 0;
function check(what: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${what}`);
}

async function main() {
  const template = read('docker/nginx/default.prod.conf.template');
  const headers = read('docker/nginx/security-headers.conf');
  const realip = read('docker/nginx/cloudflare-realip.conf');

  console.log('\nreal client identity');

  check('the template includes the Cloudflare real-IP list', () => {
    assert.match(template, /include\s+\/etc\/nginx\/cloudflare-realip\.conf;/);
  });

  check('the real-IP list names CF-Connecting-IP and walks the chain', () => {
    assert.match(realip, /^real_ip_header\s+CF-Connecting-IP;/m);
    assert.match(realip, /^real_ip_recursive\s+on;/m);
  });

  check('the real-IP list trusts a plausible number of specific ranges', () => {
    const ranges = realip.match(/^set_real_ip_from\s+\S+;/gm) ?? [];
    // Cloudflare publishes ~22. A handful would mean a truncated fetch was
    // committed, which silently shrinks the set nginx trusts.
    assert.ok(ranges.length >= 15, `only ${ranges.length} ranges`);
  });

  check('the real-IP list trusts no catch-all range', () => {
    // The single most damaging possible edit to this file: trusting everyone
    // means anyone can forge CF-Connecting-IP and become any client they like.
    assert.doesNotMatch(realip, /set_real_ip_from\s+0\.0\.0\.0\/0/);
    assert.doesNotMatch(realip, /set_real_ip_from\s+::\/0/);
  });

  check('X-Forwarded-For is replaced, not appended', () => {
    // $proxy_add_x_forwarded_for APPENDS to whatever the request arrived with,
    // so a direct-to-origin request could seed the chain. $remote_addr is
    // already the true client by this point, and sending one value leaves
    // Express nothing to miscount.
    assert.match(template, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
    assert.doesNotMatch(template, /\$proxy_add_x_forwarded_for/);
  });

  check('TRUST_PROXY_HOPS still defaults to 1, which is what that implies', () => {
    const env = read('server/src/config/env.ts');
    const m = env.match(/TRUST_PROXY_HOPS[\s\S]{0,200}?default\((\d+)\)/);
    assert.ok(m, 'could not find the TRUST_PROXY_HOPS default');
    assert.equal(m![1], '1', 'nginx sends exactly one X-Forwarded-For value; more than one hop would read past it');
  });

  console.log('\nExpress agrees with what nginx sends');

  // Not an assertion about a string: a real Express app, configured exactly as
  // the API configures itself, asked what it thinks the client address is.
  await (async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.get('/', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    const ask = async (extra: Record<string, string>) => {
      const res = await fetch(`http://127.0.0.1:${port}/`, { headers: extra });
      return (await res.json()) as { ip: string; protocol: string };
    };

    const single = await ask({ 'X-Forwarded-For': '203.0.113.77', 'X-Forwarded-Proto': 'https' });
    check('the single value nginx sends becomes req.ip', () => {
      assert.equal(single.ip, '203.0.113.77');
      assert.equal(single.protocol, 'https');
    });

    const chain = await ask({ 'X-Forwarded-For': '9.9.9.9, 203.0.113.77' });
    check('with one hop, a longer chain resolves to its last entry', () => {
      // Documents why the nginx side must replace rather than append: had it
      // appended, this is the shape Express would see, and the attacker-supplied
      // 9.9.9.9 would be one trusted hop away from being believed.
      assert.equal(chain.ip, '203.0.113.77');
    });

    await new Promise<void>((r) => server.close(() => r()));
  })();

  console.log('\ndocument response headers');

  check('the SPA locations include the shared header set', () => {
    // Both of them: nginx's add_header does not merge, so a location that
    // forgets the include silently serves no CSP at all.
    const includes = template.match(/include\s+\/etc\/nginx\/security-headers\.conf;/g) ?? [];
    assert.ok(includes.length >= 2, `only ${includes.length} location(s) include it`);
  });

  check('HSTS is set for a year, with subdomains and without preload', () => {
    const hsts = (headers.match(/^add_header Strict-Transport-Security "([^"]+)"/m) ?? [])[1];
    assert.equal(hsts, 'max-age=31536000; includeSubDomains');
    // Preload is a one-way door compiled into browsers; it is a deliberate
    // decision for later, never a default. Asserted on the header value, not
    // the file, which discusses it at length.
    assert.ok(hsts && !hsts.includes('preload'));
  });

  check('the document is framed by nothing', () => {
    assert.match(headers, /X-Frame-Options "DENY"/);
    assert.match(headers, /frame-ancestors 'none'/);
  });

  check('nosniff, Referrer-Policy and Permissions-Policy are present', () => {
    assert.match(headers, /X-Content-Type-Options "nosniff"/);
    assert.match(headers, /Referrer-Policy "strict-origin-when-cross-origin"/);
    assert.match(headers, /Permissions-Policy "[^"]*camera=\(\)/);
  });

  check('exactly one CSP is enforced, with report-only left commented', () => {
    const enforcing = headers.match(/^add_header Content-Security-Policy /gm) ?? [];
    assert.equal(enforcing.length, 1, 'two enforced CSPs would be intersected by the browser');
    assert.match(headers, /^# add_header Content-Security-Policy-Report-Only /m);
  });

  console.log('\nthe CSP matches what the client actually loads');

  const csp = (headers.match(/^add_header Content-Security-Policy "([^"]+)"/m) ?? [])[1] ?? '';
  assert.ok(csp, 'could not read the CSP');

  check('Google Fonts is allowed, because index.html loads it', () => {
    const indexHtml = read('client/index.html');
    if (/fonts\.googleapis\.com/.test(indexHtml)) {
      assert.ok(
        csp.includes('https://fonts.googleapis.com'),
        'index.html loads a Google Fonts stylesheet that this CSP would block',
      );
      assert.ok(
        csp.includes('https://fonts.gstatic.com'),
        'the font files come from fonts.gstatic.com and this CSP would block them',
      );
    }
  });

  check('inline styles are allowed, because Tailwind and the chart library set them', () => {
    assert.match(csp, /style-src[^;]*'unsafe-inline'/);
  });

  check('data: and blob: images are allowed, because barcodes are canvas-drawn', () => {
    assert.match(csp, /img-src[^;]*\bdata:/);
    assert.match(csp, /img-src[^;]*\bblob:/);
  });

  check('the QZ Tray localhost WebSocket is allowed, or receipts stop printing', () => {
    // QZ Tray runs on the till and the browser talks to it directly over
    // wss://localhost. Nothing at the edge can compensate for blocking it,
    // because the connection never leaves the machine.
    assert.match(csp, /connect-src[^;]*wss:\/\/localhost:\*/);
  });

  check('object-src and base-uri are locked down', () => {
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
  });

  console.log('\ncaching');

  check('index.html is never cached, assets are immutable', () => {
    // index.html names the current bundle; a cached copy points a browser at
    // JavaScript the next deploy deletes.
    assert.match(template, /location \/ \{[\s\S]*?Cache-Control "no-store, must-revalidate"/);
    assert.match(template, /location \/assets\/ \{[\s\S]*?max-age=31536000, immutable/);
  });

  check('API responses are never cached, by anything', () => {
    assert.match(template, /location \/api\/ \{[\s\S]*?Cache-Control "no-store, no-cache, must-revalidate, private"/);
  });

  check('proxied locations replace the upstream Cache-Control rather than adding to it', () => {
    // add_header APPENDS to what the upstream sent. express.static already sets
    // a Cache-Control on /uploads, so without the hide the response carries two
    // conflicting values and the client picks.
    for (const loc of ['/api/', '/uploads/']) {
      const block = template.match(new RegExp(`location ${loc.replace(/\//g, '\\/')} \\{([\\s\\S]*?)\\n    \\}`));
      assert.ok(block, `could not find the ${loc} block`);
      assert.match(block![1], /proxy_hide_header Cache-Control;/, `${loc} would emit two Cache-Control values`);
    }
  });

  console.log('\nTLS');

  check('only TLS 1.2 and 1.3 are offered', () => {
    assert.match(template, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
    assert.doesNotMatch(template, /TLSv1\.1|TLSv1 /);
  });

  check('HTTP redirects to HTTPS, except for the ACME challenge', () => {
    assert.match(template, /return 301 https:\/\/\$host\$request_uri;/);
    // A challenge that gets 301'd never validates.
    const port80 = template.match(/server \{[\s\S]*?listen 80;[\s\S]*?\n\}/);
    assert.ok(port80);
    assert.match(port80![0], /\.well-known\/acme-challenge/);
  });

  check('the certificate is read from a mount, never from the image or the repo', () => {
    assert.match(template, /ssl_certificate\s+\/etc\/nginx\/certs\/origin\.pem;/);
    assert.match(template, /ssl_certificate_key\s+\/etc\/nginx\/certs\/origin\.key;/);
    const dockerfile = read('docker/Dockerfile');
    const tlsStage = dockerfile.slice(dockerfile.indexOf('AS web-tls'));
    assert.doesNotMatch(tlsStage, /COPY[^\n]*\.(pem|key|crt)/, 'a certificate is being baked into the image');
  });

  check('the ignore rules keep key material out of the repository', () => {
    // deploy/validate.sh scans the tree for actual key material; this asserts
    // the rule that stops one being added by accident in the first place.
    const ignore = read('.gitignore');
    assert.match(ignore, /\*\.key/);
    assert.match(ignore, /\*\.pem/);
  });

  console.log('\nthe routes the Cloudflare rules name actually exist');

  check('the payment webhook and callback paths are real', () => {
    // The documented WAF, cache and rate-limit bypass list is only correct if
    // these paths exist. A rename would leave a rule protecting nothing.
    const routes = read('server/src/modules/payments/payments.routes.ts');
    assert.match(routes, /webhook\/:provider/);
    assert.match(routes, /callback\/:provider/);
    const providerRoutes = read('server/src/modules/paymentProviders/paymentProviders.routes.ts');
    assert.match(providerRoutes, /paymently/);
  });

  console.log(`\n${passed} checks passed\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
