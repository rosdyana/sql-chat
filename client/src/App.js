import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const SERVER_URL = 'http://localhost:3055'; // Ensure this matches your server's port

function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('Connecting...');
  const [currentStreamedResponse, setCurrentStreamedResponse] = useState(''); // New state for streamed content
  const socketRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    // Initialize WebSocket connection
    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('Connected to server.');
    });

    socket.on('disconnect', () => {
      setStatus('Disconnected from server.');
    });

    socket.on('error', (err) => {
      setStatus(`Error: ${err.message || err}`);
      setMessages((prevMessages) => [...prevMessages, { role: 'system', content: `Error: ${err.message || JSON.stringify(err)}`, type: 'error' }]);
    });

    socket.on('status', (data) => {
      setStatus(data.message);
    });

    socket.on('clearChatChunks', () => {
      setCurrentStreamedResponse('');
    });

    socket.on('chatChunk', (data) => {
      setCurrentStreamedResponse((prev) => {
        console.log('Client received chatChunk:', data.content); // Re-added log
        return prev + data.content;
      });
    });

    socket.on('toolCall', (data) => {
      setMessages((prevMessages) => [
        ...prevMessages,
        { role: 'system', content: `Calling tool: ${data.name} with args: ${JSON.stringify(data.args)}`, type: 'toolCall' },
      ]);
    });

    socket.on('toolResult', (data) => {
      setMessages((prevMessages) => [
        ...prevMessages,
        { role: 'system', content: `Tool result: ${data.result}`, type: 'toolResult' },
      ]);
    });

    socket.on('finalResponse', (data) => {
      let finalMessageContent;
      if (currentStreamedResponse) {
        finalMessageContent = currentStreamedResponse;
      } else {
        finalMessageContent = data.content;
      }
      setMessages((prevMessages) => [...prevMessages, { role: 'ai', content: finalMessageContent, type: 'finalResponse' }]);
      setCurrentStreamedResponse(''); // Clear the streamed response after finalizing
      setStatus('Ready.');
    });

    // Clean up on component unmount
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Scroll to bottom of messages div
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = () => {
    if (input.trim() === '') return;

    const userMessage = { role: 'user', content: input, type: 'user' };
    setMessages((prevMessages) => [...prevMessages, userMessage]);
    setInput('');

    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit('chatMessage', input);
      setStatus('Sending message...');
    } else {
      setStatus('Not connected to server.');
      setMessages((prevMessages) => [...prevMessages, { role: 'system', content: 'Error: Not connected to server.', type: 'error' }]);
    }
  };

  const getMessageStyle = (msg) => {
    let textAlign = 'left';

    if (msg.role === 'user') {
      textAlign = 'right';
    }

    return {
      textAlign: textAlign,
      marginBottom: '10px',
      display: 'flex',
      justifyContent: textAlign === 'right' ? 'flex-end' : 'flex-start',
      width: '100%',
      boxSizing: 'border-box',
      padding: '0 10px',
    };
  };

  const getBubbleStyle = (msg) => {
    let backgroundColor = '#f1f0f0';
    let color = '#000';

    if (msg.role === 'user') {
      backgroundColor = '#dcf8c6';
    } else if (msg.type === 'toolCall' || msg.type === 'toolResult') {
      backgroundColor = '#e0e0e0';
      color = '#555';
    } else if (msg.type === 'error') {
      backgroundColor = '#ffcccc';
      color = '#cc0000';
    } else if (msg.type === 'streaming') {
      backgroundColor = '#e6f7ff'; // Light blue for streaming
      color = '#000';
    }

    return {
      display: 'inline-block',
      padding: '8px 12px',
      borderRadius: '10px',
      backgroundColor: backgroundColor,
      color: color,
      maxWidth: '80%',
      wordBreak: 'break-word',
    };
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: '800px', margin: '0 auto', padding: '20px', boxSizing: 'border-box', fontFamily: 'Arial, sans-serif' }}>
      <h1 style={{ textAlign: 'center', color: '#333' }}>SQL Chat Client</h1>
      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ccc', borderRadius: '8px', padding: '10px', marginBottom: '10px', backgroundColor: '#f9f9f9' }}>
        {messages.map((msg, index) => (
          <div key={index} style={getMessageStyle(msg)}>
            <div style={getBubbleStyle(msg)}>
              {msg.role === 'ai' || msg.type === 'finalResponse' ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown> : msg.content}
            </div>
          </div>
        ))}
        {currentStreamedResponse && (
          <div style={getMessageStyle({ role: 'ai', type: 'streaming' })}>
            <div style={getBubbleStyle({ role: 'ai', type: 'streaming' })}>
              {currentStreamedResponse}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ padding: '8px', backgroundColor: '#eee', borderRadius: '5px', marginBottom: '10px', fontSize: '0.9em', color: '#555' }}>
        Status: {status}
      </div>
      <div style={{ display: 'flex' }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Type your message..."
          style={{ flex: 1, padding: '12px', border: '1px solid #ccc', borderRadius: '5px 0 0 5px', fontSize: '1em' }}
        />
        <button
          onClick={sendMessage}
          style={{ padding: '12px 20px', border: 'none', backgroundColor: '#007bff', color: 'white', borderRadius: '0 5px 5px 0', cursor: 'pointer', fontSize: '1em', fontWeight: 'bold' }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default App;