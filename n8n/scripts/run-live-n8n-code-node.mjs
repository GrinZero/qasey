import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const usePatchedPreview = process.argv.includes('--patched');
const simulatedCreateIndex = process.argv.indexOf('--simulate-create-id');
const simulatedCreateId = simulatedCreateIndex >= 0 ? process.argv[simulatedCreateIndex + 1] : '';
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected one JSON input item on stdin');

let workflow = JSON.parse(
  execFileSync('n8n-cli', ['workflow', 'get', 'hcgRlma0buIb11S2', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
if (usePatchedPreview) {
  workflow = JSON.parse(
    execFileSync('node', ['scripts/patch-ms-create-hard-validation.mjs'], {
      input: JSON.stringify(workflow),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
}
const code = workflow.nodes.find((node) => node.name === 'Create Test Case')?.parameters?.jsCode;
if (!code) throw new Error('Live Create Test Case code was not found');

const helpers = {
  async httpRequest(options) {
    if (simulatedCreateId && options.method === 'POST' && options.url.endsWith('/track/test/case/add')) {
      return JSON.stringify({ success: true, data: { id: simulatedCreateId } });
    }
    const response = await fetch(options.url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${options.url}`);
    return options.json ? response.json() : response.text();
  },
};

const requireFromCodeNode = (name) => {
  if (name === 'crypto' || name === 'node:crypto') return crypto;
  throw new Error(`Unsupported Code-node dependency: ${name}`);
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('require', '$input', 'helpers', code);
const result = await execute(
  requireFromCodeNode,
  { first: () => ({ json: JSON.parse(input) }) },
  helpers,
);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
