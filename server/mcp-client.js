const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { spawn } = require('child_process');
const path = require('path');

const DEBUG = process.env.DEBUG === 'true';
const debug = (message, data = null) => {
  if (DEBUG) {
    console.log(`[MCP CLIENT DEBUG] ${new Date().toISOString()} - ${message}`, data || '');
  }
};

class MCPClientManager {
  constructor() {
    this.clients = new Map();
    this.processes = new Map();
  }

  async startMCPServer(serverName, config) {
    debug(`Starting MCP server: ${serverName}`, config);
    
    const env = {
      ...process.env,
      MCP_SERVER_NAME: serverName,
      MYSQL_HOST: config.host,
      MYSQL_USER: config.user,
      MYSQL_PASS: config.password,
      MYSQL_DB: config.database,
      DEBUG: process.env.DEBUG
    };

    const serverPath = path.join(__dirname, '../mcp-server/mcp-mysql-server.js');
    
    debug(`MCP server path: ${serverPath}`);
    
    // Create MCP client first
    const client = new Client({
      name: `sql-chat-client-${serverName.toLowerCase()}`,
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    // Create transport with proper spawn configuration
    const transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath],
      env: env
    });

    try {
      debug(`Connecting MCP client to ${serverName}`);
      await client.connect(transport);
      debug(`MCP client connected to ${serverName}`);
      
      // Store the client
      this.clients.set(serverName, client);
      
      // Test the connection by listing tools
      const tools = await client.request('tools/list', {});
      debug(`Available tools for ${serverName}`, tools);
      
      return client;
    } catch (error) {
      console.error(`Failed to connect to MCP server ${serverName}:`, error);
      debug(`Failed to connect to MCP server ${serverName}`, error);
      throw error;
    }
  }

  async executeTool(serverName, toolName, args) {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`No MCP client found for server: ${serverName}`);
    }

    debug(`Executing tool ${toolName} on ${serverName}`, args);

    try {
      const result = await client.request('tools/call', {
        name: toolName,
        arguments: args
      });

      debug(`Tool execution result for ${toolName}`, {
        serverName,
        contentLength: result.content?.length || 0
      });

      return result;
    } catch (error) {
      debug(`Tool execution failed for ${toolName}`, {
        serverName,
        error: error.message
      });
      throw error;
    }
  }

  async initializeServers() {
    const servers = [];
    
    // Initialize Product DB MCP Server
    if (process.env.PRODUCT_DB_HOST && process.env.PRODUCT_DB_USER && 
        process.env.PRODUCT_DB_PASSWORD && process.env.PRODUCT_DB_DATABASE) {
      try {
        await this.startMCPServer('ProductDB', {
          host: process.env.PRODUCT_DB_HOST,
          user: process.env.PRODUCT_DB_USER,
          password: process.env.PRODUCT_DB_PASSWORD,
          database: process.env.PRODUCT_DB_DATABASE
        });
        servers.push('ProductDB');
        debug('ProductDB MCP server initialized');
      } catch (error) {
        console.error('Failed to initialize ProductDB MCP server:', error);
      }
    } else {
      console.warn('Product DB environment variables not set, skipping ProductDB MCP server');
    }

    // Initialize FAQ DB MCP Server
    if (process.env.FAQ_DB_HOST && process.env.FAQ_DB_USER && 
        process.env.FAQ_DB_PASSWORD && process.env.FAQ_DB_DATABASE) {
      try {
        await this.startMCPServer('FaqDB', {
          host: process.env.FAQ_DB_HOST,
          user: process.env.FAQ_DB_USER,
          password: process.env.FAQ_DB_PASSWORD,
          database: process.env.FAQ_DB_DATABASE
        });
        servers.push('FaqDB');
        debug('FaqDB MCP server initialized');
      } catch (error) {
        console.error('Failed to initialize FaqDB MCP server:', error);
      }
    } else {
      console.warn('FAQ DB environment variables not set, skipping FaqDB MCP server');
    }

    return servers;
  }

  async shutdown() {
    debug('Shutting down MCP clients and servers');
    
    // Close all clients
    for (const [serverName, client] of this.clients) {
      try {
        await client.close();
        debug(`Closed MCP client for ${serverName}`);
      } catch (error) {
        console.error(`Error closing MCP client for ${serverName}:`, error);
      }
    }

    this.clients.clear();
    this.processes.clear();
  }
}

module.exports = MCPClientManager;