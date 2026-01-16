import React, { useState, useRef } from 'react';
import { Upload, Sparkles, Send, X, FileText, Loader2, Play, AlertCircle } from 'lucide-react';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

export default function AriaAgent() {
  const [analyzing, setAnalyzing] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [chatHistory, setChatHistory] = useState([]);
  const [userMessage, setUserMessage] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [fileMetadata, setFileMetadata] = useState([]);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const processFile = async (file) => {
    const extension = file.name.split('.').pop().toLowerCase();
    
    try {
      if (extension === 'xlsx' || extension === 'xls') {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            try {
              const data = new Uint8Array(e.target.result);
              const workbook = XLSX.read(data, { type: 'array' });
              let content = '';
              let rowCount = 0;
              
              workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                const lines = csv.split('\n').filter(line => line.trim());
                rowCount += lines.length;
                content += `\n=== SHEET: ${sheetName} (${lines.length} rows) ===\n`;
                content += csv;
              });
              
              resolve({ content, rowCount, sheetCount: workbook.SheetNames.length });
            } catch (err) {
              reject(new Error(`Failed to parse Excel file: ${err.message}`));
            }
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsArrayBuffer(file);
        });
      } else if (extension === 'doc' || extension === 'docx') {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async (e) => {
            try {
              const arrayBuffer = e.target.result;
              const result = await mammoth.extractRawText({ arrayBuffer });
              resolve({ content: result.value, wordCount: result.value.split(/\s+/).length });
            } catch (err) {
              reject(new Error(`Failed to parse Word document: ${err.message}`));
            }
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsArrayBuffer(file);
        });
      } else {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const content = e.target.result;
            const lines = content.split('\n').filter(line => line.trim());
            resolve({ content, lineCount: lines.length });
          };
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsText(file);
        });
      }
    } catch (err) {
      throw new Error(`Error processing ${file.name}: ${err.message}`);
    }
  };

  const smartTruncate = (content, maxChars = 15000) => {
    if (content.length <= maxChars) return { content, truncated: false };
    
    const lines = content.split('\n');
    const headerLines = lines.slice(0, 3).join('\n');
    const remaining = maxChars - headerLines.length - 200;
    const middleContent = content.substring(headerLines.length, headerLines.length + remaining);
    
    return {
      content: headerLines + '\n' + middleContent + '\n\n[... content truncated for length ...]',
      truncated: true
    };
  };

  const analyzeData = async () => {
    if (pendingFiles.length === 0) return;
    
    setAnalyzing(true);
    setProcessing(true);
    setError(null);
    
    const systemPrompt = `You are Aria, the Margin Maven - an expert AI sales analysis agent with 20+ years of equivalent experience. Your mission: transform raw sales files into actionable forecasts, high-margin insights, and strategic recommendations.

CORE BEHAVIOR:
- Always respond professionally yet conversationally, like a trusted sales director
- Begin every analysis with: "Aria analyzing your sales data... Processing complete."
- End with 2-3 prioritized action items with confidence scores
- Never guess numbers - base ALL insights on provided file data only
- Calculate key metrics: total debits, outstanding balances, aging analysis, customer concentration

ANALYSIS TO PROVIDE:
1. **Financial Overview**: Total outstanding, average days outstanding, top customers by balance
2. **Risk Assessment**: Identify customers with balances >90 days old
3. **Cash Flow Forecast**: Estimate collection timeline based on aging
4. **Strategic Recommendations**: Prioritize which customers to follow up with first
5. **Cross-file Insights**: Compare patterns across multiple files if provided

Format your response with clear sections and actionable insights.`;

    try {
      const filesData = [];
      const metadata = [];
      
      for (const file of pendingFiles) {
        const processed = await processFile(file);
        const truncated = smartTruncate(processed.content);
        
        filesData.push({ 
          name: file.name, 
          content: truncated.content,
          truncated: truncated.truncated
        });
        
        metadata.push({
          name: file.name,
          size: file.size,
          ...processed
        });
      }

      setProcessing(false);

      const combinedContent = filesData.map(f => 
        `FILE: ${f.name}${f.truncated ? ' [TRUNCATED]' : ''}\n${'='.repeat(50)}\n${f.content}\n\n`
      ).join('\n');

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: `Analyze these ${filesData.length} sales/accounts receivable file(s):\n\n${combinedContent}`
            }
          ],
        })
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const aiResponse = data.content.find(item => item.type === "text")?.text || "Analysis complete.";
      
      setUploadedFiles(prev => [...prev, ...filesData]);
      setFileMetadata(prev => [...prev, ...metadata]);
      setChatHistory(prev => [...prev, 
        { role: 'system', content: `${filesData.length} file(s) analyzed: ${metadata.map(m => m.name).join(', ')}` },
        { role: 'assistant', content: aiResponse }
      ]);
      setPendingFiles([]);
    } catch (error) {
      console.error('Analysis error:', error);
      setError(error.message);
      setChatHistory(prev => [...prev, 
        { role: 'system', content: `Error: ${error.message}` }
      ]);
    }
    
    setAnalyzing(false);
    setProcessing(false);
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    const validFiles = files.filter(f => {
      const ext = f.name.split('.').pop().toLowerCase();
      return ['csv', 'txt', 'xlsx', 'xls', 'doc', 'docx'].includes(ext);
    });
    
    if (validFiles.length !== files.length) {
      setError('Some files were skipped due to unsupported format');
    }
    
    setPendingFiles(prev => [...prev, ...validFiles]);
  };

  const handleChat = async () => {
    if (!userMessage.trim()) return;

    const newMessage = { role: 'user', content: userMessage };
    setChatHistory(prev => [...prev, newMessage]);
    setUserMessage('');
    setAnalyzing(true);
    setError(null);

    try {
      const fileContext = fileMetadata.length > 0 
        ? `\n\nContext: User has uploaded ${fileMetadata.length} file(s): ${fileMetadata.map(m => `${m.name} (${(m.size/1024).toFixed(1)}KB)`).join(', ')}`
        : '';

      const messages = chatHistory
        .filter(msg => msg.role !== 'system')
        .concat([newMessage])
        .map(msg => ({ role: msg.role, content: msg.content }));

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: `You are Aria, an expert sales analysis AI. Continue the conversation based on previous context. Be concise and actionable.${fileContext}`,
          messages: messages
        })
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const aiResponse = data.content.find(item => item.type === "text")?.text || "I'm here to help!";
      
      setChatHistory(prev => [...prev, { role: 'assistant', content: aiResponse }]);
    } catch (error) {
      console.error('Chat error:', error);
      setError(error.message);
      setChatHistory(prev => [...prev, { 
        role: 'assistant', 
        content: `I encountered an error: ${error.message}. Please try again.` 
      }]);
    }
    
    setAnalyzing(false);
  };

  const removePendingFile = (index) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const resetConversation = () => {
    setChatHistory([]);
    setUploadedFiles([]);
    setFileMetadata([]);
    setPendingFiles([]);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl">
        
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-3 mb-2">
            <Sparkles className="w-6 h-6 text-gray-400" strokeWidth={1} />
            <h1 className="text-4xl font-extralight tracking-widest text-gray-200">aria</h1>
          </div>
          <p className="text-gray-600 text-xs tracking-widest">sales intelligence</p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-2xl p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
            <div className="flex-1">
              <p className="text-sm text-red-300">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-300">
              <X className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        )}

        {/* Main Container */}
        <div className="bg-white/5 backdrop-blur-2xl rounded-3xl border border-white/10 overflow-hidden shadow-2xl">
          
          {/* Upload Area */}
          {chatHistory.length === 0 && (
            <div className="p-12">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,.xlsx,.xls,.doc,.docx"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-white/10 rounded-2xl p-16 text-center cursor-pointer hover:border-white/20 transition-all duration-300 hover:bg-white/5"
              >
                <Upload className="w-10 h-10 text-gray-500 mx-auto mb-4" strokeWidth={1} />
                <p className="text-gray-400 text-sm mb-2">drop files or click to upload</p>
                <p className="text-gray-700 text-xs">csv • txt • excel • word</p>
              </div>

              {/* Pending Files */}
              {pendingFiles.length > 0 && (
                <div className="mt-6 space-y-3">
                  {pendingFiles.map((file, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4 text-gray-500" strokeWidth={1} />
                        <span className="text-sm text-gray-300">{file.name}</span>
                        <span className="text-xs text-gray-600">{(file.size / 1024).toFixed(1)} kb</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removePendingFile(idx);
                        }}
                        className="text-gray-600 hover:text-gray-400 transition-colors"
                      >
                        <X className="w-4 h-4" strokeWidth={1} />
                      </button>
                    </div>
                  ))}
                  
                  {/* Analyze Button */}
                  <button
                    onClick={analyzeData}
                    disabled={analyzing}
                    className="w-full mt-4 bg-white/10 hover:bg-white/15 border border-white/20 rounded-xl py-4 px-6 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
                  >
                    {processing ? (
                      <>
                        <Loader2 className="w-4 h-4 text-gray-400 animate-spin" strokeWidth={1} />
                        <span className="text-sm text-gray-400 font-light">processing files...</span>
                      </>
                    ) : analyzing ? (
                      <>
                        <Loader2 className="w-4 h-4 text-gray-400 animate-spin" strokeWidth={1} />
                        <span className="text-sm text-gray-400 font-light">analyzing...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 text-gray-400" strokeWidth={1} />
                        <span className="text-sm text-gray-300 font-light">analyze {pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''}</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Chat History */}
          {chatHistory.length > 0 && (
            <>
              <div className="p-6 space-y-5 max-h-[500px] overflow-y-auto">
                {chatHistory.map((msg, idx) => (
                  <div key={idx}>
                    {msg.role === 'system' ? (
                      <div className="text-center text-xs text-gray-700 py-2 font-light">{msg.content}</div>
                    ) : msg.role === 'user' ? (
                      <div className="flex justify-end">
                        <div className="max-w-[70%] px-4 py-3 bg-white/10 border border-white/20 rounded-2xl text-sm text-gray-200">
                          {msg.content}
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] px-4 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm leading-relaxed text-gray-300">
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {analyzing && !processing && (
                  <div className="flex justify-start">
                    <div className="px-4 py-3 bg-white/5 border border-white/10 rounded-2xl">
                      <Loader2 className="w-4 h-4 text-gray-400 animate-spin" strokeWidth={1} />
                    </div>
                  </div>
                )}
              </div>

              {/* Chat Input */}
              <div className="p-4 border-t border-white/10">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={userMessage}
                    onChange={(e) => setUserMessage(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && !e.shiftKey && handleChat()}
                    placeholder="ask aria..."
                    className="flex-1 bg-white/5 border border-white/10 text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-white/20 placeholder-gray-700 text-gray-200 transition-colors"
                    disabled={analyzing}
                  />
                  <button
                    onClick={handleChat}
                    disabled={analyzing || !userMessage.trim()}
                    className="px-4 py-3 bg-white/10 hover:bg-white/15 border border-white/20 rounded-xl transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send className="w-4 h-4 text-gray-400" strokeWidth={1} />
                  </button>
                </div>
                
                <div className="flex items-center justify-between mt-3">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={analyzing}
                    className="text-xs text-gray-700 hover:text-gray-500 transition-colors font-light disabled:opacity-50"
                  >
                    + add more files
                  </button>
                  <button
                    onClick={resetConversation}
                    className="text-xs text-gray-700 hover:text-gray-500 transition-colors font-light"
                  >
                    new conversation
                  </button>
                </div>

                {/* Auto-analyze new files */}
                {pendingFiles.length > 0 && chatHistory.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {pendingFiles.map((file, idx) => (
                      <div key={idx} className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                        <div className="flex items-center gap-2">
                          <FileText className="w-3 h-3 text-gray-500" strokeWidth={1} />
                          <span className="text-xs text-gray-400">{file.name}</span>
                        </div>
                        <button onClick={() => removePendingFile(idx)} className="text-gray-600 hover:text-gray-400">
                          <X className="w-3 h-3" strokeWidth={1} />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={analyzeData}
                      disabled={analyzing}
                      className="w-full bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg py-2 px-3 text-xs text-gray-400 transition-all disabled:opacity-50"
                    >
                      {analyzing ? 'Analyzing...' : `Analyze ${pendingFiles.length} new file${pendingFiles.length > 1 ? 's' : ''}`}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="text-center mt-6 text-xs text-gray-800 font-light tracking-wider">
          powered by claude
        </div>
      </div>
    </div>
  );
}