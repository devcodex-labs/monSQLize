import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from '@rspress/core';
import type {
  RspressPlugin,
  SidebarGroup,
  SidebarItem,
  UserConfig,
} from '@rspress/core';
import { pluginSitemap } from '@rspress/plugin-sitemap';

type MarkdownAstNode = {
  type?: string;
  url?: string;
  children?: MarkdownAstNode[];
};

type MarkdownFile = {
  path?: string;
  history?: string[];
};

type SidebarEntrySource = {
  en: string;
  zh: string;
  link?: string;
  items?: SidebarEntrySource[];
};

type SidebarGroupSource = {
  en: string;
  zh: string;
  items: SidebarEntrySource[];
};

type NavLinkSource = {
  en: string;
  zh: string;
  link: string;
};

type NavMenuSource = {
  en: string;
  zh: string;
  items: NavLinkSource[];
};

type NavSource = NavLinkSource | NavMenuSource;

const docsReleaseVersion = process.env.DOCS_RELEASE_VERSION ?? '3.0.0';
const docsReleaseChannel = process.env.DOCS_RELEASE_CHANNEL === 'stable' ? 'stable' : 'next';
const docsReleaseLabel = docsReleaseChannel === 'stable' ? 'Current' : 'Next';
const docsReleaseLabelZh = docsReleaseChannel === 'stable' ? '当前稳定版' : '下一版本';

const navSource: NavSource[] = [
  {
    en: 'Examples',
    zh: '示例',
    link: '/examples'
  },
  {
    en: 'Model',
    zh: 'Model',
    link: '/model'
  },
  {
    en: 'API Reference',
    zh: 'API 参考',
    link: '/api-index'
  },
  {
    en: 'Versions',
    zh: '版本',
    items: [
      {
        en: `v${docsReleaseVersion} (${docsReleaseLabel})`,
        zh: `v${docsReleaseVersion}（${docsReleaseLabelZh}）`,
        link: '/getting-started'
      },
      {
        en: 'Stable package on npm',
        zh: 'npm 稳定版本',
        link: 'https://www.npmjs.com/package/monsqlize'
      },
      {
        en: 'Changelog',
        zh: '更新日志',
        link: 'https://github.com/devcodex-labs/monSQLize/blob/main/CHANGELOG.md'
      },
      {
        en: 'GitHub Pages',
        zh: 'GitHub Pages',
        link: 'https://devcodex-labs.github.io/monSQLize/'
      },
      {
        en: 'v1.x (Legacy JS)',
        zh: 'v1.x（旧版 JS）',
        link: 'https://github.com/devcodex-labs/monSQLize/tree/v1'
      }
    ]
  }
];

const englishFooterMessage = `
<div class="msq-footer msq-footer--en" role="presentation">
  <section class="msq-footer__brand" aria-label="monSQLize">
    <span class="msq-footer__mark" aria-hidden="true"></span>
    <div>
      <strong>monSQLize</strong>
      <span>Database-native TypeScript data runtime with MongoDB stable today and SQL adapters next.</span>
    </div>
  </section>
  <nav class="msq-footer__grid" aria-label="monSQLize footer">
    <div>
      <h2>Docs</h2>
      <a href="getting-started.html">Installation</a>
      <a href="basic-operations.html">Basic Usage</a>
      <a href="configuration.html">Configuration</a>
      <a href="recipes.html">Guides</a>
      <a href="examples.html">Examples</a>
      <a href="api-index.html">API Reference</a>
    </div>
    <div>
      <h2>Ecosystem</h2>
      <a href="https://github.com/devcodex-labs" target="_blank" rel="noreferrer">VextJS Organization</a>
      <a href="https://devcodex-labs.github.io/vextjs/" target="_blank" rel="noreferrer">VextJS</a>
      <a href="https://devcodex-labs.github.io/schema-dsl/" target="_blank" rel="noreferrer">schema-dsl</a>
      <a href="https://devcodex-labs.github.io/flex-rate-limit/" target="_blank" rel="noreferrer">flex-rate-limit</a>
    </div>
    <div>
      <h2>Project</h2>
      <a href="https://github.com/devcodex-labs/monSQLize" target="_blank" rel="noreferrer">GitHub</a>
      <a href="https://github.com/devcodex-labs/monSQLize/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">Changelog</a>
      <a href="https://github.com/devcodex-labs/monSQLize/releases" target="_blank" rel="noreferrer">Releases</a>
      <a href="https://github.com/devcodex-labs/monSQLize/issues" target="_blank" rel="noreferrer">Issues</a>
    </div>
    <div>
      <h2>Runtime</h2>
      <span>Apache-2.0</span>
      <span>Node.js 18+</span>
      <span>MongoDB adapter stable</span>
      <span>TypeScript ready</span>
    </div>
  </nav>
</div>`;

const chineseFooterMessage = `
<div class="msq-footer msq-footer--zh" role="presentation">
  <section class="msq-footer__brand" aria-label="monSQLize">
    <span class="msq-footer__mark" aria-hidden="true"></span>
    <div>
      <strong>monSQLize</strong>
      <span>数据库原生 TypeScript 数据运行时，当前 MongoDB 稳定，后续接入 SQL adapter。</span>
    </div>
  </section>
  <nav class="msq-footer__grid" aria-label="monSQLize 页脚">
    <div>
      <h2>文档</h2>
      <a href="getting-started.html">安装</a>
      <a href="basic-operations.html">快速上手</a>
      <a href="configuration.html">完整配置</a>
      <a href="recipes.html">场景指南</a>
      <a href="examples.html">示例</a>
      <a href="api-index.html">API 参考</a>
    </div>
    <div>
      <h2>生态</h2>
      <a href="https://github.com/devcodex-labs" target="_blank" rel="noreferrer">VextJS 组织</a>
      <a href="https://devcodex-labs.github.io/vextjs/" target="_blank" rel="noreferrer">VextJS</a>
      <a href="https://devcodex-labs.github.io/schema-dsl/" target="_blank" rel="noreferrer">schema-dsl</a>
      <a href="https://devcodex-labs.github.io/flex-rate-limit/" target="_blank" rel="noreferrer">flex-rate-limit</a>
    </div>
    <div>
      <h2>项目</h2>
      <a href="https://github.com/devcodex-labs/monSQLize" target="_blank" rel="noreferrer">GitHub</a>
      <a href="https://github.com/devcodex-labs/monSQLize/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">更新日志</a>
      <a href="https://github.com/devcodex-labs/monSQLize/releases" target="_blank" rel="noreferrer">Releases</a>
      <a href="https://github.com/devcodex-labs/monSQLize/issues" target="_blank" rel="noreferrer">Issues</a>
    </div>
    <div>
      <h2>运行基线</h2>
      <span>Apache-2.0</span>
      <span>Node.js 18+</span>
      <span>MongoDB adapter stable</span>
      <span>TypeScript ready</span>
    </div>
  </nav>
</div>`;

const sidebarSource: SidebarGroupSource[] = [
  {
    en: 'Quick Start',
    zh: '快速入门',
    items: [
      { en: 'Installation', zh: '安装', link: '/getting-started' },
      { en: 'Basic Usage', zh: '快速上手', link: '/basic-operations' },
      { en: 'Import and ESM', zh: '导入与 ESM', link: '/esm-support' }
    ]
  },
  {
    en: 'Connection',
    zh: '连接',
    items: [
      { en: 'Connection Management', zh: '连接管理', link: '/connection' },
      { en: 'Configuration Reference', zh: '完整配置参考', link: '/configuration' },
      { en: 'Collection Management', zh: '集合管理', link: '/collection-management' },
      { en: 'Database Operations', zh: '数据库操作', link: '/database-ops' },
      { en: 'readPreference', zh: 'readPreference', link: '/readPreference' }
    ]
  },
  {
    en: 'Query and Write',
    zh: '查询与写入',
    items: [
      {
        en: 'Query Methods',
        zh: '查询方法',
        items: [
          { en: 'find()', zh: 'find()', link: '/find' },
          { en: 'findOne()', zh: 'findOne()', link: '/findOne' },
          { en: 'findPage()', zh: 'findPage()', link: '/findPage' },
          { en: 'findAndCount()', zh: 'findAndCount()', link: '/find-and-count' },
          { en: 'count()', zh: 'count()', link: '/count' },
          { en: 'distinct()', zh: 'distinct()', link: '/distinct' },
          { en: 'aggregate()', zh: 'aggregate()', link: '/aggregate' },
          { en: 'vectorSearch()', zh: 'vectorSearch()', link: '/vector-search' },
          { en: 'explain()', zh: 'explain()', link: '/explain' }
        ]
      },
      {
        en: 'Write Methods',
        zh: '写入方法',
        items: [
          { en: 'Write Operations Overview', zh: '写入操作概览', link: '/write-operations' },
          { en: 'insertOne()', zh: 'insertOne()', link: '/insert-one' },
          { en: 'insertMany()', zh: 'insertMany()', link: '/insert-many' },
          { en: 'insertBatch()', zh: 'insertBatch()', link: '/insertBatch' },
          { en: 'updateOne()', zh: 'updateOne()', link: '/update-one' },
          { en: 'updateMany()', zh: 'updateMany()', link: '/update-many' },
          { en: 'updateBatch()', zh: 'updateBatch()', link: '/updateBatch' },
          { en: 'Update Methods Overview', zh: '更新方法总览', link: '/update-operations' },
          { en: 'Aggregation Pipeline Update Guide', zh: '聚合管道更新指南', link: '/update-aggregation' },
          { en: 'replaceOne()', zh: 'replaceOne()', link: '/replace-one' },
          { en: 'findOneAndUpdate()', zh: 'findOneAndUpdate()', link: '/find-one-and-update' },
          { en: 'findOneAndReplace()', zh: 'findOneAndReplace()', link: '/find-one-and-replace' },
          { en: 'upsertOne()', zh: 'upsertOne()', link: '/upsert-one' },
          { en: 'incrementOne()', zh: 'incrementOne()', link: '/increment-one' }
        ]
      },
      {
        en: 'Delete Methods',
        zh: '删除方法',
        items: [
          { en: 'deleteOne()', zh: 'deleteOne()', link: '/delete-one' },
          { en: 'deleteMany()', zh: 'deleteMany()', link: '/delete-many' },
          { en: 'deleteBatch()', zh: 'deleteBatch()', link: '/deleteBatch' },
          { en: 'findOneAndDelete()', zh: 'findOneAndDelete()', link: '/find-one-and-delete' }
        ]
      },
      {
        en: 'ObjectId',
        zh: 'ObjectId',
        items: [
          { en: 'ObjectId Auto Conversion', zh: 'ObjectId 自动转换', link: '/objectid-auto-convert' },
          { en: 'ObjectId Conversion Scope', zh: 'ObjectId 转换范围', link: '/objectid-conversion-scope' }
        ]
      },
      {
        en: 'Chaining API',
        zh: '链式查询 API',
        items: [
          { en: 'Chaining API Overview', zh: '链式 API 概览', link: '/chaining-api' },
          { en: 'Chaining Method Reference', zh: '链式方法参考', link: '/chaining-methods' }
        ]
      },
      { en: 'Write Path Policy', zh: '写路径策略', link: '/write-path-policy' },
      { en: 'Expression Function Reference', zh: '表达式函数参考', link: '/expression-functions' }
    ]
  },
  {
    en: 'Model and Schema',
    zh: 'Model 与 Schema',
    items: [
      { en: 'Model Overview', zh: 'Model 概览', link: '/model' },
      { en: 'Populate API', zh: 'Populate API', link: '/populate' },
      { en: 'Relations API', zh: 'Relations API', link: '/relations' },
      { en: 'Hooks API', zh: 'Hooks API', link: '/hooks' },
      { en: 'Relations and Populate', zh: 'Relations 与 Populate', link: '/model/relations' },
      { en: 'Nested Populate', zh: '嵌套 Populate', link: '/model/nested-populate' },
      { en: 'Relations Quick Start', zh: 'Relations 快速上手', link: '/model/relations-quickstart' }
    ]
  },
  {
    en: 'Cache',
    zh: '缓存',
    items: [
      { en: 'Cache Configuration', zh: '缓存配置', link: '/cache-configuration' },
      { en: 'Cache Creation', zh: '缓存创建', link: '/cache-creation' },
      { en: 'Cache Invalidation', zh: '缓存失效', link: '/cache-invalidation' }
    ]
  },
  {
    en: 'Transactions',
    zh: '事务',
    items: [
      { en: 'Transaction Management', zh: '事务管理', link: '/transaction' },
      { en: 'Transaction Optimizations', zh: '事务优化', link: '/transaction-optimizations' }
    ]
  },
  {
    en: 'Pools and Deployment',
    zh: '连接池与部署',
    items: [
      { en: 'Pool Configuration', zh: '连接池配置', link: '/multi-pool' },
      { en: 'Health Checks', zh: '健康检查', link: '/multi-pool-health-check' },
      { en: 'Pool Chain API', zh: '链式池访问 API', link: '/pool-chain-api' },
      { en: 'SSH Tunnel', zh: 'SSH 隧道', link: '/ssh-tunnel' },
      { en: 'Distributed Deployment Guide', zh: '分布式部署指南', link: '/distributed-deployment' },
      { en: 'Production Data Migration', zh: '生产数据迁移同步', link: '/production-data-migration' },
      { en: 'Data Tasks API', zh: '数据任务 API 参考', link: '/data-tasks' },
      { en: 'Production Rollout', zh: '生产发布与迁移', link: '/production-rollout' },
      { en: 'Distributed Deployment Quick Reference', zh: '分布式部署快速参考', link: '/distributed-deployment-quickref' }
    ]
  },
  {
    en: 'Sync and Observability',
    zh: '同步与可观测',
    items: [
      { en: 'Change Stream Sync', zh: 'Change Stream 同步', link: '/sync-backup' },
      { en: 'watch()', zh: 'watch()', link: '/watch' },
      { en: 'Slow Query Logging', zh: '慢查询日志', link: '/slow-query-log' },
      { en: 'Event System', zh: '事件系统', link: '/events' },
      { en: 'Count Queue', zh: '数量队列', link: '/count-queue' }
    ]
  },
  {
    en: 'Guides',
    zh: '场景指南',
    items: [
      { en: 'Examples', zh: '示例总览', link: '/examples' },
      { en: 'Guides', zh: '场景指南', link: '/recipes' },
      { en: 'Performance Evidence', zh: '性能证据', link: '/performance-evidence' },
      { en: 'Upsert Guide', zh: 'Upsert 指南', link: '/upsert-guide' },
      { en: 'Quick Upsert API', zh: 'Quick Upsert API', link: '/quick-upsert' },
      { en: 'Failure Recovery Examples', zh: '失败恢复示例', link: '/failure-recovery-examples' }
    ]
  },
  {
    en: 'API Reference',
    zh: 'API 参考',
    items: [
      { en: 'API Index', zh: 'API 索引', link: '/api-index' },
      { en: 'Capability Map', zh: '能力总览', link: '/capability-index' },
      { en: 'Create Index', zh: '创建索引', link: '/create-index' },
      { en: 'Create Indexes in Bulk', zh: '批量创建索引', link: '/create-indexes' },
      { en: 'Drop Index', zh: '删除索引', link: '/drop-index' },
      { en: 'List Indexes', zh: '列出索引', link: '/list-indexes' },
      { en: 'Database Administration', zh: '数据库管理', link: '/admin' },
      { en: 'Error Code Reference', zh: '错误码参考', link: '/error-codes' },
      { en: 'Data Validation', zh: '数据验证', link: '/validation' },
      { en: 'Utilities', zh: '工具方法', link: '/utilities' }
    ]
  },
  {
    en: 'Compatibility and Migration',
    zh: '兼容与迁移',
    items: [
      { en: 'MongoDB Driver Compatibility', zh: 'MongoDB Driver 兼容性', link: '/mongodb-driver-compatibility' },
      { en: 'MongoDB Native vs Extensions', zh: 'MongoDB 原生 vs 扩展', link: '/mongodb-native-vs-extensions' },
      { en: 'findOneAnd Return Value', zh: 'findOneAnd 返回值统一', link: '/findOneAnd-return-value-unified' },
      { en: 'ObjectId Cross-Version', zh: 'ObjectId 跨版本', link: '/objectid-cross-version' },
      { en: 'ObjectId Cross-Version FAQ', zh: 'ObjectId 跨版本 FAQ', link: '/objectid-cross-version-faq' },
      { en: 'ObjectId Logging Optimization', zh: 'ObjectId 日志优化', link: '/objectid-logging-optimization' },
      { en: 'Support Matrix', zh: '支持矩阵', link: '/support-matrix' }
    ]
  }
];

const isExternalLink = (link: string) => /^https?:\/\//.test(link);
const repositoryRoot = path.join(import.meta.dirname, '..');
const docsRoot = path.join(repositoryRoot, 'docs');
const githubRepositoryUrl = 'https://github.com/devcodex-labs/monSQLize';
const siteBase = '/monSQLize/';

const isExternalOrSiteLink = (url: string) =>
  /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url);

const toPosixPath = (filePath: string) => filePath.split(path.sep).join('/');

const resolveMarkdownPath = (file: MarkdownFile) =>
  file.path || file.history?.[0] || docsRoot;

const splitUrlTarget = (url: string) => {
  const match = /^([^?#]*)([?#].*)?$/.exec(url);
  return {
    targetPath: match?.[1] || '',
    suffix: match?.[2] || ''
  };
};

const rewriteRepositoryRelativeUrl = (url: string, sourceFile: string) => {
  if (!url || isExternalOrSiteLink(url)) {
    return url;
  }

  const { targetPath, suffix } = splitUrlTarget(url);
  if (!targetPath) {
    return url;
  }

  const resolvedTarget = path.resolve(path.dirname(sourceFile), targetPath);
  if (resolvedTarget === docsRoot || resolvedTarget.startsWith(`${docsRoot}${path.sep}`)) {
    return url;
  }

  if (!resolvedTarget.startsWith(`${repositoryRoot}${path.sep}`)) {
    return url;
  }

  const relativeTarget = toPosixPath(path.relative(repositoryRoot, resolvedTarget));
  const targetKind = fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isDirectory()
    ? 'tree'
    : 'blob';

  return `${githubRepositoryUrl}/${targetKind}/main/${relativeTarget}${suffix}`;
};

const visitMarkdownLinks = (node: MarkdownAstNode, visitor: (link: MarkdownAstNode) => void) => {
  if (node.type === 'link' || node.type === 'definition') {
    visitor(node);
  }

  node.children?.forEach(child => visitMarkdownLinks(child, visitor));
};

const rewriteRepositoryRelativeLinks = () => (tree: MarkdownAstNode, file: MarkdownFile) => {
  const sourceFile = resolveMarkdownPath(file);

  visitMarkdownLinks(tree, node => {
    if (typeof node.url === 'string') {
      node.url = rewriteRepositoryRelativeUrl(node.url, sourceFile);
    }
  });
};

const localizeLink = (link: string, language: 'en' | 'zh') => {
  if (language === 'en' || isExternalLink(link)) {
    return link;
  }

  return link === '/' ? '/zh/' : `/zh${link}`;
};

const createSidebarItems = (
  items: SidebarEntrySource[],
  language: 'en' | 'zh',
): Array<SidebarGroup | SidebarItem> => items.map(item => {
  if (item.items) {
    return {
      text: item[language],
      ...(item.link ? { link: localizeLink(item.link, language) } : {}),
      items: createSidebarItems(item.items, language),
    };
  }

  if (!item.link) {
    throw new Error(`Sidebar item "${item[language]}" requires link or items.`);
  }

  return {
    text: item[language],
    link: localizeLink(item.link, language),
  };
});

const createSidebar = (language: 'en' | 'zh') =>
  sidebarSource.map(group => ({
    text: group[language],
    items: createSidebarItems(group.items, language)
  }));

const englishSidebar = createSidebar('en');
const chineseSidebar = createSidebar('zh');

const isNavMenu = (item: NavSource): item is NavMenuSource => 'items' in item;

const createNav = (language: 'en' | 'zh') =>
  navSource.map(item => {
    if (isNavMenu(item)) {
      return {
        text: item[language],
        items: item.items.map(child => ({
          text: child[language],
          link: localizeLink(child.link, language)
        }))
      };
    }

    return {
      text: item[language],
      link: localizeLink(item.link, language)
    };
  });

const englishNav = createNav('en');
const chineseNav = createNav('zh');

const generatedLanguageSwitchHrefAliases = new Map([
  [`href="${siteBase}nested-populate.html"`, `href="${siteBase}model/nested-populate.html"`],
  [`href="${siteBase}relations-quickstart.html"`, `href="${siteBase}model/relations-quickstart.html"`]
]);

const collectHtmlFiles = (directory: string): string[] => {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectHtmlFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.html') ? [entryPath] : [];
  });
};

const rewriteGeneratedLanguageSwitchLinks: RspressPlugin = {
  name: 'rewrite-generated-language-switch-links',
  afterBuild(config) {
    const builtSiteDir = path.resolve(import.meta.dirname, config.outDir || 'dist');

    collectHtmlFiles(builtSiteDir).forEach(htmlFile => {
      const originalContent = fs.readFileSync(htmlFile, 'utf8');
      let rewrittenContent = originalContent;

      generatedLanguageSwitchHrefAliases.forEach((target, source) => {
        rewrittenContent = rewrittenContent.split(source).join(target);
      });

      if (rewrittenContent !== originalContent) {
        fs.writeFileSync(htmlFile, rewrittenContent);
      }
    });
  }
};

const config: UserConfig = {
  root: path.join(import.meta.dirname, '..', 'docs'),
  themeDir: path.join(import.meta.dirname, 'theme'),
  base: siteBase,
  lang: 'en',
  title: 'monSQLize',
  icon: '/favicon.svg',
  globalStyles: path.join(import.meta.dirname, 'styles', 'home.css'),
  description: 'A database-native TypeScript production data runtime layer with MongoDB stable today, plus cache, pools, transactions, models, sync, and observability.',
  outDir: 'dist',
  builderConfig: {
    performance: {
      buildCache: false,
    },
  },
  route: {
    exclude: [
      '**/function-cache.md',
      '**/cache-and-function-cache.md',
      '**/cache-hub-migration.md',
      '**/find-one-by-id.md',
      '**/find-by-ids.md',
      '**/file-dependency-governance.md',
      '**/capability-traceability.md',
      '**/release-preflight.md',
      '**/verification-entrypoints.md'
    ]
  },
  locales: [
    {
      lang: 'en',
      label: 'English',
      title: 'monSQLize',
      description: 'A database-native TypeScript production data runtime layer.'
    },
    {
      lang: 'zh',
      label: '简体中文',
      title: 'monSQLize',
      description: '数据库原生 TypeScript 生产数据运行时增强层。'
    }
  ],
  plugins: [
    rewriteGeneratedLanguageSwitchLinks,
    pluginSitemap({
      siteUrl: 'https://devcodex-labs.github.io/monSQLize'
    })
  ],
  markdown: {
    remarkPlugins: [rewriteRepositoryRelativeLinks],
    link: {
      checkDeadLinks: false
    }
  },
  search: {
    codeBlocks: true
  },
  languageParity: {
    enabled: true
  },
  themeConfig: {
    nav: englishNav,
    locales: [
      {
        lang: 'en',
        label: 'English',
        title: 'monSQLize',
        description: 'A database-native TypeScript production data runtime layer.',
        nav: englishNav,
        sidebar: {
          '/': englishSidebar
        }
      },
      {
        lang: 'zh',
        label: '简体中文',
        title: 'monSQLize',
        description: '数据库原生 TypeScript 生产数据运行时增强层。',
        nav: chineseNav,
        sidebar: {
          '/zh/': chineseSidebar
        }
      }
    ],
    sidebar: {
      '/': englishSidebar,
      '/zh/': chineseSidebar
    },
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/devcodex-labs/monSQLize'
      }
    ],
    footer: {
      message: `${englishFooterMessage}\n${chineseFooterMessage}`
    }
  }
};

export default defineConfig(config);
