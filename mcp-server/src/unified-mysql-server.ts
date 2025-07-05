#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import mysql from 'mysql2/promise';
import { z } from 'zod';

const DEBUG = process.env.DEBUG === 'true';

const debug = (message: string, data?: any) => {
  if (DEBUG) {
    console.error(`[UNIFIED MCP DEBUG] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data) : '');
  }
};

const logServerStep = (step: string, data?: any) => {
  console.error(`[MCP-SERVER] ${new Date().toISOString()} - ${step}`, data ? JSON.stringify(data, null, 2) : '');
};

interface Database {
  name: string;
  pool: mysql.Pool;
  config: {
    host?: string;
    database?: string;
  };
}

class UnifiedMySQLMCPServer {
  private server: McpServer;
  private databases = new Map<string, Database>();

  constructor() {
    logServerStep('SERVER_CONSTRUCTOR_START');

    this.server = new McpServer({
      name: 'unified-mysql-mcp-server',
      version: '1.0.0',
      capabilities: {
        tools: {},
      },
    });

    logServerStep('SERVER_INSTANCE_CREATED');

    this.setupDatabases();
    this.setupHandlers();

    logServerStep('SERVER_CONSTRUCTOR_COMPLETE', {
      databaseCount: this.databases.size
    });
  }

  private setupDatabases() {
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

  private setupHandlers() {
    for (const [key, db] of this.databases) {
      const toolName = `query_${key}_database`;

      this.server.registerTool(toolName, {
        description: `Query the ${db.name} database to retrieve information`,
        inputSchema: {
          query: z.string(),
        },
      }, async (args: { query: string }) => {
        const { query } = args;
        logServerStep('TOOL_CALL_RECEIVED', { toolName, query });

        if (!query) {
          logServerStep('MISSING_QUERY', { toolName });
          throw new Error('Query is required');
        }

        const trimmedQuery = query.trim().toUpperCase();
        if (!trimmedQuery.startsWith('SELECT')) {
          logServerStep('INVALID_QUERY_TYPE', { toolName, query });
          throw new Error('Only SELECT queries are allowed');
        }

        try {
          logServerStep('DATABASE_QUERY_START', { database: key, query });
          const [rows] = await db.pool.execute(query);
          logServerStep('DATABASE_QUERY_SUCCESS', { database: key, rowCount: (rows as any[]).length });

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: true, data: rows, rowCount: (rows as any[]).length, database: db.name, databaseKey: key }, null, 2)
            }]
          };
        } catch (error: any) {
          logServerStep('DATABASE_QUERY_ERROR', { database: key, error: error.message });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: false, error: error.message, database: db.name, databaseKey: key }, null, 2)
            }]
          };
        }
      });

      debug(`Registered tool: ${toolName}`);
    }

    // Add a tool to get database schema
    this.server.registerTool('get_database_schema', {
      description: 'Retrieve the schema (tables and columns) for a specified database.',
      inputSchema: {
        dbKey: z.string().describe('The key of the database (e.g., \'product\', \'faq\') for which to retrieve the schema.'),
      },
    }, async (args: { dbKey: string }) => {
      const { dbKey } = args;
      logServerStep('SCHEMA_REQUEST_RECEIVED', { dbKey });

      const database = this.databases.get(dbKey);
      if (!database) {
        logServerStep('SCHEMA_REQUEST_DATABASE_NOT_FOUND', { dbKey });
        throw new Error(`Database not configured: ${dbKey}`);
      }

      try {
        const [columns] = await database.pool.execute(
          `SELECT 
            TABLE_NAME, 
            COLUMN_NAME, 
            DATA_TYPE, 
            COLUMN_KEY 
           FROM information_schema.columns 
           WHERE table_schema = ?`,
          [database.config.database]
        );

        const [foreignKeys] = await database.pool.execute(
          `SELECT 
            TABLE_NAME, 
            COLUMN_NAME, 
            REFERENCED_TABLE_NAME, 
            REFERENCED_COLUMN_NAME 
           FROM information_schema.KEY_COLUMN_USAGE 
           WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [database.config.database]
        );

        const schema: { 
          [tableName: string]: {
            columns: { [columnName: string]: { type: string; isPrimaryKey: boolean } };
            foreignKeys: { 
              columnName: string;
              referencedTable: string;
              referencedColumn: string;
            }[];
          }
        } = {};

        (columns as any[]).forEach((row: any) => {
          if (!schema[row.TABLE_NAME]) {
            schema[row.TABLE_NAME] = { columns: {}, foreignKeys: [] };
          }
          schema[row.TABLE_NAME].columns[row.COLUMN_NAME] = {
            type: row.DATA_TYPE,
            isPrimaryKey: row.COLUMN_KEY === 'PRI'
          };
        });

        (foreignKeys as any[]).forEach((row: any) => {
          if (schema[row.TABLE_NAME]) {
            schema[row.TABLE_NAME].foreignKeys.push({
              columnName: row.COLUMN_NAME,
              referencedTable: row.REFERENCED_TABLE_NAME,
              referencedColumn: row.REFERENCED_COLUMN_NAME
            });
          }
        });

        logServerStep('SCHEMA_REQUEST_SUCCESS', { dbKey, tableCount: Object.keys(schema).length });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: true, schema, database: dbKey }, null, 2)
          }]
        };
      } catch (error: any) {
        logServerStep('SCHEMA_REQUEST_ERROR', { dbKey, error: error.message });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: error.message, database: dbKey }, null, 2)
          }]
        };
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
    } catch (error: any) {
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
