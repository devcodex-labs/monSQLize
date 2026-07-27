import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/bump-for-release.mjs <version>");
  process.exit(1);
}

const pkgPath = "package.json";
const lockPath = "package-lock.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
if (pkg.name !== "monsqlize") {
  throw new Error(`unexpected package name: ${pkg.name}`);
}
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
lock.version = version;
if (lock.packages?.[""]) {
  lock.packages[""].version = version;
}
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(`bumped monsqlize to ${version}`);
