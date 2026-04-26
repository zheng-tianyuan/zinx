import type {
  McpProvider,
  McpResource,
  McpServerRef,
  McpTool,
  McpToolCallResult,
} from '../core/types.js';

export type StaticMcpProviderConfig = {
  kind?: string;
  servers?: McpServerRef[];
  tools?: McpTool[];
  resources?: McpResource[];
  toolHandlers?: Record<string, (input: unknown) => Promise<unknown> | unknown>;
  resourceHandlers?: Record<string, () => Promise<unknown> | unknown>;
};

export class StaticMcpProvider implements McpProvider {
  readonly kind: string;
  private readonly servers: McpServerRef[];
  private readonly tools: McpTool[];
  private readonly resources: McpResource[];
  private readonly toolHandlers: Record<string, (input: unknown) => Promise<unknown> | unknown>;
  private readonly resourceHandlers: Record<string, () => Promise<unknown> | unknown>;

  constructor(config: StaticMcpProviderConfig = {}) {
    this.kind = config.kind || 'static-mcp';
    this.servers = config.servers || [];
    this.tools = config.tools || [];
    this.resources = config.resources || [];
    this.toolHandlers = config.toolHandlers || {};
    this.resourceHandlers = config.resourceHandlers || {};
  }

  async listServers(): Promise<McpServerRef[]> {
    return this.servers;
  }

  async listTools(args?: { serverId?: string }): Promise<McpTool[]> {
    if (!args?.serverId) return this.tools;
    return this.tools.filter(tool => tool.server?.id === args.serverId);
  }

  async listResources(args?: { serverId?: string }): Promise<McpResource[]> {
    if (!args?.serverId) return this.resources;
    return this.resources.filter(resource => resource.server?.id === args.serverId);
  }

  async callTool(args: {
    serverId?: string;
    toolName: string;
    input?: unknown;
  }): Promise<McpToolCallResult> {
    const handler = this.toolHandlers[args.toolName];
    if (!handler) {
      throw new Error(`No handler registered for MCP tool "${args.toolName}".`);
    }

    return {
      provider: this.kind,
      serverId: args.serverId,
      toolName: args.toolName,
      result: await handler(args.input),
    };
  }

  async readResource(args: {
    uri: string;
  }): Promise<unknown> {
    const handler = this.resourceHandlers[args.uri];
    if (!handler) {
      throw new Error(`No handler registered for MCP resource "${args.uri}".`);
    }
    return handler();
  }
}
