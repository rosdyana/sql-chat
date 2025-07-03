#!/usr/bin/env node
require('dotenv').config();
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const mysql = require('mysql2/promise');

const DEBUG = process.env.DEBUG === 'true';
const debug = (message, data = null) => {
  if (DEBUG) {
    console.error(`[UNIFIED MCP DEBUG] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data) : '');
  }
};

const logServerStep = (step, data = null) => {
  console.error(`[MCP-SERVER] ${new Date().toISOString()} - ${step}`, data ? JSON.stringify(data, null, 2) : '');
};

class UnifiedMySQLMCPServer {
  constructor() {
    logServerStep('SERVER_CONSTRUCTOR_START');

    this.server = new Server({
      name: 'unified-mysql-mcp-server',
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {},
      },
    });

    logServerStep('SERVER_INSTANCE_CREATED');

    this.databases = new Map();
    this.setupDatabases();
    this.setupHandlers();

    logServerStep('SERVER_CONSTRUCTOR_COMPLETE', {
      databaseCount: this.databases.size
    });
  }

  setupDatabases() {
    // Setup Product Database
    if (process.env.PRODUCT_DB_HOST && process.env.PRODUCT_DB_USER &&
      process.env.PRODUCT_DB_PASSWORD && process.env.PRODUCT_DB_DATABASE) {

      const productPool = mysql.createPool({
        host: process.env.PRODUCT_DB_HOST,
        user: process.env.PRODUCT_DB_USER,
        password: process.env.PRODUCT_DB_PASSWORD,
        database: process.env.PRODUCT_DB_DATABASE,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0
      });

      this.databases.set('product', {
        name: 'ProductDB',
        pool: productPool,
        config: {
          host: process.env.PRODUCT_DB_HOST,
          database: process.env.PRODUCT_DB_DATABASE
        }
      });

      debug('Product database configured', {
        host: process.env.PRODUCT_DB_HOST,
        database: process.env.PRODUCT_DB_DATABASE
      });
    }

    // Setup FAQ Database  
    if (process.env.FAQ_DB_HOST && process.env.FAQ_DB_USER &&
      process.env.FAQ_DB_PASSWORD && process.env.FAQ_DB_DATABASE) {

      const faqPool = mysql.createPool({
        host: process.env.FAQ_DB_HOST,
        user: process.env.FAQ_DB_USER,
        password: process.env.FAQ_DB_PASSWORD,
        database: process.env.FAQ_DB_DATABASE,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0
      });

      this.databases.set('faq', {
        name: 'FaqDB',
        pool: faqPool,
        config: {
          host: process.env.FAQ_DB_HOST,
          database: process.env.FAQ_DB_DATABASE
        }
      });

      debug('FAQ database configured', {
        host: process.env.FAQ_DB_HOST,
        database: process.env.FAQ_DB_DATABASE
      });
    }

    debug(`Total databases configured: ${this.databases.size}`, {
      databases: Array.from(this.databases.keys())
    });
  }

  setupHandlers() {
    // Handle tool list requests
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      debug('Tools list requested');

      const tools = [];

      // Create tools for each configured database
      for (const [key, db] of this.databases) {
        tools.push({
          name: `query_${key}_database`,
          description: `Query the ${db.name} database to retrieve information`,
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
        });
      }

      debug('Returning tools', { toolCount: tools.length, toolNames: tools.map(t => t.name) });

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      logServerStep('TOOL_CALL_RECEIVED', {
        toolName: name,
        arguments: args,
        timestamp: new Date().toISOString()
      });

      // Parse tool name to extract database key
      const match = name.match(/^query_(\w+)_database$/);
      if (!match) {
        logServerStep('INVALID_TOOL_NAME', { toolName: name });
        throw new Error(`Invalid tool name format: ${name}`);
      }

      const dbKey = match[1];
      const database = this.databases.get(dbKey);

      if (!database) {
        logServerStep('DATABASE_NOT_FOUND', {
          dbKey,
          availableDatabases: Array.from(this.databases.keys())
        });
        throw new Error(`Database not configured: ${dbKey}`);
      }

      const { query } = args;

      if (!query) {
        logServerStep('MISSING_QUERY', { toolName: name });
        throw new Error('Query is required');
      }

      // Basic SQL injection protection - only allow SELECT statements
      const trimmedQuery = query.trim().toUpperCase();
      if (!trimmedQuery.startsWith('SELECT')) {
        logServerStep('INVALID_QUERY_TYPE', {
          toolName: name,
          queryStart: trimmedQuery.substring(0, 20)
        });
        throw new Error('Only SELECT queries are allowed');
      }

      try {
        logServerStep('DATABASE_QUERY_START', {
          database: dbKey,
          databaseName: database.name,
          query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
          queryLength: query.length
        });

        const queryStartTime = Date.now();
        const [rows] = await database.pool.execute(query);
        const queryEndTime = Date.now();

        logServerStep('DATABASE_QUERY_SUCCESS', {
          database: dbKey,
          databaseName: database.name,
          rowCount: rows.length,
          executionTimeMs: queryEndTime - queryStartTime,
          dataSize: JSON.stringify(rows).length
        });

        const response = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                data: rows,
                rowCount: rows.length,
                database: database.name,
                databaseKey: dbKey
              }, null, 2)
            }
          ]
        };

        logServerStep('TOOL_CALL_SUCCESS', {
          toolName: name,
          responseSize: response.content[0].text.length
        });

        return response;
      } catch (error) {
        logServerStep('DATABASE_QUERY_ERROR', {
          database: dbKey,
          databaseName: database.name,
          error: error.message,
          query: query.substring(0, 100) + (query.length > 100 ? '...' : ''),
          errorCode: error.code,
          sqlState: error.sqlState
        });

        const errorResponse = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: error.message,
                database: database.name,
                databaseKey: dbKey
              }, null, 2)
            }
          ]
        };

        logServerStep('TOOL_CALL_ERROR', {
          toolName: name,
          errorMessage: error.message
        });

        return errorResponse;
      }
    });
  }

  async start() {
    logServerStep('SERVER_START_ATTEMPT');

    try {
      const transport = new StdioServerTransport();

      logServerStep('TRANSPORT_CREATED');

      const startTime = Date.now();
      await this.server.connect(transport);
      const endTime = Date.now();

      logServerStep('SERVER_STARTED_SUCCESS', {
        databaseCount: this.databases.size,
        databases: Array.from(this.databases.keys()),
        startupTimeMs: endTime - startTime
      });
    } catch (error) {
      logServerStep('SERVER_START_FAILED', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async stop() {
    debug('Shutting down unified MCP server');

    // Close all database connections
    for (const [key, database] of this.databases) {
      try {
        await database.pool.end();
        debug(`Closed database connection: ${key}`);
      } catch (error) {
        console.error(`Error closing database ${key}:`, error);
      }
    }

    debug('Unified MCP Server stopped');
  }
}

// Main execution
async function main() {
  debug('Starting Unified MySQL MCP Server');

  const server = new UnifiedMySQLMCPServer();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.error('Shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error('Shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  // Start the server
  try {
    await server.start();
    debug('Unified MCP server started successfully');
  } catch (error) {
    console.error('Failed to start unified MCP server:', error);
    process.exit(1);
  }
}

// Run the main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});