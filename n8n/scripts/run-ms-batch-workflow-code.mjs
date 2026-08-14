import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';

const workflowName = process.argv[2];
const definitions = {
  batch_edit: {
    file: 'n8n-workflows/metersphere/ms_batch_edit_test_cases.json',
    node: 'Batch Edit Test Cases',
  },
  bulk_upsert: {
    file: 'n8n-workflows/metersphere/ms_bulk_upsert_test_cases.json',
    node: 'Bulk Upsert Test Cases',
  },
};
const definition = definitions[workflowName];
if (!definition) throw new Error('Usage: node scripts/run-ms-batch-workflow-code.mjs <batch_edit|bulk_upsert>');

let rawInput = '';
for await (const chunk of process.stdin) rawInput += chunk;
if (!rawInput.trim()) throw new Error('Expected one JSON input object on stdin');
const input = JSON.parse(rawInput);
if (input.dry_run !== true && !process.argv.includes('--allow-write')) {
  throw new Error('Live writes are disabled. Pass dry_run=true or explicitly add --allow-write.');
}

const workflow = JSON.parse(fs.readFileSync(definition.file, 'utf8'));
const code = workflow.nodes.find((node) => node.name === definition.node)?.parameters?.jsCode;
if (!code) throw new Error('Code node was not found: ' + definition.node);

const helpers = {
  async httpRequest(options) {
    const response = await fetch(options.url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + options.url + ': ' + text.slice(0, 500));
    if (!options.json) return text;
    return text ? JSON.parse(text) : undefined;
  },
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = new AsyncFunction('require', '$input', 'helpers', code);
const result = await execute(
  (name) => {
    if (name === 'crypto' || name === 'node:crypto') return crypto;
    throw new Error('Unsupported Code-node dependency: ' + name);
  },
  { first: () => ({ json: input }) },
  helpers,
);

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
