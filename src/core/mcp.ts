import type {
  McpManifest,
  McpProvider,
  McpResource,
  McpServerRef,
  McpTool,
} from './types.js';

export async function buildMcpManifest(args: {
  provider: McpProvider;
  serverId?: string;
  metadata?: Record<string, unknown>;
}): Promise<McpManifest> {
  const [servers, tools, resources] = await Promise.all([
    args.provider.listServers({ metadata: args.metadata }),
    args.provider.listTools({ serverId: args.serverId, metadata: args.metadata }),
    args.provider.listResources({ serverId: args.serverId, metadata: args.metadata }),
  ]);

  return {
    provider: args.provider.kind,
    servers,
    tools,
    resources,
  };
}

export function renderMcpManifestForPrompt(manifest: McpManifest): string {
  const tools = manifest.tools.map((tool) => [
    `- ${tool.name}`,
    tool.description ? `  description: ${tool.description}` : '',
    tool.server?.id ? `  server: ${tool.server.id}` : '',
    tool.inputSchema ? `  inputSchema: ${JSON.stringify(tool.inputSchema)}` : '',
  ].filter(Boolean).join('\n'));

  const resources = manifest.resources.map((resource) => [
    `- ${resource.uri}`,
    resource.name ? `  name: ${resource.name}` : '',
    resource.description ? `  description: ${resource.description}` : '',
    resource.server?.id ? `  server: ${resource.server.id}` : '',
  ].filter(Boolean).join('\n'));

  return [
    `MCP provider: ${manifest.provider}`,
    manifest.servers.length ? `Servers:\n${manifest.servers.map(formatServer).join('\n')}` : '',
    tools.length ? `Tools:\n${tools.join('\n')}` : '',
    resources.length ? `Resources:\n${resources.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function formatServer(server: McpServerRef): string {
  return [
    `- ${server.id}`,
    server.name ? `  name: ${server.name}` : '',
    server.transport ? `  transport: ${server.transport}` : '',
  ].filter(Boolean).join('\n');
}

export function filterMcpTools(args: {
  tools: McpTool[];
  names?: string[];
  serverIds?: string[];
}): McpTool[] {
  const names = args.names ? new Set(args.names) : null;
  const serverIds = args.serverIds ? new Set(args.serverIds) : null;
  return args.tools.filter((tool) => {
    if (names && !names.has(tool.name)) return false;
    if (serverIds && (!tool.server?.id || !serverIds.has(tool.server.id))) return false;
    return true;
  });
}

export function filterMcpResources(args: {
  resources: McpResource[];
  serverIds?: string[];
  uriPrefixes?: string[];
}): McpResource[] {
  const serverIds = args.serverIds ? new Set(args.serverIds) : null;
  return args.resources.filter((resource) => {
    if (serverIds && (!resource.server?.id || !serverIds.has(resource.server.id))) return false;
    if (args.uriPrefixes && !args.uriPrefixes.some(prefix => resource.uri.startsWith(prefix))) return false;
    return true;
  });
}
