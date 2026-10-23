#!/usr/bin/env node
/**
 * Cut a numbered release in one command:
 *
 *   npm run release:patch
 *   npm run release:minor -- --no-watch
 *   npm run release:major -- --dry-run
 *
 * It refuses to number a release from an unsafe state (dirty tree, wrong
 * branch, local commits missing from origin, an existing tag), runs the same
 * lint/typecheck/tests as CI, then bumps `package.json` + `package-lock.json`,
 * commits "Release X", creates the annotated tag `vX`, and pushes both.
 *
 * The tag is the trigger: `.github/workflows/release.yml` builds the Windows
 * installers on that tag and publishes the Setup/portable exes, blockmaps and
 * `latest.yml` (the file the in-app updater reads). So no workflow file ever
 * needs to be touched to cut a release.
 *
 * Why not a GitHub-hosted "Release" button? Adding a workflow file requires the
 * `workflow` token scope, which the current `gh` login does not have
 * (`gh auth refresh -h github.com -s workflow` grants it interactively). This
 * script needs only `repo`, which it already has.
 *
 * Flags:
 *   --dry-run       validate everything, print the number, change nothing
 *   --skip-checks   skip lint/typecheck/tests (CI still runs them on the push)
 *   --no-watch      push and exit instead of waiting for CI + Release
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "Richardnajem/ACCUBOOK";
const BRANCH = "master";
const PACKAGE = path.join(ROOT, "package.json");

const argv = process.argv.slice(2);
const bump = argv.find((arg) => ["patch", "minor", "major"].includes(arg));
const dryRun = argv.includes("--dry-run");
const skipChecks = argv.includes("--skip-checks");
const noWatch = argv.includes("--no-watch");

const say = (message) => console.log(`  ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function die(message) {
  console.error(`\n  ✖ ${message}\n`);
  process.exit(1);
}

/** Run a shell command (npm/npx need a shell on Windows). */
function sh(command, { capture = false, allowFail = false } = {}) {
  const result = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) die(`Could not run "${command}": ${result.error.message}`);
  if (result.status !== 0 && !allowFail) die(`"${command}" failed (exit ${result.status}).`);
  return (result.stdout ?? "").trim();
}

/** Run git with explicit args, so names/messages containing spaces survive. */
function git(...args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) die(`Could not run git: ${result.error.message}`);
  if (result.status !== 0) {
    die(`git ${args.join(" ")} failed:\n${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function nextVersion(current, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) die(`package.json version "${current}" is not plain x.y.z — fix it once by hand.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function watchRuns(tag) {
  if (spawnSync("gh", ["--version"], { encoding: "utf8" }).status !== 0) {
    say("gh is not installed — watch the build here:");
    say(`https://github.com/${REPO}/actions`);
    return;
  }
  const sha = git("rev-parse", "HEAD");
  const runsFor = () => {
    const raw = spawnSync(
      "gh",
      ["run", "list", "-R", REPO, "--limit", "15", "--json", "databaseId,name,headSha"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (raw.status !== 0) return [];
    try {
      return JSON.parse(raw.stdout).filter((run) => run.headSha === sha);
    } catch {
      return [];
    }
  };

  say("Waiting for the CI and Release runs to register…");
  let runs = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    runs = runsFor();
    const names = new Set(runs.map((run) => run.name));
    if (names.has("CI") && names.has("Release")) break;
    await sleep(3000);
  }

  if (!runs.length) {
    say("No workflow run registered yet — check the Actions tab:");
    say(`https://github.com/${REPO}/actions`);
    return;
  }

  let failed = false;
  for (const run of runs) {
    say(`Watching ${run.name} (${run.databaseId})…`);
    const watched = spawnSync(
      "gh",
      ["run", "watch", String(run.databaseId), "-R", REPO, "--exit-status"],
      { cwd: ROOT, stdio: "inherit" },
    );
    if (watched.status !== 0) failed = true;
    console.log("");
  }

  if (failed) {
    console.error(`  ✖ A workflow failed. Inspect it at https://github.com/${REPO}/actions`);
    process.exitCode = 1;
    return;
  }
  say(`${tag} published — https://github.com/${REPO}/releases/tag/${tag}`);
}

async function main() {
  if (!bump) {
    die("Choose the bump: npm run release:patch | release:minor | release:major");
  }

  console.log("");
  say(`Stockfolio — cut a numbered release (${bump})`);
  console.log("");

  const dirty = git("status", "--porcelain");
  if (dirty) die(`Working tree is not clean — commit or stash first:\n\n${dirty}`);

  const branch = git("branch", "--show-current");
  if (branch !== BRANCH) {
    die(`On "${branch || "detached HEAD"}"; releases are cut from ${BRANCH}.`);
  }

  say("Checking origin…");
  git("fetch", "origin", "--tags", "--prune");
  const [behind, ahead] = git("rev-list", "--left-right", "--count", `origin/${BRANCH}...HEAD`)
    .split(/\s+/)
    .map(Number);
  if (ahead || behind) {
    die(`Local ${BRANCH} is not in sync (${ahead} ahead, ${behind} behind). Push or pull first.`);
  }

  const current = JSON.parse(readFileSync(PACKAGE, "utf8")).version;
  const next = nextVersion(current, bump);
  const tag = `v${next}`;
  if (git("tag", "--list", tag)) die(`Tag ${tag} already exists — pick another bump.`);

  say(`Next number: ${current} → ${next} (tag ${tag})`);

  if (!skipChecks) {
    say("Running lint, typecheck and tests before numbering…");
    sh("npm run lint");
    sh("npx tsc --noEmit");
    sh("npm test");
  }

  if (dryRun) {
    console.log("");
    say(`Dry run — would bump package.json + package-lock.json to ${next}.`);
    say(`commit "Release ${next}", tag ${tag}, push ${BRANCH} + ${tag}.`);
    console.log("");
    return;
  }

  say(`Bumping to ${next}…`);
  sh(`npm version ${bump} --no-git-tag-version`);
  const bumped = JSON.parse(readFileSync(PACKAGE, "utf8")).version;
  if (bumped !== next) die(`npm version produced ${bumped}, expected ${next}.`);

  git("add", "package.json", "package-lock.json");
  git(
    "commit",
    "-m",
    `Release ${next}`,
    "-m",
    "Numbered by scripts/cut-release.mjs — the matching tag drives the Release workflow.",
    "-m",
    "🤖 Generated with Codebuff\nCo-Authored-By: Codebuff <noreply@codebuff.com>",
  );
  git("tag", "-a", tag, "-m", `Stockfolio ${next}`);

  say(`Pushing ${BRANCH} and ${tag}…`);
  git("push", "origin", BRANCH);
  git("push", "origin", tag);

  console.log("");
  say(`Pushed ${tag}. The tag triggers the Release workflow.`);

  if (noWatch) {
    say(`Release: https://github.com/${REPO}/releases/tag/${tag}`);
    return;
  }
  await watchRuns(tag);
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
