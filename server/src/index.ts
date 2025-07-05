import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { AzureOpenAI } from 'openai';
import UnifiedMCPClientManager, { McpResult } from './unified-mcp-client';
import path from 'path';
import fs from 'fs';

const DEBUG = process.env.DEBUG === 'true';
const debug = (message: string, data: any = null) => {
  if (DEBUG) {
    console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data || '');
  }
};

const logInfo = (message: string, data: any = null) => {
  console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : '');
};

const logError = (message: string, error: any = null) => {
  console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error ? (error.stack || error.message || error) : '');
};

const logStep = (step: string, requestId: string, data: any = null) => {
  console.log(`[STEP] ${new Date().toISOString()} - [${requestId}] ${step}`, data ? JSON.stringify(data, null, 2) : '');
};

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req: Request, res: Response) => {
  logInfo('Health check requested', {
    timestamp: new Date().toISOString(),
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress
  });

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    mcpEnabled: !!mcpManager,
    mcpInitialized: mcpInitialized,
    availableTools: availableTools,
    environment: process.env.NODE_ENV || 'development'
  });
});

const openai = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_KEY,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
});

debug('Azure OpenAI client initialized', {
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT
});

const mcpManager = new UnifiedMCPClientManager();

const toolMappings: { [key: string]: string } = {
  query_product_database: 'query_product_database',
  query_faq_database: 'query_faq_database'
};

debug('Unified MCP tool mappings configured', toolMappings);

async function executeMcpQuery(tool_call: any, requestId: string): Promise<McpResult> {
  const functionName = tool_call.function.name;
  const functionArgs = JSON.parse(tool_call.function.arguments);
  const toolName = toolMappings[functionName];

  logStep('MCP_QUERY_START', requestId, {
    functionName,
    functionArgs,
    toolName,
    toolCallId: tool_call.id
  });

  if (!toolName) {
    logError('Unknown function requested', { requestId, functionName });
    throw new Error(`Unknown function: ${functionName}`);
  }

  if (!mcpInitialized) {
    logError('MCP not yet initialized', { requestId, functionName });
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Database tools are still initializing. Please try again in a moment.', status: 'initializing' }) }] };
  }

  try {
    logStep('MCP_SERVER_CALL_START', requestId, {
      toolName,
      query: functionArgs.query?.substring(0, 100) + (functionArgs.query?.length > 100 ? '...' : ''),
      queryLength: functionArgs.query?.length || 0
    });

    const mcpStartTime = Date.now();

    const result = await mcpManager.executeTool(toolName, { query: functionArgs.query });

    const mcpEndTime = Date.now();

    logStep('MCP_SERVER_RESPONSE', requestId, {
      toolName,
      executionTimeMs: mcpEndTime - mcpStartTime,
      hasContent: !!(result.content && result.content.length > 0),
      contentLength: result.content?.[0]?.text?.length || 0
    });

    if (result.content && result.content.length > 0 && result.content[0].text) {
      const textContent = result.content[0].text;

      logStep('MCP_CONTENT_EXTRACTED', requestId, {
        textLength: textContent.length,
        contentPreview: textContent.substring(0, 200) + (textContent.length > 200 ? '...' : '')
      });

      try {
        const parsedContent = JSON.parse(textContent);
        if (parsedContent.success === false) {
          logError('MCP server returned database error', {
            requestId,
            error: parsedContent.error,
            database: parsedContent.database,
            toolName
          });
        } else {
          logStep('MCP_QUERY_SUCCESS', requestId, {
            database: parsedContent.database,
            rowCount: parsedContent.rowCount,
            dataSize: JSON.stringify(parsedContent.data || []).length
          });
        }
        return { content: [{ type: 'text', text: textContent }] };
      } catch (parseError: any) {
        logError('Failed to parse MCP response content', {
          requestId,
          parseError: parseError.message,
          contentPreview: textContent.substring(0, 100)
        });
        return { content: [{ type: 'text', text: textContent }] };
      }
    } else {
      logError('Empty MCP response content', { requestId, toolName, result });
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Empty response from unified MCP server' }) }] };
    }
  } catch (error: any) {
    logError('MCP query execution failed', {
      requestId,
      functionName,
      toolName,
      error: error.message,
      stack: error.stack
    });

    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to execute unified MCP query.', details: error.message }) }] };
  }
}

function formatSchemaForLLM(schemaName: string, schema: any): string {
  if (!schema || Object.keys(schema).length === 0) {
    return `\nSchema for ${schemaName} is not available.`;
  }

  let schemaString = `\n### ${schemaName} Database Schema\n`;
  for (const tableName in schema) {
    schemaString += `#### Table: ${tableName}\n`;
    schemaString += `| Column Name | Data Type | Primary Key | Foreign Key (References) |\n`;
    schemaString += `|-------------|-----------|-------------|--------------------------|\n`;
    for (const columnName in schema[tableName].columns) {
      const column = schema[tableName].columns[columnName];
      const isPrimaryKey = column.isPrimaryKey ? 'Yes' : 'No';
      let foreignKeyInfo = '';
      const fk = schema[tableName].foreignKeys.find((fk: any) => fk.columnName === columnName);
      if (fk) {
        foreignKeyInfo = `${fk.referencedTable}(${fk.referencedColumn})`;
      }
      schemaString += `| ${columnName} | ${column.type} | ${isPrimaryKey} | ${foreignKeyInfo} |\n`;
    }
    schemaString += `\n`;
  }
  return schemaString;
}

app.post('/api/chat', async (req: Request, res: Response) => {
  const requestId = generateRequestId();
  const { message } = req.body;
  const messages: any[] = [{ role: 'user', content: message }];

  logStep('USER_QUESTION_RECEIVED', requestId, {
    message: message,
    messageLength: message?.length || 0,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress
  });

  if (!message || message.trim().length === 0) {
    logError('Empty message received', { requestId });
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    logStep('PROCESSING_START', requestId);
    logStep('LLM_PROCESSING_START', requestId, {
      model: process.env.AZURE_OPENAI_API_DEPLOYMENT!,
      messageCount: messages.length,
      toolsCount: 2,
      userMessage: message.substring(0, 100) + (message.length > 100 ? '...' : '')
    });

    const productSchema = databaseSchemas.product ? formatSchemaForLLM('product', databaseSchemas.product) : '';
    const faqSchema = databaseSchemas.faq ? formatSchemaForLLM('FAQ', databaseSchemas.faq) : '';

    let response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_API_DEPLOYMENT as string,
      messages: messages,
      tools: [
        {
          type: 'function',
          function: {
            name: 'query_product_database',
            description: 'Query the product database to answer questions about products.' + productSchema,
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'A detailed and correct SQL SELECT query to execute.',
                },
              },
              required: ['query'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'query_faq_database',
            description: 'Query the FAQ database to answer frequently asked questions.' + faqSchema,
            parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'A detailed and correct SQL SELECT query to execute.',
                },
              },
              required: ['query'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    });

    logStep('LLM_INITIAL_RESPONSE', requestId, {
      finishReason: response.choices[0].finish_reason,
      hasToolCalls: !!response.choices[0].message.tool_calls,
      toolCallsCount: response.choices[0].message.tool_calls?.length || 0,
      responsePreview: response.choices[0].message.content?.substring(0, 100) + '...' || 'No content'
    });

    let responseMessage = response.choices[0].message;
    messages.push(responseMessage);

    while (responseMessage.tool_calls) {
      const toolCalls = responseMessage.tool_calls;

      logStep('TOOL_CALLS_DETECTED', requestId, {
        toolCallsCount: toolCalls.length,
        toolCallIds: toolCalls.map(tc => tc.id),
        functions: toolCalls.map(tc => tc.function.name)
      });

      for (const toolCall of toolCalls) {
        logStep('TOOL_CALL_START', requestId, {
          id: toolCall.id,
          functionName: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments || '{}')
        });

        const startTime = Date.now();
        const functionResult = await executeMcpQuery(toolCall, requestId);
        const endTime = Date.now();

        logStep('TOOL_CALL_COMPLETED', requestId, {
          id: toolCall.id,
          functionName: toolCall.function.name,
          executionTimeMs: endTime - startTime,
          resultLength: functionResult.content && functionResult.content[0] && functionResult.content[0].text ? functionResult.content[0].text.length : 0,
          resultPreview: functionResult.content && functionResult.content[0] && functionResult.content[0].text ? functionResult.content[0].text.substring(0, 200) + (functionResult.content[0].text.length > 200 ? '...' : '') : 'No content'
        });

        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: functionResult.content?.[0]?.text || '',
        });
      }

      logStep('LLM_FOLLOWUP_START', requestId, {
        messageCount: messages.length,
        totalToolResults: toolCalls.length
      });

      const secondResponse = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_API_DEPLOYMENT!,
        messages: messages,
      });

      logStep('LLM_FOLLOWUP_RESPONSE', requestId, {
        finishReason: secondResponse.choices[0].finish_reason,
        hasToolCalls: !!secondResponse.choices[0].message.tool_calls,
        responsePreview: secondResponse.choices[0].message.content?.substring(0, 100) + '...' || 'No content'
      });

      responseMessage = secondResponse.choices[0].message;
      messages.push(responseMessage);
    }

    logStep('FINAL_RESPONSE', requestId, {
      responseLength: responseMessage.content ? responseMessage.content.length : 0,
      totalMessages: messages.length,
      finalContent: responseMessage.content ? responseMessage.content.substring(0, 200) + (responseMessage.content.length > 200 ? '...' : '') : 'No content',
      hasContent: !!responseMessage.content
    });

    if (!responseMessage.content) {
      logError('Empty response content from LLM', { requestId, responseMessage });
    }

    res.json(responseMessage);

    logStep('REQUEST_COMPLETED', requestId, {
      totalProcessingTimeMs: Date.now() - parseInt(requestId.split('_')[1]),
      success: true
    });

  } catch (error: any) {
    logError('Error in /api/chat endpoint', {
      requestId,
      error: error.message,
      stack: error.stack,
      phase: 'main_handler'
    });

    res.status(500).json({ error: 'An error occurred processing your request.' });

    logStep('REQUEST_FAILED', requestId, {
      error: error.message
    });
  }
});

const port = process.env.PORT || 3000;

let mcpInitialized = false;
let availableTools: string[] = [];
let databaseSchemas: { [key: string]: any } = {};

logInfo('=== SQL CHAT SERVER STARTUP ===');
logInfo('Configuration', {
  port,
  debugMode: DEBUG,
  azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  nodeEnv: process.env.NODE_ENV || 'development'
});

app.listen(port, () => {
  logInfo('=== EXPRESS SERVER STARTED ===', {
    port,
    healthEndpoint: `http://localhost:${port}/health`,
    chatEndpoint: `http://localhost:${port}/api/chat`,
    startupComplete: new Date().toISOString()
  });

  console.log(`\n🚀 SQL Chat Server is running on port ${port}`);
  console.log(`📊 Health Check: http://localhost:${port}/health`);
  console.log(`💬 Chat API: http://localhost:${port}/api/chat`);
  console.log(`🐛 Debug Mode: ${DEBUG ? 'ENABLED' : 'DISABLED'}`);
  console.log(`\n--- Express server ready, initializing MCP... ---\n`);
});

(async () => {
  try {
    logInfo('Initializing unified MCP server...');
    
    const mcpInitPromise = mcpManager.initialize();
    const timeoutPromise = new Promise<string[]>((_, reject) => {
      setTimeout(() => reject(new Error('MCP initialization timeout after 30 seconds')), 30000);
    });
    
    availableTools = await Promise.race([mcpInitPromise, timeoutPromise]);
    mcpInitialized = true;

    // Fetch database schemas
    if (availableTools.includes('query_product_database')) {
      try {
        databaseSchemas.product = await mcpManager.fetchDatabaseSchema('product');
        logInfo('Product database schema fetched successfully.', { schema: databaseSchemas.product });
      } catch (schemaError: any) {
        logError('Failed to fetch product database schema', schemaError);
      }
    }
    if (availableTools.includes('query_faq_database')) {
      try {
        databaseSchemas.faq = await mcpManager.fetchDatabaseSchema('faq');
        logInfo('FAQ database schema fetched successfully.', { schema: databaseSchemas.faq });
      } catch (schemaError: any) {
        logError('Failed to fetch FAQ database schema', schemaError);
      }
    }

    logInfo('=== MCP SERVER READY ===', {
      tools: availableTools,
      toolCount: availableTools.length
    });

    console.log(`🔧 MCP Tools Available: ${availableTools.join(', ')}`);
    console.log(`\n--- Ready to process chat requests with MCP ---\n`);
  } catch (error: any) {
    logError('Failed to initialize unified MCP server', {
      error: error.message,
      stack: error.stack,
      cause: error.cause
    });
    console.log(`\n⚠️  MCP initialization failed: ${error.message}`);
    console.log(`💬 Chat API still available for non-database queries\n`);
    
    console.log('🔍 Debug Info:');
    console.log(`- MCP Server Path: ${path.join(__dirname, '../../mcp-server/dist/unified-mysql-server.js')}`);
    console.log(`- File Exists: ${fs.existsSync(path.join(__dirname, '../../mcp-server/dist/unified-mysql-server.js'))}`);
    console.log(`- Node Version: ${process.version}`);
    console.log(`- Current Working Directory: ${process.cwd()}`);
  }
})();

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  try {
    await mcpManager.shutdown();
    console.log('MCP servers shut down successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  try {
    await mcpManager.shutdown();
    console.log('MCP servers shut down successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});
