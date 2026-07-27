import fs from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("usage: node scripts/prepare-metadata-release.mjs <x.y.z>");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.name !== "monsqlize") {
  throw new Error(`unexpected package name: ${pkg.name}`);
}

pkg.version = version;
const notes = `changelogs/v${version}.md`;
pkg.files = Array.from(new Set([notes, ...pkg.files]));
fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 4)}\n`);

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
lock.version = version;
if (lock.packages?.[""]) {
  lock.packages[""].version = version;
  lock.packages[""].name = pkg.name;
}
fs.writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

const matrix = JSON.parse(fs.readFileSync("test/compatibility/matrix.json", "utf8"));
matrix.packageVersion = version;
fs.writeFileSync("test/compatibility/matrix.json", `${JSON.stringify(matrix, null, 2)}\n`);

const notesBody = `# monSQLize v${version}

> Release date: 2026-07-27

## Highlights

- chore: republish package repository/homepage metadata for GitHub org \`devcodex-labs\`.
- Package name \`monsqlize\` unchanged.

## Compatibility boundaries

- No runtime API changes in this metadata release.
`;
fs.writeFileSync(notes, notesBody);

fs.writeFileSync(
  "changelogs/unreleased.md",
  `# Unreleased

## Changes after v${version}

No changes are currently recorded after v${version}.
`
);

console.log(
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      lock: lock.version,
      matrix: matrix.packageVersion,
      filesHasNotes: pkg.files.includes(notes),
    },
    null,
    2
  )
);
