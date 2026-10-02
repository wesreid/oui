#!/usr/bin/env node
/**
 * The documentation site, generated from the repository's own Markdown and
 * schemas into `site/`: nothing in it is written by hand.
 *
 * - the repository README, VERSIONING.md and RELEASING.md;
 * - each package's README and CHANGELOG, and any other Markdown it ships
 *   (the OUI specification, the contract's integrator guide);
 * - the JSON files those documents link to (the contract's schemas, the
 *   approval vectors), copied as they are.
 *
 * Links between Markdown files become links between pages. Run it with
 * `pnpm site`; CI builds it on every change and the Pages workflow publishes
 * it from `main`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { Marked } from 'marked';
import { ROOT, publishedPackages } from './workspace.mjs';

const OUT = join(ROOT, 'site');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '__tests__', 'evals', 'src', 'guide']);

/** Markdown and JSON a package ships as documentation, relative to the repository. */
function documents(dir) {
  const found = [];
  const walk = current => {
    for (const entry of readdirSync(join(ROOT, current), { withFileTypes: true })) {
      const path = posix.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path);
      } else if (/\.md$/i.test(entry.name) || (/\.json$/.test(entry.name) && /(^|\/)(schemas|spec)\//.test(path))) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found;
}

/** Where a Markdown file's page goes: README.md is its directory's index. */
function pagePath(markdown) {
  return markdown.replace(/(^|\/)README\.md$/i, '$1index.html').replace(/\.md$/i, '.html');
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const packages = publishedPackages();
const sources = [
  'README.md',
  'VERSIONING.md',
  'RELEASING.md',
  ...packages.flatMap(entry => documents(entry.dir)),
].filter(path => existsSync(join(ROOT, path)));
const known = new Set(sources);

function render(source) {
  const seen = new Map();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const base = slug(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        let target = href;
        if (!/^[a-z]+:|^#|^\//i.test(href)) {
          const [path, hash] = href.split('#');
          const resolved = posix.normalize(posix.join(posix.dirname(source), path));
          if (/\.md$/i.test(resolved) && known.has(resolved)) {
            target = posix.relative(posix.dirname(pagePath(source)), pagePath(resolved)) + (hash ? `#${hash}` : '');
          } else if (path && !known.has(resolved)) {
            // Outside the site (source code, a test): link to it on GitHub.
            target = `https://github.com/wesreid/oui/blob/main/${resolved}${hash ? `#${hash}` : ''}`;
          }
        }
        return `<a href="${target}"${title ? ` title="${title}"` : ''}>${text}</a>`;
      },
    },
  });
  return marked.parse(readFileSync(join(ROOT, source), 'utf8'));
}

function page(source, body) {
  const page = pagePath(source);
  const up = posix.relative(posix.dirname(page), '.') || '.';
  const link = (path, label) => `<a href="${posix.join(up, path)}">${label}</a>`;
  const nav = [
    link('index.html', 'OUI'),
    link('VERSIONING.html', 'Versioning'),
    link('RELEASING.html', 'Releasing'),
    ...packages.map(entry => link(`${entry.dir}/index.html`, `${entry.pkg.name} <small>${entry.pkg.version}</small>`)),
  ].join('\n      ');
  const title = /^#\s+(.+)$/m.exec(readFileSync(join(ROOT, source), 'utf8'))?.[1] ?? source;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title.replace(/[`*_]/g, '')}</title>
  <style>
    :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6e6e73; --line: #e5e5ea; --code: #f5f5f7; }
    @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #111113; --muted: #a1a1a6; --line: #2c2c2e; --code: #1c1c1e; } }
    body { margin: 0; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
    .layout { display: grid; grid-template-columns: 16rem minmax(0, 1fr); max-width: 80rem; margin: 0 auto; }
    nav { padding: 1.5rem 1rem; border-right: 1px solid var(--line); display: flex; flex-direction: column; gap: .4rem; position: sticky; top: 0; align-self: start; max-height: 100vh; overflow: auto; }
    nav a { color: inherit; text-decoration: none; font-size: .9rem; }
    nav small { color: var(--muted); }
    main { padding: 1.5rem 2rem 4rem; min-width: 0; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; }
    pre { background: var(--code); padding: 1rem; overflow: auto; border-radius: 6px; }
    :not(pre) > code { background: var(--code); padding: .1em .3em; border-radius: 4px; }
    table { border-collapse: collapse; display: block; overflow: auto; }
    th, td { border: 1px solid var(--line); padding: .35rem .6rem; text-align: left; vertical-align: top; }
    blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--muted); }
    @media (max-width: 48rem) { .layout { grid-template-columns: 1fr; } nav { position: static; border-right: 0; border-bottom: 1px solid var(--line); max-height: none; } main { padding: 1rem; } }
  </style>
</head>
<body>
  <div class="layout">
    <nav>
      ${nav}
    </nav>
    <main>
${body}
    </main>
  </div>
</body>
</html>
`;
}

rmSync(OUT, { recursive: true, force: true });
for (const source of sources) {
  const target = join(OUT, /\.md$/i.test(source) ? pagePath(source) : source);
  mkdirSync(dirname(target), { recursive: true });
  if (/\.md$/i.test(source)) writeFileSync(target, page(source, render(source)));
  else copyFileSync(join(ROOT, source), target);
}
writeFileSync(join(OUT, '.nojekyll'), '');

const pages = sources.filter(source => /\.md$/i.test(source)).length;
const size = sources.reduce((sum, source) => sum + statSync(join(ROOT, source)).size, 0);
console.log(`site/: ${pages} pages and ${sources.length - pages} schema files from ${Math.round(size / 1024)} KB of sources (${relative(ROOT, OUT)})`);
