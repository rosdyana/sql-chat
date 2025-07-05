import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import fs from 'fs';

const DEBUG = process.env.DEBUG === 'true';
const debug = (message: string, data: any = null) => {
  if (DEBUG) {
    console.log(`[UNIFIED MCP CLIENT DEBUG] ${new Date().toISOString()} - ${message}`, data || '');
  }
};

const logMcpStep = (step: string, data: any = null) => {
  console.log(`[MCP] ${new Date().toISOString()} - ${step}`, data ? JSON.stringify(data, null, 2) : '');
};

interface Tool {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface McpResultContent {
  type: string;
  text?: string;
}

export interface McpResult {
  content?: McpResultContent[];
}

class UnifiedMCPClientManager {
  private client: Client | null = null;
  private availableTools: Tool[] = [];

  constructor() {
    // Constructor logic
  }

  async initialize(): Promise<string[]> {
    logMcpStep('MCP_INITIALIZATION_START');

    const hasProductDB = process.env.PRODUCT_DB_HOST && process.env.PRODUCT_DB_USER &&
      process.env.PRODUCT_DB_PASSWORD && process.env.PRODUCT_DB_DATABASE;
    const hasFaqDB = process.env.FAQ_DB_HOST && process.env.FAQ_DB_USER &&
      process.env.FAQ_DB_PASSWORD && process.env.FAQ_DB_DATABASE;

    logMcpStep('MCP_DATABASE_CHECK', {
      hasProductDB,
      hasFaqDB,
      totalConfigured: (hasProductDB ? 1 : 0) + (hasFaqDB ? 1 : 0)
    });

    if (!hasProductDB && !hasFaqDB) {
      logMcpStep('MCP_NO_DATABASES_CONFIGURED');
      console.warn('No databases configured, skipping MCP server initialization');
      return [];
    }

    try {
      await this.startUnifiedMCPServer();
      await this.discoverTools();

      logMcpStep('MCP_INITIALIZATION_SUCCESS', {
        toolCount: this.availableTools.length,
        tools: this.availableTools.map(t => t.name)
      });

      return this.availableTools.map(t => t.name);
    } catch (error: any) {
      logMcpStep('MCP_INITIALIZATION_FAILED', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  private async startUnifiedMCPServer() {
    logMcpStep('MCP_SERVER_START_ATTEMPT');

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      DEBUG: process.env.DEBUG || 'false'
    };

    const serverDir = path.resolve(__dirname, '../../mcp-server');

    logMcpStep('MCP_SERVER_DIR_RESOLVED', {
      serverDir,
      pathExists: fs.existsSync(serverDir)
    });

    this.client = new Client({
      name: 'sql-chat-unified-client',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    logMcpStep('MCP_CLIENT_CREATED');

    const transport = new StdioClientTransport({
      command: 'npm',
      args: ['start'],
      env: env,
      cwd: serverDir
    });

    logMcpStep('MCP_TRANSPORT_CREATED');

    logMcpStep('MCP_CLIENT_CONNECTING');
    const startTime = Date.now();

    try {
      await this.client.connect(transport);
      const endTime = Date.now();

      logMcpStep('MCP_SERVER_CONNECTED', {
        connectionTimeMs: endTime - startTime
      });
    } catch (connectError: any) {
      logMcpStep('MCP_CLIENT_CONNECT_FAILED', {
        error: connectError.message,
        stack: connectError.stack
      });
      throw connectError;
    }
  }

  private async discoverTools() {
    logMcpStep('MCP_TOOL_DISCOVERY_START');

    if (!this.client) {
      throw new Error('MCP client not initialized');
    }

    try {
      const startTime = Date.now();
      const result = await this.client.listTools();
      const endTime = Date.now();

      this.availableTools = result.tools as Tool[] || [];

      logMcpStep('MCP_TOOL_DISCOVERY_SUCCESS', {
        discoveryTimeMs: endTime - startTime,
        toolCount: this.availableTools.length,
        tools: this.availableTools.map(t => ({
          name: t.name,
          description: t.description?.substring(0, 100) + '...' || ''
        }))
      });
    } catch (error: any) {
      logMcpStep('MCP_TOOL_DISCOVERY_FAILED', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async executeTool(toolName: string, args: any): Promise<McpResult> {
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }

    logMcpStep('MCP_TOOL_EXECUTION_START', {
      toolName,
      args: {
        query: args.query?.substring(0, 100) + (args.query?.length > 100 ? '...' : ''),
        queryLength: args.query?.length || 0
      }
    });

    const tool = this.availableTools.find(t => t.name === toolName);
    if (!tool) {
      logMcpStep('MCP_TOOL_NOT_FOUND', {
        toolName,
        availableTools: this.availableTools.map(t => t.name)
      });
      throw new Error(`Unknown tool: ${toolName}`);
    }

    try {
      const startTime = Date.now();

      logMcpStep('MCP_TOOL_CALL_START', {
        toolName,
        requestPayload: {
          name: toolName,
          arguments: args
        }
      });

      const result = await this.client.callTool({
        name: toolName,
        arguments: args
      }) as McpResult;

      const endTime = Date.now();

      logMcpStep('MCP_TOOL_EXECUTION_SUCCESS', {
        toolName,
        executionTimeMs: endTime - startTime,
        hasContent: !!(result.content && result.content.length > 0),
        contentLength: result.content?.[0]?.text?.length || 0,
        contentPreview: result.content?.[0]?.text?.substring(0, 200) + '...' || 'No content'
      });

      return result;
    } catch (error: any) {
      logMcpStep('MCP_TOOL_EXECUTION_FAILED', {
        toolName,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async fetchDatabaseSchema(dbKey: string): Promise<any> {
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }

    logMcpStep('FETCH_SCHEMA_START', { dbKey });

    try {
      const result = await this.client.callTool({
        name: 'get_database_schema',
        arguments: { dbKey }
      }) as McpResult;

      if (result.content && result.content.length > 0 && result.content[0].text) {
        const parsedContent = JSON.parse(result.content[0].text);
        if (parsedContent.success) {
          logMcpStep('FETCH_SCHEMA_SUCCESS', { dbKey, tableCount: Object.keys(parsedContent.schema).length });
          return parsedContent.schema;
        } else {
          logMcpStep('FETCH_SCHEMA_ERROR_RESPONSE', { dbKey, error: parsedContent.error });
          throw new Error(`Failed to fetch schema for ${dbKey}: ${parsedContent.error}`);
        }
      } else {
        logMcpStep('FETCH_SCHEMA_EMPTY_RESPONSE', { dbKey });
        throw new Error(`Empty response when fetching schema for ${dbKey}`);
      }
    } catch (error: any) {
      logMcpStep('FETCH_SCHEMA_FAILED', { dbKey, error: error.message, stack: error.stack });
      throw error;
    }
  }

  async shutdown() {
    logMcpStep('MCP_SHUTDOWN_START');

    if (this.client) {
      try {
        await this.client.close();
        logMcpStep('MCP_SHUTDOWN_SUCCESS');
      } catch (error: any) {
        logMcpStep('MCP_SHUTDOWN_ERROR', {
          error: error.message
        });
      }
      this.client = null;
    }

    this.availableTools = [];
  }
}

export default UnifiedMCPClientManager;
