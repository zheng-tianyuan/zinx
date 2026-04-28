import type {
  CliBinding,
  CollaborationCapability,
  CollaborationProvider,
  CollaborationResource,
  McpProvider,
  McpResource,
  McpServerRef,
  McpTool,
} from './types.js';

export async function buildCollaborationSummary(provider: CollaborationProvider): Promise<{
  provider: string;
  ok: boolean;
  message?: string;
  capabilities: CollaborationCapability[];
}> {
  const [health, capabilities] = await Promise.all([
    provider.health(),
    provider.listCapabilities(),
  ]);
  return {
    provider: provider.kind,
    ok: health.ok,
    message: health.message,
    capabilities,
  };
}

export function cliBindingToMcpServer(binding: CliBinding): McpServerRef {
  return {
    id: binding.id,
    name: binding.id,
    transport: 'stdio',
    command: binding.command,
    args: binding.args,
    env: binding.env,
    metadata: {
      ...binding.metadata,
      cwd: binding.cwd,
    },
  };
}

export class CollaborationMcpProvider implements McpProvider {
  readonly kind: string;

  constructor(private readonly config: {
    kind?: string;
    binding: CliBinding;
    tools?: McpTool[];
    resources?: McpResource[];
  }) {
    this.kind = config.kind || 'collaboration-mcp';
  }

  async listServers(): Promise<McpServerRef[]> {
    return [cliBindingToMcpServer(this.config.binding)];
  }

  async listTools(): Promise<McpTool[]> {
    const server = cliBindingToMcpServer(this.config.binding);
    return (this.config.tools || []).map(tool => ({
      ...tool,
      server: tool.server || server,
    }));
  }

  async listResources(): Promise<McpResource[]> {
    const server = cliBindingToMcpServer(this.config.binding);
    return (this.config.resources || []).map(resource => ({
      ...resource,
      server: resource.server || server,
    }));
  }
}

export async function resolveCollaborationResource(args: {
  provider: CollaborationProvider;
  urlOrId: string;
  metadata?: Record<string, unknown>;
}): Promise<CollaborationResource | null> {
  if (!args.provider.resolveResource) return null;
  return args.provider.resolveResource({
    urlOrId: args.urlOrId,
    metadata: args.metadata,
  });
}
