require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AzureOpenAI } = require('openai');
const UnifiedMCPClientManager = require('./unified-mcp-client');

const DEBUG = process.env.DEBUG === 'true';
const debug = (message, data = null) => {
  if (DEBUG) {
    console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, data || '');
  }
};

// Enhanced logging functions
const logInfo = (message, data = null) => {
  console.log(`[INFO] ${new Date().toISOString()} - ${message}`, data ? JSON.stringify(data, null, 2) : '');
};

const logError = (message, error = null) => {
  console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error ? (error.stack || error.message || error) : '');
};

const logStep = (step, requestId, data = null) => {
  console.log(`[STEP] ${new Date().toISOString()} - [${requestId}] ${step}`, data ? JSON.stringify(data, null, 2) : '');
};

// Generate unique request ID for tracking
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint with logging
app.get('/health', (req, res) => {
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

// Initialize Unified MCP Client Manager
const mcpManager = new UnifiedMCPClientManager();

// Tool name mapping - simplified for unified server
const toolMappings = {
  query_product_database: 'query_product_database',
  query_faq_database: 'query_faq_database'
};

debug('Unified MCP tool mappings configured', toolMappings);

async function executeMcpQuery(tool_call, requestId) {
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

  // Check if MCP is initialized
  if (!mcpInitialized) {
    logError('MCP not yet initialized', { requestId, functionName });
    return JSON.stringify({ 
      error: 'Database tools are still initializing. Please try again in a moment.',
      status: 'initializing'
    });
  }

  try {
    logStep('MCP_SERVER_CALL_START', requestId, {
      toolName,
      query: functionArgs.query?.substring(0, 100) + (functionArgs.query?.length > 100 ? '...' : ''),
      queryLength: functionArgs.query?.length || 0
    });

    const mcpStartTime = Date.now();

    // Execute the tool via unified MCP server
    const result = await mcpManager.executeTool(toolName, { query: functionArgs.query });

    const mcpEndTime = Date.now();

    logStep('MCP_SERVER_RESPONSE', requestId, {
      toolName,
      executionTimeMs: mcpEndTime - mcpStartTime,
      hasContent: !!(result.content && result.content.length > 0),
      contentLength: result.content?.length || 0
    });

    // Extract the text content from MCP response
    if (result.content && result.content.length > 0) {
      const textContent = result.content[0].text;

      logStep('MCP_CONTENT_EXTRACTED', requestId, {
        textLength: textContent.length,
        contentPreview: textContent.substring(0, 200) + (textContent.length > 200 ? '...' : '')
      });

      // Parse the JSON response to check for errors
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
        return textContent;
      } catch (parseError) {
        logError('Failed to parse MCP response content', {
          requestId,
          parseError: parseError.message,
          contentPreview: textContent.substring(0, 100)
        });
        return textContent;
      }
    } else {
      logError('Empty MCP response content', { requestId, toolName, result });
      return JSON.stringify({ error: 'Empty response from unified MCP server' });
    }
  } catch (error) {
    logError('MCP query execution failed', {
      requestId,
      functionName,
      toolName,
      error: error.message,
      stack: error.stack
    });

    return JSON.stringify({
      error: 'Failed to execute unified MCP query.',
      details: error.message
    });
  }
}

app.post('/api/chat', async (req, res) => {
  const requestId = generateRequestId();
  const { message } = req.body;
  const messages = [{ role: 'user', content: message }];

  // Step 1: Log incoming user question
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
    // Step 2: Start LLM processing
    logStep('LLM_PROCESSING_START', requestId, {
      model: process.env.AZURE_OPENAI_API_DEPLOYMENT,
      messageCount: messages.length,
      toolsCount: 2,
      userMessage: message.substring(0, 100) + (message.length > 100 ? '...' : '')
    });

    let response = await openai.chat.completions.create({
      model: process.env.AZURE_OPENAI_API_DEPLOYMENT,
      messages: messages,
      tools: [
        {
          type: 'function',
          function: {
            name: 'query_product_database',
            description: 'Query the product database to answer questions about products.',
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
            description: 'Query the FAQ database to answer frequently asked questions.',
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

    // Step 3: LLM initial response received
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

      // Step 4: Tool calls detected
      logStep('TOOL_CALLS_DETECTED', requestId, {
        toolCallsCount: toolCalls.length,
        toolCallIds: toolCalls.map(tc => tc.id),
        functions: toolCalls.map(tc => tc.function.name)
      });

      for (const toolCall of toolCalls) {
        // Step 5: Processing individual tool call
        logStep('TOOL_CALL_START', requestId, {
          id: toolCall.id,
          functionName: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments || '{}')
        });

        const startTime = Date.now();
        const functionResult = await executeMcpQuery(toolCall, requestId);
        const endTime = Date.now();

        // Step 6: Tool call completed
        logStep('TOOL_CALL_COMPLETED', requestId, {
          id: toolCall.id,
          functionName: toolCall.function.name,
          executionTimeMs: endTime - startTime,
          resultLength: functionResult.length,
          resultPreview: functionResult.substring(0, 200) + (functionResult.length > 200 ? '...' : '')
        });

        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: functionResult,
        });
      }

      // Step 7: Making follow-up LLM call
      logStep('LLM_FOLLOWUP_START', requestId, {
        messageCount: messages.length,
        totalToolResults: toolCalls.length
      });

      const secondResponse = await openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_API_DEPLOYMENT,
        messages: messages,
      });

      // Step 8: Follow-up LLM response
      logStep('LLM_FOLLOWUP_RESPONSE', requestId, {
        finishReason: secondResponse.choices[0].finish_reason,
        hasToolCalls: !!secondResponse.choices[0].message.tool_calls,
        responsePreview: secondResponse.choices[0].message.content?.substring(0, 100) + '...' || 'No content'
      });

      responseMessage = secondResponse.choices[0].message;
      messages.push(responseMessage);
    }

    // Step 9: Sending final response
    logStep('FINAL_RESPONSE', requestId, {
      responseLength: responseMessage.content?.length || 0,
      totalMessages: messages.length,
      finalContent: responseMessage.content?.substring(0, 200) + (responseMessage.content?.length > 200 ? '...' : '') || 'No content',
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

  } catch (error) {
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

// MCP initialization state
let mcpInitialized = false;
let availableTools = [];

// Start Express server immediately
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

// Initialize MCP in background after Express starts
(async () => {
  try {
    logInfo('Initializing unified MCP server...');
    
    // Add timeout to MCP initialization
    const mcpInitPromise = mcpManager.initialize();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('MCP initialization timeout after 30 seconds')), 30000);
    });
    
    availableTools = await Promise.race([mcpInitPromise, timeoutPromise]);
    mcpInitialized = true;

    logInfo('=== MCP SERVER READY ===', {
      tools: availableTools,
      toolCount: availableTools.length
    });

    console.log(`🔧 MCP Tools Available: ${availableTools.join(', ')}`);
    console.log(`\n--- Ready to process chat requests with MCP ---\n`);
  } catch (error) {
    logError('Failed to initialize unified MCP server', {
      error: error.message,
      stack: error.stack,
      cause: error.cause
    });
    console.log(`\n⚠️  MCP initialization failed: ${error.message}`);
    console.log(`💬 Chat API still available for non-database queries\n`);
    
    // Try to debug what went wrong
    console.log('🔍 Debug Info:');
    console.log(`- MCP Server Path: ${require('path').join(__dirname, '../mcp-server/unified-mysql-server.js')}`);
    console.log(`- File Exists: ${require('fs').existsSync(require('path').join(__dirname, '../mcp-server/unified-mysql-server.js'))}`);
    console.log(`- Node Version: ${process.version}`);
    console.log(`- Current Working Directory: ${process.cwd()}`);
  }
})();

// Graceful shutdown
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