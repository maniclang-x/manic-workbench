#!/usr/bin/env node
/**
 * Publish @maniclang/workbench to npm.
 *
 * Usage:
 *   npm run release -- --otp=XXXXXX
 *   NPM_OTP=XXXXXX npm run release
 *
 * Bump first when the current version is already published:
 *   npm version patch   # or minor / major
 *   npm run release -- --otp=XXXXXX
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const name = manifest.name;
const version = manifest.version;
const otp = readOtp(process.argv.slice(2));

console.log(`Publishing ${name}@${version}`);

if (await versionAlreadyPublished(name, version)) {
  fail(
    `${name}@${version} is already on npm.\n` +
      `Bump first, then re-run:\n` +
      `  npm version patch\n` +
      `  npm run release -- --otp=XXXXXX`,
  );
}

if (!otp) {
  fail(
    "npm requires a one-time password (2FA).\n" +
      "Re-run with:\n" +
      "  npm run release -- --otp=XXXXXX\n" +
      "or:\n" +
      "  NPM_OTP=XXXXXX npm run release",
  );
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["run", "build"]);
run("npm", ["run", "pack:check"]);
run("npm", ["publish", "--access", "public", `--otp=${otp}`]);

const published = capture("npm", ["view", `${name}@${version}`, "version"]).trim();
if (published !== version) {
  fail(`Publish finished but npm view returned "${published || "(empty)"}".`);
}

console.log(`\nPublished ${name}@${version}`);
console.log(`Verify: npx -y ${name}@${version} --version`);
console.log(`Page:   https://www.npmjs.com/package/${name}`);

function readOtp(args) {
  for (const arg of args) {
    if (arg.startsWith("--otp=")) return arg.slice("--otp=".length).trim();
    if (arg === "--otp") {
      fail("Pass OTP as --otp=XXXXXX (single argument).");
    }
  }
  return (process.env.NPM_OTP || "").trim();
}

async function versionAlreadyPublished(packageName, packageVersion) {
  const result = spawnSync(
    "npm",
    ["view", `${packageName}@${packageVersion}`, "version", "--json"],
    { encoding: "utf8", cwd: root },
  );
  if (result.status === 0) {
    try {
      const value = JSON.parse(result.stdout || "null");
      return value === packageVersion;
    } catch {
      return result.stdout.trim() === packageVersion;
    }
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (combined.includes("E404") || combined.includes("404 Not Found")) return false;
  // Network / auth surprises should not look like "safe to publish".
  fail(`Could not check whether ${packageName}@${packageVersion} exists:\n${combined.trim()}`);
}

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}
