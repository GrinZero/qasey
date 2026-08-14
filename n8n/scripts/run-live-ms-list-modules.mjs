import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const usePatchedPreview = process.argv[2] === '--patched';
const requestArgument = usePatchedPreview ? process.argv[3] : process.argv[2];
const request = requestArgument ? JSON.parse(requestArgument) : {};
const workflowId = 'nyCcEVtOu96xBjnJ';
let workflow = JSON.parse(
  execFileSync('n8n-cli', ['workflow', 'get', workflowId, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
if (usePatchedPreview) {
  workflow = JSON.parse(
    execFileSync('node', ['scripts/patch-ms-list-modules-workflow.mjs'], {
      input: JSON.stringify(workflow),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    }),
  );
}

const signatureCode = workflow.nodes.find((node) => node.name === 'Generate Signature')?.parameters?.jsCode;
const formatCode = workflow.nodes.find((node) => node.name === 'Format Output')?.parameters?.jsCode;
if (!signatureCode || !formatCode) throw new Error('Live workflow Code nodes were not found');

const requireFromCodeNode = (name) => {
  if (name === 'crypto' || name === 'node:crypto') return crypto;
  throw new Error(`Unsupported Code-node dependency: ${name}`);
};
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const signatureResult = await new AsyncFunction('require', '$input', signatureCode)(
  requireFromCodeNode,
  { first: () => ({ json: request }) },
);
const signed = signatureResult[0].json;
const response = await fetch(`${signed.baseUrl}/track/case/node/list/${signed.projectId}`, {
  headers: signed.headers,
});
if (!response.ok) throw new Error(`HTTP ${response.status} from MeterSphere`);
const responseJson = await response.json();

const getNodeOutput = (name) => {
  if (name !== 'When Executed by Another Workflow') {
    throw new Error(`Unsupported node reference: ${name}`);
  }
  return { first: () => ({ json: request }) };
};
const result = await new AsyncFunction('$input', '$', formatCode)(
  { first: () => ({ json: responseJson }) },
  getNodeOutput,
);

const text = JSON.stringify(result[0].json);
process.stdout.write(`${JSON.stringify({
  output_bytes: Buffer.byteLength(text),
  result: result[0].json,
}, null, 2)}\n`);
