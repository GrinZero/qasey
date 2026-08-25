#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const TARGETS = {
  local: {
    baseUrl: "http://localhost:4111",
    tokenVariable: "QASEY_DEV_AUTH_TOKEN",
  },
  t2: {
    baseUrl: "https://qasey.t2.moego.dev",
    tokenVariable: "QASEY_DEBUG_TOKEN",
  },
};

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const usage = `Usage:
  studio-api.mjs <local|t2> <METHOD> <path> [options]

The path is relative to /studio/api and must begin with a slash.

Options:
  --query <json-object>  Add query parameters
  --body-file <path>     Read a JSON request body from a file
  --body-stdin           Read a JSON request body from stdin
  --timeout-ms <ms>      Request timeout in milliseconds (default: 30000)
  -h, --help             Show this help

Examples:
  studio-api.mjs t2 GET /agents
  studio-api.mjs t2 GET /observability/traces/light --query '{"page":0,"perPage":10}'
  studio-api.mjs local POST /agents/qasey-main/generate --body-file /tmp/request.json`;

function fail(message, exitCode = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function requiredOption(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} requires a value.\n\n${usage}`, 2);
  return value;
}

function parseOptions(args) {
  const options = { timeoutMs: 30_000 };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case "--query":
        options.query = requiredOption(args, index, argument);
        index += 1;
        break;
      case "--body-file":
        options.bodyFile = requiredOption(args, index, argument);
        index += 1;
        break;
      case "--body-stdin":
        options.bodyStdin = true;
        break;
      case "--timeout-ms": {
        const value = requiredOption(args, index, argument);
        if (!/^\d+$/u.test(value) || Number(value) <= 0) fail("--timeout-ms must be a positive integer.", 2);
        options.timeoutMs = Number(value);
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        fail(usage, 0);
        break;
      default:
        fail(`Unknown option: ${argument}.\n\n${usage}`, 2);
    }
  }
  if (options.bodyFile && options.bodyStdin) {
    fail("Use only one of --body-file and --body-stdin.", 2);
  }
  return options;
}

function missingToken(target, variable) {
  if (target === "t2") {
    return `${variable} is missing. Open https://qasey.t2.moego.dev/admin, create an API Token with the scopes required by the intended Mastra calls, and save its one-time value as ${variable} in .env.local.`;
  }
  return `${variable} is missing. Add a random value of at least 32 characters to the Git-ignored .env.local, then run the local server with NODE_ENV=development.`;
}

function normalizePath(rawPath) {
  if (!rawPath?.startsWith("/")) fail("path must begin with a slash.", 2);
  if (rawPath === "/studio/api" || rawPath.startsWith("/studio/api/")) {
    fail("path is relative to /studio/api; omit the /studio/api prefix.", 2);
  }
  if (rawPath.includes("?") || rawPath.includes("#") || rawPath.includes("\\")) {
    fail("path cannot contain a query string, fragment, or backslash; use --query for query parameters.", 2);
  }
  for (const rawSegment of rawPath.split("/")) {
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      fail("path contains malformed percent encoding.", 2);
    }
    if (segment === "." || segment === "..") fail("path traversal segments are not allowed.", 2);
  }
  return rawPath;
}

function parseJsonObject(raw, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} must be valid JSON.`, 2);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    fail(`${label} must be a JSON object.`, 2);
  }
  return value;
}

function scalar(value, key) {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  fail(`Query field ${key} must contain a scalar or an array of scalars.`, 2);
}

function appendQuery(url, rawQuery) {
  if (!rawQuery) return;
  const query = parseJsonObject(rawQuery, "--query");
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, scalar(item, key));
    } else {
      url.searchParams.set(key, scalar(value, key));
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function requestBody(options, method) {
  if (!options.bodyFile && !options.bodyStdin) return undefined;
  if (method === "GET" || method === "HEAD") fail(`${method} requests cannot include a body.`, 2);

  let raw;
  try {
    raw = options.bodyFile ? await readFile(options.bodyFile, "utf8") : await readStdin();
  } catch (error) {
    fail(`Unable to read request body: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (!raw.trim()) fail("Request body is empty.", 2);

  try {
    JSON.parse(raw);
  } catch {
    fail("Request body must be valid JSON.", 2);
  }
  return raw;
}

const argv = process.argv.slice(2);
if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) fail(usage, 0);

const [targetName, rawMethod, rawPath, ...optionArgs] = argv;
const target = TARGETS[targetName];
if (!target) fail(`Unknown target: ${targetName ?? "(missing)"}.\n\n${usage}`, 2);

const method = rawMethod?.toUpperCase();
if (!method || !METHODS.has(method)) fail(`Unsupported method: ${rawMethod ?? "(missing)"}.\n\n${usage}`, 2);

const path = normalizePath(rawPath);
const options = parseOptions(optionArgs);
const token = process.env[target.tokenVariable]?.trim();
if (!token) fail(missingToken(targetName, target.tokenVariable), 3);

const url = new URL(`/studio/api${path}`, target.baseUrl);
appendQuery(url, options.query);
const body = await requestBody(options, method);

let response;
try {
  response = await fetch(url, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
} catch (error) {
  fail(`Request to ${targetName} failed: ${error instanceof Error ? error.message : String(error)}`);
}

const responseBody = method === "HEAD" ? "" : await response.text();
if (!response.ok) {
  process.stderr.write(`Mastra API returned HTTP ${response.status} for ${method} ${path} on ${targetName}.\n`);
  if (responseBody) process.stderr.write(`${responseBody}\n`);
  process.exit(4);
}

if (!responseBody) process.exit(0);
try {
  process.stdout.write(`${JSON.stringify(JSON.parse(responseBody), null, 2)}\n`);
} catch {
  process.stdout.write(responseBody.endsWith("\n") ? responseBody : `${responseBody}\n`);
}
