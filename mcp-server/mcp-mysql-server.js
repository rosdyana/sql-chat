#!/usr/bin/env node
require('dotenv').config();
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const mysql = require('mysql2/promise');

const DEBUG = process.env.DEBUG === 'true';
const debug = (message, data = null) => {
  if (DEBUG) {
    console.error(`[MCP DEBUG] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data) : '');
  }
};

class MySQLMCPServer {
  constructor(name, host, user, password, database) {
    this.name = name;
    this.server = new Server({
      name: `mysql-mcp-${name.toLowerCase()}`,
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {},
      },
    });
    
    this.pool = mysql.createPool({
      host: host,
      user: user,
      password: password,
      database: database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    debug(`Created MCP MySQL server for ${name}`, {
      host,
      user,
      database
    });

    this.setupHandlers();
  }

  setupHandlers() {
    // Handle tool list requests
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      debug(`Tools list requested for ${this.name}`);
      return {
        tools: [
          {
            name: `query_${this.name.toLowerCase()}_database`,
            description: `Query the ${this.name} database to retrieve information`,
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'A detailed and correct SQL SELECT query to execute',
                },
              },
              required: ['query'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      debug(`Tool call received for ${this.name}`, {
        toolName: name,
        arguments: args
      });

      if (name !== `query_${this.name.toLowerCase()}_database`) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const { query } = args;
      
      if (!query) {
        throw new Error('Query is required');
      }

      // Basic SQL injection protection - only allow SELECT statements
      const trimmedQuery = query.trim().toUpperCase();
      if (!trimmedQuery.startsWith('SELECT')) {
        throw new Error('Only SELECT queries are allowed');
      }

      try {
        const [rows] = await this.pool.execute(query);
        
        debug(`Query executed successfully for ${this.name}`, {
          rowCount: rows.length,
          query: query.substring(0, 100) + '...'
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                data: rows,
                rowCount: rows.length,
                database: this.name
              }, null, 2)
            }
          ]
        };
      } catch (error) {
        debug(`Query execution failed for ${this.name}`, {
          error: error.message,
          query: query.substring(0, 100) + '...'
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error.message,
                database: this.name
              }, null, 2)
            }
          ]
        };
      }
    });
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    debug(`MCP Server started for ${this.name}`);
  }

  async stop() {
    await this.pool.end();
    debug(`MCP Server stopped for ${this.name}`);
  }
}

// Main execution
async function main() {
  // Determine which database to serve based on environment variables
  const serverName = process.env.MCP_SERVER_NAME || 'ProductDB';
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASS;
  const database = process.env.MYSQL_DB;

  if (!host || !user || !password || !database) {
    console.error('Missing required environment variables: MYSQL_HOST, MYSQL_USER, MYSQL_PASS, MYSQL_DB');
    process.exit(1);
  }

  debug(`Starting MCP server`, {
    serverName,
    host,
    user,
    database
  });

  const server = new MySQLMCPServer(serverName, host, user, password, database);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.error(`[${serverName}] Shutting down gracefully...`);
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error(`[${serverName}] Shutting down gracefully...`);
    await server.stop();
    process.exit(0);
  });

  // Start the server
  try {
    await server.start();
    debug(`MCP server ${serverName} started successfully`);
  } catch (error) {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});