import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.trim()) throw new Error('Expected Trigger workflow JSON on stdin');

const workflow = JSON.parse(input);
const sourceWorkflow = JSON.parse(
  execFileSync('n8n-cli', ['workflow', 'get', 'WlCDNfYSJYbq0fRotMxix', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);

const sourceNode = sourceWorkflow.nodes.find((node) => node.name === 'ms_list_modules');
const agent = workflow.nodes.find((node) => node.name === 'AI Agent');
if (!sourceNode || !agent) throw new Error('Source module tool or target AI Agent was not found');

let targetNode = workflow.nodes.find((node) => node.name === 'ms_list_modules');
if (targetNode) {
  targetNode.parameters = structuredClone(sourceNode.parameters);
  targetNode.type = sourceNode.type;
  targetNode.typeVersion = sourceNode.typeVersion;
} else {
  const createTool = workflow.nodes.find((node) => node.name === 'ms_create_test_case');
  const position = Array.isArray(createTool?.position)
    ? [createTool.position[0], createTool.position[1] + 176]
    : [1600, 496];
  targetNode = {
    parameters: structuredClone(sourceNode.parameters),
    type: sourceNode.type,
    typeVersion: sourceNode.typeVersion,
    position,
    id: crypto.randomUUID(),
    name: 'ms_list_modules',
  };
  workflow.nodes.push(targetNode);
}

workflow.connections.ms_list_modules = {
  ai_tool: [[{ node: agent.name, type: 'ai_tool', index: 0 }]],
};

process.stdout.write(JSON.stringify(workflow));
