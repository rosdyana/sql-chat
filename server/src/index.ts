import 'dotenv/config';
import { AzureOpenAI } from 'openai';
import { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import UnifiedMCPClientManager, { McpResult } from './unified-mcp-client';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { Server, Socket } from 'socket.io';

const DEBUG = process.env.DEBUG === 'true';
const port = process.env.PORT || 3001;

// --- Logging ---
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

// --- State & Configuration ---
let mcpInitialized = false;
let availableTools: string[] = [];
const databaseSchemas: { [key: string]: any } = {};

const openai = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_KEY,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION,
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
});
debug('Azure OpenAI client initialized');

const mcpManager = new UnifiedMCPClientManager();

const toolMappings: { [key: string]: string } = {
  query_product_database: 'query_product_database',
  query_faq_database: 'query_faq_database'
};
debug('Unified MCP tool mappings configured', toolMappings);

// --- Helper Functions ---
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

const SCHEMA_GUIDELINES = `
**Schema Usage Guidelines:**
- **Strict Adherence:** Only use tables and columns explicitly listed in this schema. Do not invent columns or tables.
- **JOINs for Detail:** Always use JOIN clauses to retrieve comprehensive, related data instead of just IDs. Explicitly state the JOIN conditions.
- **Filtering (WHERE):** Always consider adding appropriate WHERE clauses for filtering results.
- **Optimization (LIMIT):** For potentially large results, include a LIMIT clause (e.g., \`LIMIT 100\`) to optimize performance.
- **Ordering (ORDER BY):** Use ORDER BY clauses for meaningful sorting of results.
- **Primary/Foreign Keys:** Leverage Primary Keys (PK) and Foreign Keys (FK) for efficient and correct JOIN operations. Foreign key relationships are explicitly listed.
`;

function formatSchemaForLLM(schemaName: string, schema: any): string {
  if (!schema || Object.keys(schema).length === 0) {
    return `\nSchema for ${schemaName} is not available.`;
  }

  let schemaString = `\n### ${schemaName} Database Schema\n`;
  schemaString += SCHEMA_GUIDELINES;

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
    
    if (schema[tableName].foreignKeys.length > 0) {
      schemaString += `\n**Relationships (JOIN conditions):**\n`;
      schema[tableName].foreignKeys.forEach((fk: any) => {
        schemaString += `- \`${tableName}.${fk.columnName}\` JOINs \`${fk.referencedTable}.${fk.referencedColumn}\`\n`;
      });
    }
    schemaString += `\n`;
  }
  return schemaString;
}

// --- HTTP Server & Health Check ---
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      mcpEnabled: !!mcpManager,
      mcpInitialized: mcpInitialized,
      availableTools: availableTools,
      environment: process.env.NODE_ENV || 'development'
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// --- WebSocket Server ---
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket: Socket) => {
  logInfo('New WebSocket client connected', { socketId: socket.id });

  socket.on('chatMessage', (message: string) => handleChatMessage(socket, message));
  
  socket.on('disconnect', () => {
    logInfo('WebSocket client disconnected', { socketId: socket.id });
  });
});

// --- Core Chat Logic ---
async function handleChatMessage(socket: Socket, message: string) {
  const requestId = generateRequestId();
  logStep('USER_QUESTION_RECEIVED', requestId, { message, socketId: socket.id });

  if (!message || message.trim().length === 0) {
    logError('Empty message received', { requestId, socketId: socket.id });
    socket.emit('error', { message: 'Message is required' });
    return;
  }

  try {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: message }];
    
    const productSchema = databaseSchemas.product ? formatSchemaForLLM('product', databaseSchemas.product) : '';
    const faqSchema = databaseSchemas.faq ? formatSchemaForLLM('FAQ', databaseSchemas.faq) : '';

    const tools: ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'query_product_database',
          description: 'Query the product database to answer questions about products.' + productSchema,
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'A detailed and correct SQL SELECT query to execute.' } }, required: ['query'] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'query_faq_database',
          description: 'Query the FAQ database to answer frequently asked questions.' + faqSchema,
          parameters: { type: 'object', properties: { query: { type: 'string', description: 'A detailed and correct SQL SELECT query to execute.' } }, required: ['query'] },
        },
      },
    ];

    const MAX_RETRIES = 3;
    let retries = 0;
    let finalContent: string | null = null;

    while (retries <= MAX_RETRIES) {
      const response = await callOpenAI(requestId, socket, messages, tools, retries);
      const responseMessage = response.choices[0].message;
      messages.push(responseMessage);

      if (responseMessage.tool_calls) {
        const toolCalls = responseMessage.tool_calls;
        socket.emit('status', { message: `Executing tools: ${toolCalls.map(tc => tc.function.name).join(', ')}` });
        
        const { toolMessages, executionFailed } = await executeToolCalls(requestId, socket, toolCalls);
        messages.push(...toolMessages);

        if (executionFailed) {
          retries++;
          if (retries <= MAX_RETRIES) {
            logInfo('Tool execution failed, retrying LLM call with error feedback.', { requestId, retries });
            socket.emit('status', { message: `Tool execution failed. Retrying LLM call (${retries}/${MAX_RETRIES})...` });
            continue; // Retry the loop
          } else {
            logError('Max retries reached for tool execution.', { requestId });
            socket.emit('status', { message: 'Max retries reached. Please refine your query.' });
            finalContent = "I was unable to execute the required tools after multiple attempts. Please try rephrasing your question.";
            break; // Exit loop
          }
        }
        
        // If tools succeeded, make a follow-up call to get a natural language response
        socket.emit('status', { message: 'Synthesizing final answer...' });
        const finalResponse = await callOpenAI(requestId, socket, messages, tools, -1); // -1 indicates a final call
        finalContent = finalResponse.choices[0].message.content;
        break; // Exit loop

      } else {
        finalContent = responseMessage.content;
        break; // No tools, exit loop
      }
    }

    logStep('FINAL_RESPONSE', requestId, { responseLength: finalContent?.length, hasContent: !!finalContent });
    if (finalContent) {
      socket.emit('finalResponse', { content: finalContent });
    } else {
      logError('Empty final response from LLM', { requestId });
      socket.emit('error', { message: 'Received empty response from LLM.' });
    }

    logStep('REQUEST_COMPLETED', requestId, { success: true });

  } catch (error: any) {
    logError('Error in chatMessage handler', { requestId, error: error.message, stack: error.stack });
    socket.emit('error', { message: 'An internal server error occurred.', details: error.message });
    logStep('REQUEST_FAILED', requestId, { error: error.message });
  }
}

async function callOpenAI(requestId: string, socket: Socket, messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[], attempt: number) {
  logStep('LLM_CALL_START', requestId, { attempt: attempt + 1, messageCount: messages.length });
  socket.emit('status', { message: attempt === -1 ? 'Generating final response...' : `Thinking (attempt ${attempt + 1})...` });

  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_API_DEPLOYMENT as string,
    messages: messages,
    tools: tools,
    tool_choice: 'auto',
  });

  logStep('LLM_RESPONSE_RECEIVED', requestId, {
    finishReason: response.choices[0].finish_reason,
    hasToolCalls: !!response.choices[0].message.tool_calls,
  });
  return response;
}

async function executeToolCalls(requestId: string, socket: Socket, toolCalls: readonly ChatCompletionMessageToolCall[]) {
  let executionFailed = false;
  const toolMessages: ChatCompletionMessageParam[] = [];

  for (const toolCall of toolCalls) {
    logStep('TOOL_CALL_START', requestId, { id: toolCall.id, functionName: toolCall.function.name });
    socket.emit('toolCall', { id: toolCall.id, name: toolCall.function.name, args: JSON.parse(toolCall.function.arguments || '{}') });

    let functionResult: McpResult;
    try {
      functionResult = await executeMcpQuery(toolCall, requestId);
      const parsedContent = JSON.parse(functionResult.content?.[0]?.text || '{}');
      if (parsedContent.success === false) {
        logError('MCP tool returned an error', { requestId, toolCallId: toolCall.id, error: parsedContent.error });
        executionFailed = true;
      }
    } catch (error: any) {
      logError('Tool execution failed', { requestId, toolCallId: toolCall.id, error: error.message });
      functionResult = { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }) }] };
      executionFailed = true;
    }

    socket.emit('toolResult', { id: toolCall.id, result: functionResult.content?.[0]?.text || '' });
    toolMessages.push({
      tool_call_id: toolCall.id,
      role: 'tool',
      content: functionResult.content?.[0]?.text || '',
    });
  }
  return { toolMessages, executionFailed };
}

async function executeMcpQuery(tool_call: ChatCompletionMessageToolCall, requestId: string): Promise<McpResult> {
  const functionName = tool_call.function.name;
  const functionArgs = JSON.parse(tool_call.function.arguments);
  const toolName = toolMappings[functionName];

  logStep('MCP_QUERY_START', requestId, { functionName, functionArgs, toolName, toolCallId: tool_call.id });

  if (!toolName) {
    throw new Error(`Unknown function: ${functionName}`);
  }
  if (!mcpInitialized) {
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'MCP not initialized' }) }] };
  }

  try {
    const result = await mcpManager.executeTool(toolName, functionArgs);
    logStep('MCP_SERVER_RESPONSE', requestId, { toolName, hasContent: !!result.content });
    return result;
  } catch (error: any) {
    logError('MCP query execution failed', { requestId, functionName, error: error.message });
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'Failed to execute MCP query.', details: error.message }) }] };
  }
}

// --- Server Initialization & Shutdown ---
server.listen(port, () => {
  logInfo('=== WebSocket Server Started ===', {
    port,
    healthEndpoint: `http://localhost:${port}/health`,
  });
  console.log(`🚀 SQL Chat Server is running on port ${port}`);
});

(async () => {
  try {
    logInfo('Initializing unified MCP client...');
    const mcpInitPromise = mcpManager.initialize();
    const timeoutPromise = new Promise<string[]>((_, reject) => {
      setTimeout(() => reject(new Error('MCP initialization timeout after 30 seconds')), 30000);
    });
    
    availableTools = await Promise.race([mcpInitPromise, timeoutPromise]);
    mcpInitialized = true;

    if (availableTools.includes('get_database_schema')) {
      if (availableTools.includes('query_product_database')) {
        try {
          databaseSchemas.product = await mcpManager.fetchDatabaseSchema('product');
          logInfo('Product database schema fetched successfully.');
        } catch (schemaError: any) {
          logError('Failed to fetch product database schema', schemaError);
        }
      }
      if (availableTools.includes('query_faq_database')) {
        try {
          databaseSchemas.faq = await mcpManager.fetchDatabaseSchema('faq');
          logInfo('FAQ database schema fetched successfully.');
        } catch (schemaError: any) {
          logError('Failed to fetch FAQ database schema', schemaError);
        }
      }
    }

    logInfo('=== MCP Client Ready ===', { tools: availableTools });
    console.log(`🔧 MCP Tools Available: ${availableTools.join(', ')}`);
  } catch (error: any) {
    logError('Failed to initialize unified MCP client', { error: error.message });
    console.log(`\n⚠️  MCP initialization failed: ${error.message}`);
    console.log(`- File Exists: ${fs.existsSync(path.join(__dirname, '../../mcp-server/dist/unified-mysql-server.js'))}`);
  }
})();

const shutdown = async () => {
  console.log('Shutting down gracefully...');
  server.close(async () => {
    try {
      await mcpManager.shutdown();
      console.log('MCP client shut down successfully');
      process.exit(0);
    } catch (error) {
      console.error('Error during MCP shutdown:', error);
      process.exit(1);
    }
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);