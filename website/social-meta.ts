import type { RouteMeta } from '@rspress/core';

export const docsSiteOrigin = 'https://devcodex-labs.github.io';
export const siteBase = '/monSQLize/';
export const shareImageUrl = `${docsSiteOrigin}${siteBase}og-image.png`;

export const localeDescriptions = {
    en: 'A database-native TypeScript production data runtime layer with MongoDB stable today, plus cache, pools, transactions, models, sync, and observability.',
    zh: '数据库原生 TypeScript 生产数据运行时增强层。当前 MongoDB 稳定，并提供缓存、连接池、事务、Model、同步与可观测能力。',
} as const;

export const shareImageAlt = {
    en: 'monSQLize: MongoDB today, MySQL and PostgreSQL adapters next',
    zh: 'monSQLize：当前支持 MongoDB，后续接入 MySQL 与 PostgreSQL 适配器',
} as const;

export type DocsLocale = keyof typeof localeDescriptions;

const cjkPattern = /[\u4e00-\u9fff]/;

type SocialRoute = Pick<RouteMeta, 'routePath'> & { lang?: string };

export function localeFromLanguage(language: string | undefined, routePath = ''): DocsLocale {
    if (language?.toLowerCase().startsWith('zh')) return 'zh';
    if (routePath === '/zh' || routePath.startsWith('/zh/')) return 'zh';
    return 'en';
}

export function absolutePageUrl(routePath: string): string {
    const normalized = routePath.startsWith('/') ? routePath : `/${routePath}`;
    const prefix = `${docsSiteOrigin}${siteBase}`;
    if (normalized === '/') return prefix;
    if (normalized.endsWith('/')) return `${prefix}${normalized.slice(1)}`;
    return `${prefix}${normalized.slice(1)}.html`;
}

export function routePathFromHtmlFile(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    if (normalized === 'index.html') return '/';
    if (normalized.endsWith('/index.html')) return `/${normalized.slice(0, -'index.html'.length)}`;
    if (normalized.endsWith('.html')) return `/${normalized.slice(0, -'.html'.length)}`;
    return `/${normalized}`;
}

export function localeFromHtml(html: string, relativePath: string): DocsLocale {
    const language = html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i)?.[1];
    return localeFromLanguage(language, routePathFromHtmlFile(relativePath));
}

export function socialMetaTags(route: SocialRoute): Array<['meta', Record<string, string>]> {
    const locale = localeFromLanguage(route.lang, route.routePath);
    return [
        ['meta', { property: 'og:image', content: shareImageUrl }],
        ['meta', { property: 'og:image:width', content: '1200' }],
        ['meta', { property: 'og:image:height', content: '630' }],
        ['meta', { property: 'og:image:alt', content: shareImageAlt[locale] }],
        ['meta', { property: 'og:url', content: absolutePageUrl(route.routePath) }],
        ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
        ['meta', { name: 'twitter:image', content: shareImageUrl }],
    ];
}

export function socialHeadEntries(): Array<(route: RouteMeta) => ['meta', Record<string, string>] | undefined> {
    return socialMetaTags({ lang: 'en', routePath: '/' }).map((_, index) => (route: RouteMeta) => {
        if (!route?.routePath) return undefined;
        return socialMetaTags(route)[index];
    });
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function renderMetaTag(attrs: Record<string, string>): string {
    const rendered = Object.entries(attrs)
        .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
        .join(' ');
    return `<meta ${rendered}>`;
}

function descriptionIsWrongLanguage(content: string, locale: DocsLocale): boolean {
    const trimmed = content.trim();
    if (!trimmed) return true;
    const hasCjk = cjkPattern.test(trimmed);
    return locale === 'en' ? hasCjk : !hasCjk;
}

function replaceMetaContent(tag: string, content: string): string {
    if (/\bcontent="[^"]*"/.test(tag)) {
        return tag.replace(/\bcontent="[^"]*"/, `content="${escapeAttribute(content)}"`);
    }
    if (/\bcontent='[^']*'/.test(tag)) {
        return tag.replace(/\bcontent='[^']*'/, `content="${escapeAttribute(content)}"`);
    }
    return tag;
}

export function applyBuiltPageMeta(html: string, relativePath: string): {
    html: string;
    descriptionCorrected: boolean;
    socialAdded: boolean;
} {
    const locale = localeFromHtml(html, relativePath);
    const description = localeDescriptions[locale];
    let descriptionCorrected = false;

    if (!html.includes('</head>')) {
        return { html, descriptionCorrected: false, socialAdded: false };
    }

    let next = html.replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
        const isDescription = /\b(?:name=["']description["']|property=["']og:description["'])/i.test(tag);
        if (!isDescription) return tag;
        const contentMatch = /\bcontent=(["'])([\s\S]*?)\1/i.exec(tag);
        const content = contentMatch?.[2] ?? '';
        if (!descriptionIsWrongLanguage(content, locale)) return tag;
        descriptionCorrected = true;
        return replaceMetaContent(tag, description);
    });

    const missingDescription: string[] = [];
    if (!/\bname=["']description["']/i.test(next)) {
        missingDescription.push(renderMetaTag({ name: 'description', content: description }));
    }
    if (!/\bproperty=["']og:description["']/i.test(next)) {
        missingDescription.push(renderMetaTag({ property: 'og:description', content: description }));
    }
    if (missingDescription.length > 0) {
        descriptionCorrected = true;
        next = next.replace('</head>', `${missingDescription.join('')}</head>`);
    }

    const socialAdded = !/\bproperty=["']og:image["']/i.test(next);
    if (socialAdded) {
        const routePath = routePathFromHtmlFile(relativePath);
        const tags = socialMetaTags({ lang: locale, routePath }).map(([, attrs]) => renderMetaTag(attrs)).join('');
        next = next.replace('</head>', `${tags}</head>`);
    }

    return { html: next, descriptionCorrected, socialAdded };
}
