import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected one JSON input item on stdin');

const workflow = JSON.parse(
  execFileSync('n8n-cli', ['workflow', 'get', 'CFbiABrf7fX0t2nm', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const code = workflow.nodes.find(
  (node) => node.name === 'Upsert Module' || node.name === 'Create Module',
)?.parameters?.jsCode;
if (!code) throw new Error('Live module upsert code was not found');

const helpers = {
  async httpRequest(options) {
    const headers = options.headers ?? {};
    const body = options.body == null
      ? undefined
      : typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body);
    const response = await fetch(options.url, {
      method: options.method || 'GET',
      headers,
      body,
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
