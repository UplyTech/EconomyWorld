#!/usr/bin/env node
/**
 * Copy LICENSE and CHANGELOG.md from the repository root into both editions.
 *
 * There is one licence and one history for the whole project, but every
 * published artefact has to carry its own copy: `package.json` lists them under
 * "files", and the hatch sdist includes them. The two copies are generated
 * rather than maintained, and `.gitignore` keeps them out of the repository so
 * nobody can edit the copy instead of the original.
 *
 * That makes this a build step, not a convenience: on a fresh clone the copies
 * do not exist, so a publish without it ships a package with no licence file.
 *
 * With --check it only reports; that is what CI uses to prove the copies would
 * be correct without writing anything.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const check = process.argv.includes("--check");

const jobs = [];
for (const edition of ["python", "typescript"]) {
  for (const file of ["LICENSE", "CHANGELOG.md"]) {
    jobs.push({
      from: join(root, file),
      to: join(root, edition, file),
      label: `${edition}/${file}`,
    });
  }
}

let stale = 0;
for (const { from, to, label } of jobs) {
  const source = readFileSync(from);
  const upToDate = existsSync(to) && readFileSync(to).equals(source);

  if (check) {
    if (!upToDate) {
      stale += 1;
      console.error(`::error::${label} is missing or differs from the root copy`);
    }
    continue;
  }

  if (upToDate) {
    console.log(`unchanged ${label}`);
  } else {
    copyFileSync(from, to);
    console.log(`wrote     ${label}`);
  }
}

if (check && stale > 0) {
  console.error("run `node .github/scripts/sync-package-files.mjs` to refresh them");
  process.exit(1);
}

if (check) {
  console.log("ok - both editions carry the current licence and changelog");
}
