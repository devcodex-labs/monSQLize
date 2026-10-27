'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const websiteRoot = path.resolve(__dirname, '..');
const distRoot = path.join(websiteRoot, 'dist');
const basePath = '/monSQLize/';
const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
};

function resolveRequestPath(requestUrl) {
    const pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);
    if (!pathname.startsWith(basePath)) return undefined;
    let relativePath = pathname.slice(basePath.length);
    if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
    const candidate = path.resolve(distRoot, relativePath);
    if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${path.sep}`)) return undefined;
    return candidate;
}

function startServer() {
    const server = http.createServer((request, response) => {
        const filePath = resolveRequestPath(request.url || '/');
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        response.writeHead(200, {
            'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        fs.createReadStream(filePath).pipe(response);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function runAxe(page, route) {
    await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
    const results = await page.evaluate(() => globalThis.axe.run(globalThis.document, {
        runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
    }));
    if (results.violations.length > 0) {
        const details = results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            help: violation.help,
            nodes: violation.nodes.slice(0, 3).map((node) => ({
                target: node.target,
                html: node.html.slice(0, 500),
                failureSummary: node.failureSummary,
            })),
        }));
        throw new Error(`${route} axe violations:\n${JSON.stringify(details, null, 2)}`);
    }
}

async function verifyKeyboardEntry(page, route) {
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
        const element = globalThis.document.activeElement;
        if (!(element instanceof globalThis.HTMLElement)) return undefined;
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, text: element.textContent?.trim().slice(0, 80), width: rect.width, height: rect.height };
    });
    if (!focus || focus.tag === 'BODY' || focus.width <= 0 || focus.height <= 0) {
        throw new Error(`${route} does not expose a visible keyboard focus target after the first Tab.`);
    }
}

async function verifyLanguageAlternative(page, route) {
    const expectedLocale = route.startsWith('/zh/') ? 'en' : 'zh';
    const alternate = page.locator(`a[lang="${expectedLocale}"][rel="alternate"]`).first();
    if (await alternate.count() === 0) throw new Error(`${route} is missing the ${expectedLocale} language alternative.`);
    const href = await alternate.getAttribute('href');
    if (!href || !href.startsWith(basePath)) throw new Error(`${route} language alternative has an invalid href: ${href}`);
}

async function verifyMobileNavigation(page, origin) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}${basePath}`, { waitUntil: 'networkidle' });
    const hamburger = page.locator('button[aria-label="mobile hamburger"]:visible').first();
    await hamburger.focus();
    await page.keyboard.press('Enter');
    const mobilePanel = page.locator('.rp-nav-screen:visible, .rp-nav-hamburger__md__hover-group:visible').first();
    await mobilePanel.waitFor({ state: 'visible' });
    const languageTrigger = page.locator('.msq-language-menu--mobile .msq-language-menu__trigger:visible').first();
    await languageTrigger.focus();
    await page.keyboard.press('Enter');
    if (await languageTrigger.getAttribute('aria-expanded') !== 'true') {
        throw new Error('The mobile language menu did not expose its expanded state after keyboard activation.');
    }
    await page.locator('a[lang="zh"]:visible').first().waitFor({ state: 'visible' });
    await runAxe(page, '/ (mobile navigation open)');
}

async function main() {
    if (!fs.existsSync(distRoot)) throw new Error('website/dist is missing; run npm run build first.');

    const server = await startServer();
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    let browser;
    console.log(`Browser verification server started: pid=${process.pid} url=${origin}${basePath}`);
    try {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ baseURL: origin, viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const routes = ['/', '/getting-started.html', '/data-tasks.html', '/performance-evidence.html', '/zh/getting-started.html'];
        for (const route of routes) {
            await page.goto(`${origin}${basePath}${route.replace(/^\//, '')}`, { waitUntil: 'networkidle' });
            if ((await page.locator('main, .rp-doc, .rp-home-hero').count()) === 0) throw new Error(`${route} did not render document content.`);
            await verifyKeyboardEntry(page, route);
            await verifyLanguageAlternative(page, route);
            await runAxe(page, route);
            console.log(`Browser route verified: ${route}`);
        }
        await verifyMobileNavigation(page, origin);
        await context.close();
        console.log('Mobile navigation, language switch, keyboard focus, and axe checks verified.');
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        console.log(`Browser verification server stopped: pid=${process.pid} port=${address.port}`);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
