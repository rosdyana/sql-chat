const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

const DEBUG = process.env.DEBUG === 'true';
const debug = (message, data = null) => {
  if (DEBUG) {
    console.log(`[UNIFIED MCP CLIENT DEBUG] ${new Date().toISOString()} - ${message}`, data || '');
  }
};

const logMcpStep = (step, data = null) => {
  console.log(`[MCP] ${new Date().toISOString()} - ${step}`, data ? JSON.stringify(data, null, 2) : '');
};

class UnifiedMCPClientManager {
  constructor() {
    this.client = null;
    this.availableTools = [];
  }

  async initialize() {
    logMcpStep('MCP_INITIALIZATION_START');
    
    // Check if we have at least one database configured
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
    } catch (error) {
      logMcpStep('MCP_INITIALIZATION_FAILED', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async startUnifiedMCPServer() {
    logMcpStep('MCP_SERVER_START_ATTEMPT');
    
    const env = {
      ...process.env,
      DEBUG: process.env.DEBUG
    };

    const serverPath = path.join(__dirname, '../mcp-server/unified-mysql-server.js');
    
    logMcpStep('MCP_SERVER_PATH_RESOLVED', {
      serverPath,
      pathExists: require('fs').existsSync(serverPath),
      currentDir: __dirname
    });
    
    // Create MCP client
    logMcpStep('MCP_CLIENT_CREATING');
    this.client = new Client({
      name: 'sql-chat-unified-client',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    logMcpStep('MCP_CLIENT_CREATED');

    // Create transport with proper spawn configuration
    logMcpStep('MCP_TRANSPORT_CREATING');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: env
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
    } catch (connectError) {
      logMcpStep('MCP_CLIENT_CONNECT_FAILED', {
        error: connectError.message,
        stack: connectError.stack
      });
      throw connectError;
    }
  }

  async discoverTools() {
    logMcpStep('MCP_TOOL_DISCOVERY_START');
    
    if (!this.client) {
      throw new Error('MCP client not initialized');
    }

    try {
      const startTime = Date.now();
      const result = await this.client.request('tools/list', {});
      const endTime = Date.now();
      
      this.availableTools = result.tools || [];
      
      logMcpStep('MCP_TOOL_DISCOVERY_SUCCESS', {
        discoveryTimeMs: endTime - startTime,
        toolCount: this.availableTools.length,
        tools: this.availableTools.map(t => ({ 
          name: t.name, 
          description: t.description.substring(0, 100) + '...' 
        }))
      });
    } catch (error) {
      logMcpStep('MCP_TOOL_DISCOVERY_FAILED', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async executeTool(toolName, args) {
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

    // Verify tool exists
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
      
      const result = await this.client.request('tools/call', {
        name: toolName,
        arguments: args
      });
      
      const endTime = Date.now();

      logMcpStep('MCP_TOOL_EXECUTION_SUCCESS', {
        toolName,
        executionTimeMs: endTime - startTime,
        hasContent: !!(result.content && result.content.length > 0),
        contentLength: result.content?.length || 0,
        contentPreview: result.content?.[0]?.text?.substring(0, 200) + '...' || 'No content'
      });

      return result;
    } catch (error) {
      logMcpStep('MCP_TOOL_EXECUTION_FAILED', {
        toolName,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async shutdown() {
    logMcpStep('MCP_SHUTDOWN_START');
    
    if (this.client) {
      try {
        await this.client.close();
        logMcpStep('MCP_SHUTDOWN_SUCCESS');
      } catch (error) {
        logMcpStep('MCP_SHUTDOWN_ERROR', {
          error: error.message
        });
      }
      this.client = null;
    }
    
    this.availableTools = [];
  }
}

module.exports = UnifiedMCPClientManager;