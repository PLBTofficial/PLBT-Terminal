import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Sparkles,
  Play,
  RotateCcw,
  Sliders,
  Copy,
  Check,
  History,
  Trash2,
  Clock,
  Cpu,
  Download,
  AlertTriangle,
  Code,
  BookOpen,
  PenTool,
  Bookmark,
  ExternalLink,
  ChevronRight,
  Share2,
  Terminal,
  Layers,
  Lock
} from 'lucide-react';

interface HistoryItem {
  id: string;
  prompt: string;
  systemInstruction: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  model: string;
  response: {
    text: string;
    duration: number;
    modelUsed: string;
    timestamp: string;
  };
}

interface Preset {
  id: string;
  name: string;
  icon: any;
  category: string;
  prompt: string;
  systemInstruction: string;
  temperature: number;
}

export default function App() {
  // Auth State (Защита паролем)
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('plbt_auth') === 'true';
  });
  const [passwordInput, setPasswordInput] = useState('');
  const [authError, setAuthError] = useState(false);
  // Пароль задаётся через переменную окружения VITE_APP_PASSWORD (см. .env.example).
  // Если она не задана, вход по паролю отключён (доступ будет запрещён).
  const CORRECT_PASSWORD = import.meta.env.VITE_APP_PASSWORD || '';

  // Config States
  const [prompt, setPrompt] = useState('');
  const [systemInstruction, setSystemInstruction] = useState('You are an expert, highly precise AI assistant and engineering architect. Maintain structured markdown formatting, elegant code syntax, and clear logic in all outputs.');
  const [temperature, setTemperature] = useState(1.0);
  const [topP, setTopP] = useState(0.95);
  const [maxOutputTokens, setMaxOutputTokens] = useState(2048);
  const [selectedModel, setSelectedModel] = useState('gemini-3.5-flash');

  // App Lifecycle States
  const [isGenerating, setIsGenerating] = useState(false);
  const [response, setResponse] = useState<HistoryItem['response'] | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [secretsConfigured, setSecretsConfigured] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState<'response' | 'payload' | 'prompt'>('response');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Preset Library
  const PRESETS: Preset[] = [
    {
      id: 'tailwind-component',
      name: 'Tailwind UI Specialist',
      icon: Code,
      category: 'UI & Frontend',
      prompt: 'Create a fully responsive, modern bento-grid feature showcase section using React and Tailwind CSS v4. Include micro-interactions, subtle shadows, custom gradients, and smooth slide-in entry styles.',
      systemInstruction: 'You are a staff-level UI/UX designer and frontend engineer specializing in Tailwind CSS. Output complete, fully production-ready React components with standard imports. Format using clean, well-spaced code structures.',
      temperature: 0.7,
    },
    {
      id: 'algorithm-optimizer',
      name: 'Algorithmic Architect',
      icon: Cpu,
      category: 'Performance',
      prompt: 'Refactor this algorithm to optimize its space and time complexity from O(N^2) to O(N log N) using divide-and-conquer or dynamic programming. Document the precise performance improvements.',
      systemInstruction: 'You are an expert algorithm designer and systems engineer. Analyze computational complexity with scientific rigor. Provide concise explanation followed by optimized TS/JS or Go implementations.',
      temperature: 0.2,
    },
    {
      id: 'system-prompt-designer',
      name: 'Prompt Engineer',
      icon: Sparkles,
      category: 'AI Design',
      prompt: 'Generate an elite, hyper-specific system instruction prompt for an AI agent designed to tutor high-school students in advanced physical chemistry using Socratic inquiry.',
      systemInstruction: 'You are an elite prompt engineering specialist. Design hierarchical, rule-based system instructions with XML tags, clear role boundaries, and behavior fallbacks.',
      temperature: 0.9,
    },
    {
      id: 'copy-email',
      name: 'Creative Product Launch',
      icon: PenTool,
      category: 'Copywriting',
      prompt: 'Draft a sequence of 3 warm, highly-converting launch emails for "ZenPulse", a minimalist ambient meditation timer and focus tracker. Focus on mindfulness, distraction-free space, and value.',
      systemInstruction: 'You are an inspiring, warm, and highly persuasive writer. Avoid typical tech-marketing hype or clickbait. Speak with deep sincerity, calm clarity, and absolute elegance.',
      temperature: 1.1,
    }
  ];

  // Load History & Check API Key status
  useEffect(() => {
    if (!isAuthenticated) return;

    // History
    const stored = localStorage.getItem('gemini_prompt_history');
    if (stored) {
      try {
        setHistory(JSON.parse(stored));
      } catch (e) {
        console.error('Failed to parse prompt history', e);
      }
    }

    // Secrets check
    fetch('/api/secrets-check')
      .then((res) => res.json())
      .then((data) => {
        setSecretsConfigured(data.configured);
      })
      .catch((err) => {
        console.error('Failed to check secrets', err);
        setSecretsConfigured(false);
      });
  }, [isAuthenticated]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === CORRECT_PASSWORD) {
      localStorage.setItem('plbt_auth', 'true');
      setIsAuthenticated(true);
    } else {
      setAuthError(true);
    }
  };

  // Экран ввода пароля, если пользователь еще не авторизован
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <form onSubmit={handleLogin} className="bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-2xl w-full max-w-md text-center backdrop-blur-md">
          <div className="mx-auto w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-4">
            <Lock className="w-6 h-6" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 mb-1">Доступ ограничен</h2>
          <p className="text-xs text-slate-400 mb-6 font-mono">Введите пароль для входа в терминал</p>
          
          <input
            type="password"
            value={passwordInput}
            onChange={(e) => { setPasswordInput(e.target.value); setAuthError(false); }}
            placeholder="Секретный пароль"
            className="w-full bg-slate-950 border border-slate-800 focus:border-amber-500 focus:outline-none rounded-xl px-4 py-3 text-sm text-slate-200 placeholder:text-slate-600 mb-3"
            autoFocus
          />
          
          {authError && (
            <p className="text-xs text-red-400 mb-3 font-mono">Неверный пароль!</p>
          )}

          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-400 text-slate-950 font-bold text-xs font-mono uppercase tracking-wider hover:opacity-90 transition-all shadow-lg shadow-amber-500/10 cursor-pointer"
          >
            Войти в систему
          </button>
        </form>
      </div>
    );
  }

  const saveHistory = (newHistory: HistoryItem[]) => {
    setHistory(newHistory);
    localStorage.setItem('gemini_prompt_history', JSON.stringify(newHistory));
  };

  const handleCopy = (text: string, id: string = 'main') => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const loadPreset = (preset: Preset) => {
    setPrompt(preset.prompt);
    setSystemInstruction(preset.systemInstruction);
    setTemperature(preset.temperature);
  };

  const handleClearWorkspace = () => {
    setPrompt('');
    setSystemInstruction('');
    setTemperature(1.0);
    setTopP(0.95);
    setResponse(null);
  };

  const handleExecute = async () => {
    if (!prompt.trim()) return;

    setIsGenerating(true);
    setResponse(null);
    setStatusMessage('Initiating context frame...');

    const statuses = [
      'Configuring model hyper-parameters...',
      'Synthesizing system instructions...',
      'Routing query to Gemini secure core...',
      'Gemini is thinking...',
      'Refining final output token stream...'
    ];

    let statusIndex = 0;
    const interval = setInterval(() => {
      if (statusIndex < statuses.length) {
        setStatusMessage(statuses[statusIndex]);
        statusIndex++;
      }
    }, 1200);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          systemInstruction,
          temperature,
          topP,
          maxOutputTokens,
          model: selectedModel,
        }),
      });

      clearInterval(interval);

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Server error during generation.');
      }

      const data = await res.json();
      const newResponse = {
        text: data.text,
        duration: data.duration,
        modelUsed: data.modelUsed,
        timestamp: data.timestamp,
      };

      setResponse(newResponse);

      // Create history item
      const historyItem: HistoryItem = {
        id: Math.random().toString(36).substring(2, 9),
        prompt,
        systemInstruction,
        temperature,
        topP,
        maxOutputTokens,
        model: selectedModel,
        response: newResponse,
      };

      saveHistory([historyItem, ...history.slice(0, 49)]);
    } catch (err: any) {
      clearInterval(interval);
      console.error(err);
      setResponse({
        text: `⚠️ ERROR EXECUTING GEMINI PROMPT:\n\n${err.message || 'An unknown network error occurred.'}\n\nPlease check that your GEMINI_API_KEY is configured in your secrets (Settings > Secrets panel in AI Studio) and that you are connected to the internet.`,
        duration: 0,
        modelUsed: selectedModel,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setIsGenerating(false);
      setStatusMessage('');
    }
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = history.filter((item) => item.id !== id);
    saveHistory(filtered);
  };

  const loadHistoryItem = (item: HistoryItem) => {
    setPrompt(item.prompt);
    setSystemInstruction(item.systemInstruction);
    setTemperature(item.temperature);
    setTopP(item.topP);
    setMaxOutputTokens(item.maxOutputTokens);
    setSelectedModel(item.model);
    setResponse(item.response);
  };

  const exportWorkspaceConfig = () => {
    const config = {
      model: selectedModel,
      systemInstruction,
      temperature,
      topP,
      maxOutputTokens,
      prompt,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gemini-prompt-config-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseMarkdown = (text: string) => {
    if (!text) return '';
    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts.map((part, index) => {
      if (part.startsWith('```')) {
        const lines = part.split('\n');
        const firstLine = lines[0].replace('```', '').trim();
        const lang = firstLine || 'code';
        const code = lines.slice(1, -1).join('\n');

        return (
          <div key={index} className="my-5 border border-slate-800 rounded-lg overflow-hidden bg-slate-950 font-mono text-sm shadow-md">
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800 text-xs text-slate-400">
              <span className="uppercase font-semibold tracking-wider text-amber-500/80">{lang}</span>
              <button
                onClick={() => handleCopy(code, `code-${index}`)}
                className="flex items-center gap-1.5 hover:text-slate-200 transition-colors py-1 px-2 rounded hover:bg-slate-800 cursor-pointer"
              >
                {copiedId === `code-${index}` ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400 font-medium">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy code</span>
                  </>
                )}
              </button>
            </div>
            <pre className="p-4 overflow-x-auto text-slate-300 select-text font-mono leading-relaxed max-h-[450px]">
              <code>{code}</code>
            </pre>
          </div>
        );
      }

      const lines = part.split('\n');
      const renderedLines = lines.map((line, lineIdx) => {
        const trimmed = line.trim();

        if (trimmed.startsWith('### ')) {
          return <h4 key={lineIdx} className="text-base font-bold text-slate-100 mt-5 mb-2 flex items-center gap-1"><ChevronRight className="w-4 h-4 text-amber-400 inline" /> {trimmed.substring(4)}</h4>;
        }
        if (trimmed.startsWith('## ')) {
          return <h3 key={lineIdx} className="text-lg font-bold text-slate-100 mt-6 mb-3 border-b border-slate-800 pb-1.5">{trimmed.substring(3)}</h3>;
        }
        if (trimmed.startsWith('# ')) {
          return <h2 key={lineIdx} className="text-xl font-bold text-slate-50 mt-6 mb-4">{trimmed.substring(2)}</h2>;
        }
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          return (
            <li key={lineIdx} className="ml-5 list-disc text-slate-300 my-1 text-sm leading-relaxed">
              {renderInlineStyles(trimmed.substring(2))}
            </li>
          );
        }
        const matchNumbered = trimmed.match(/^(\d+)\.\s(.*)/);
        if (matchNumbered) {
          return (
            <li key={lineIdx} className="ml-5 list-decimal text-slate-300 my-1 text-sm leading-relaxed">
              {renderInlineStyles(matchNumbered[2])}
            </li>
          );
        }
        if (trimmed.startsWith('> ')) {
          return (
            <blockquote key={lineIdx} className="border-l-4 border-amber-500/75 bg-slate-900/40 px-4 py-2 my-3 rounded-r text-sm italic text-slate-300 leading-relaxed">
              {renderInlineStyles(trimmed.substring(2))}
            </blockquote>
          );
        }
        if (trimmed === '') {
          return <div key={lineIdx} className="h-2" />;
        }
        return (
          <p key={lineIdx} className="text-sm text-slate-300 leading-relaxed mb-1.5">
            {renderInlineStyles(line)}
          </p>
        );
      });

      return <div key={index} className="space-y-1">{renderedLines}</div>;
    });
  };

  const renderInlineStyles = (raw: string) => {
    const parts = raw.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return parts.map((part, idx) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={idx} className="bg-slate-950 text-amber-400 font-mono text-xs px-1.5 py-0.5 rounded border border-slate-800/60 mx-0.5">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={idx} className="font-bold text-slate-50">
            {part.slice(2, -2)}
          </strong>
        );
      }
      if (part.startsWith('*') && part.endsWith('*')) {
        return (
          <em key={idx} className="italic text-slate-200">
            {part.slice(1, -1)}
          </em>
        );
      }
      return part;
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased selection:bg-amber-500/30 selection:text-white">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-tr from-amber-500 to-yellow-400 text-slate-950 shadow-md shadow-amber-500/10">
            <Sparkles className="w-5.5 h-5.5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-slate-50 to-slate-200 bg-clip-text text-transparent">
              Gemini Prompt Studio
            </h1>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest font-mono">
              Elite Prompt Engineering Environment
            </p>
          </div>
        </div>

        {/* API Secrets Status Widget */}
        <div className="flex items-center gap-3">
          {secretsConfigured === false && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-950/40 border border-red-800/50 text-[11px] text-red-300">
              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
              <span>Missing API Key: Add GEMINI_API_KEY in Settings &gt; Secrets</span>
            </div>
          )}
          {secretsConfigured === true && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/30 border border-emerald-800/40 text-[11px] text-emerald-400 font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>Gemini Cloud Connected</span>
            </div>
          )}
          <button
            onClick={exportWorkspaceConfig}
            className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 transition-all font-mono cursor-pointer"
            title="Download prompt & model parameters config"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Config</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Frame */}
      <main className="flex-1 max-w-[1700px] w-full mx-auto grid grid-cols-1 xl:grid-cols-12 gap-6 p-6">
        
        {/* Left Control Panel (Columns 1-4) */}
        <section className="xl:col-span-4 flex flex-col gap-6" id="control-panel">
          
          {/* Model Selection & Parameters Card */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-4">
              <Sliders className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-semibold text-slate-200">Model Configuration</h2>
            </div>

            <div className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Selected Core Model</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSelectedModel('gemini-3.5-flash')}
                    className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all text-left flex flex-col justify-between cursor-pointer ${
                      selectedModel === 'gemini-3.5-flash'
                        ? 'bg-amber-500/10 border-amber-500/60 text-amber-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span className="font-mono text-[10px] tracking-wide uppercase">⚡ Flash Core</span>
                    <span className="text-[11px] mt-1 text-slate-200">gemini-3.5-flash</span>
                  </button>

                  <button
                    onClick={() => setSelectedModel('gemini-3.1-pro-preview')}
                    className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all text-left flex flex-col justify-between cursor-pointer ${
                      selectedModel === 'gemini-3.1-pro-preview'
                        ? 'bg-amber-500/10 border-amber-500/60 text-amber-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span className="font-mono text-[10px] tracking-wide uppercase">🧠 Reasoning Pro</span>
                    <span className="text-[11px] mt-1 text-slate-200">gemini-3.1-pro</span>
                  </button>
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-semibold text-slate-400">Temperature (Creativity)</label>
                  <span className="text-xs font-mono font-medium text-amber-400">{temperature.toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value))}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-semibold text-slate-400">Top-P (Nucleus Sampling)</label>
                  <span className="text-xs font-mono font-medium text-amber-400">{topP.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value))}
                  className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Max Target Tokens</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min="1"
                    max="8192"
                    value={maxOutputTokens}
                    onChange={(e) => setMaxOutputTokens(parseInt(e.target.value) || 1024)}
                    className="flex-1 bg-slate-950 border border-slate-800 focus:border-amber-500 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 focus:outline-none"
                  />
                  <div className="flex items-center gap-1">
                    {[512, 1024, 2048, 4096].map((size) => (
                      <button
                        key={size}
                        onClick={() => setMaxOutputTokens(size)}
                        className={`px-2 py-1.5 rounded bg-slate-950 border text-[10px] font-mono transition-colors cursor-pointer ${
                          maxOutputTokens === size
                            ? 'border-amber-500/50 text-amber-400 bg-amber-500/5'
                            : 'border-slate-800 text-slate-500 hover:border-slate-700 hover:text-slate-300'
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* System Instructions Panel */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm flex-1 flex flex-col min-h-[250px]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-amber-500" />
                <h2 className="text-sm font-semibold text-slate-200">System Instructions</h2>
              </div>
              <button
                onClick={() => setSystemInstruction('')}
                className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
              >
                Clear
              </button>
            </div>
            <textarea
              value={systemInstruction}
              onChange={(e) => setSystemInstruction(e.target.value)}
              placeholder="Inject core personality, output rules, formatting guides, or developer behaviors..."
              className="flex-1 w-full bg-slate-950 border border-slate-800 focus:border-amber-500 focus:outline-none rounded-lg p-3 text-xs leading-relaxed text-slate-300 font-mono resize-none placeholder:text-slate-600"
            />
          </div>
        </section>

        {/* Center Playboard Panel (Columns 5-9) */}
        <section className="xl:col-span-5 flex flex-col gap-6" id="playboard">
          
          {/* Preset Librarians Quick Load */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-3">
              <BookOpen className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-semibold text-slate-200 font-sans">Prompt Blueprint Library</h2>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              {PRESETS.map((preset) => {
                const IconComponent = preset.icon;
                return (
                  <button
                    key={preset.id}
                    onClick={() => loadPreset(preset)}
                    className="p-3 text-left bg-slate-950/70 border border-slate-800/80 rounded-lg hover:border-amber-500/50 hover:bg-amber-500/[0.02] group transition-all cursor-pointer"
                  >
                    <div className="flex items-center gap-2 text-slate-300 font-medium group-hover:text-amber-400 transition-colors">
                      <IconComponent className="w-3.5 h-3.5" />
                      <span className="text-xs font-semibold">{preset.name}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1 line-clamp-1 group-hover:text-slate-400 transition-colors">
                      {preset.prompt}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Prompt Playground */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm flex-1 flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono">WORKSPACE CORE PROMPT</span>
              <button
                onClick={handleClearWorkspace}
                className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors py-0.5 px-1.5 rounded hover:bg-slate-800/50 font-mono cursor-pointer"
              >
                Reset Workspace
              </button>
            </div>

            <div className="flex-1 flex flex-col relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Compose your high-fidelity prompt template here..."
                className="flex-1 w-full bg-slate-950 border border-slate-800 focus:border-amber-500 focus:outline-none rounded-xl p-4 text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 resize-none min-h-[220px]"
              />
              
              <div className="flex items-center justify-between mt-4">
                <span className="text-[11px] text-slate-500 font-mono">
                  {prompt.length} characters
                </span>

                <button
                  onClick={handleExecute}
                  disabled={isGenerating || !prompt.trim()}
                  className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-xs font-bold font-mono tracking-wider transition-all select-none ${
                    isGenerating
                      ? 'bg-amber-500/10 text-amber-500 border border-amber-500/25 cursor-not-allowed'
                      : !prompt.trim()
                      ? 'bg-slate-800 border border-slate-700 text-slate-500 cursor-not-allowed'
                      : 'bg-gradient-to-tr from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 shadow-lg shadow-amber-500/15 font-semibold hover:scale-[1.02] cursor-pointer'
                  }`}
                >
                  {isGenerating ? (
                    <>
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" />
                      <span>STREAMING IN...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-slate-950" />
                      <span>RUN COMPILER</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Right Output Console Panel (Columns 10-12) */}
        <section className="xl:col-span-3 flex flex-col gap-6" id="output-console">
          
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5 shadow-lg backdrop-blur-sm flex-1 flex flex-col overflow-hidden max-h-[400px] xl:max-h-[550px]">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-amber-500" />
                <h2 className="text-sm font-semibold text-slate-200">Execution History Log</h2>
              </div>
              <span className="text-[10px] bg-slate-950 px-2 py-0.5 rounded border border-slate-800 text-slate-400 font-mono">
                {history.length} runs
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 text-xs">
              {history.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-600 p-4 text-center">
                  <Terminal className="w-8 h-8 mb-2 stroke-1" />
                  <p className="font-mono text-[11px]">No compiled prompt outputs detected.</p>
                </div>
              ) : (
                history.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => loadHistoryItem(item)}
                    className="p-3 bg-slate-950 border border-slate-800 hover:border-slate-700 hover:bg-slate-900/40 rounded-lg group transition-all cursor-pointer relative"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-mono font-medium text-amber-500/80">
                        {item.model.replace('gemini-', '')}
                      </span>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={(e) => deleteHistoryItem(item.id, e)}
                          className="text-slate-500 hover:text-red-400 p-1 rounded hover:bg-slate-800 cursor-pointer"
                          title="Delete history item"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    <p className="text-slate-300 line-clamp-2 mt-1.5 leading-relaxed font-sans font-normal">
                      {item.prompt}
                    </p>
                    <div className="flex items-center gap-3 text-[9px] text-slate-500 font-mono mt-2">
                      <span className="flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        {(item.response.duration / 1000).toFixed(2)}s
                      </span>
                      <span>
                        {new Date(item.response.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            {history.length > 0 && (
              <button
                onClick={() => {
                  if (confirm('Clear execution history?')) saveHistory([]);
                }}
                className="mt-4 w-full py-2 border border-dashed border-slate-800 text-slate-500 hover:text-red-400 hover:border-red-950/50 hover:bg-red-950/10 transition-colors font-mono text-[10px] text-center rounded-lg cursor-pointer"
              >
                Clear Log History
              </button>
            )}
          </div>
        </section>

      </main>

      {/* Persistent Bottom Drawer / Response Section */}
      <section className="max-w-[1700px] w-full mx-auto p-6 pt-0" id="response-terminal">
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden shadow-2xl backdrop-blur-sm min-h-[350px] flex flex-col">
          
          <div className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider font-mono">COMPILER RESPONSE TERMINAL</span>
              {response && (
                <div className="flex items-center gap-3 text-[11px] font-mono">
                  <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-400 flex items-center gap-1">
                    <Cpu className="w-3 h-3" />
                    {response.modelUsed}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {response.duration} ms
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 p-1 rounded-lg">
              <button
                onClick={() => setActiveTab('response')}
                className={`px-3 py-1.5 rounded-md text-xs font-mono tracking-wide transition-all cursor-pointer ${
                  activeTab === 'response'
                    ? 'bg-slate-800 text-slate-100 font-semibold border border-slate-700/50'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Rendered Output
              </button>
              <button
                onClick={() => setActiveTab('payload')}
                className={`px-3 py-1.5 rounded-md text-xs font-mono tracking-wide transition-all cursor-pointer ${
                  activeTab === 'payload'
                    ? 'bg-slate-800 text-slate-100 font-semibold border border-slate-700/50'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Inspect Spec JSON
              </button>
              <button
                onClick={() => setActiveTab('prompt')}
                className={`px-3 py-1.5 rounded-md text-xs font-mono tracking-wide transition-all cursor-pointer ${
                  activeTab === 'prompt'
                    ? 'bg-slate-800 text-slate-100 font-semibold border border-slate-700/50'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Request Frame
              </button>
            </div>
          </div>

          <div className="flex-1 bg-slate-950/80 p-6 overflow-y-auto max-h-[600px] select-text">
            {isGenerating ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-500 select-none">
                <div className="relative mb-6">
                  <div className="w-12 h-12 rounded-full border-2 border-dashed border-amber-500/40 animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-amber-500 animate-pulse" />
                  </div>
                </div>
                <p className="font-mono text-sm text-slate-400 tracking-wide animate-pulse">{statusMessage}</p>
              </div>
            ) : !response ? (
              <div className="flex flex-col items-center justify-center py-20 text-slate-600 select-none text-center">
                <Terminal className="w-10 h-10 mb-3 stroke-1 text-slate-700" />
                <p className="font-mono text-sm tracking-wide text-slate-500">Terminal awaiting instructions...</p>
              </div>
            ) : (
              <AnimatePresence mode="wait">
                {activeTab === 'response' && (
                  <motion.div
                    key="tab-response"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="max-w-4xl mx-auto"
                  >
                    <div className="flex items-center justify-between mb-4 border-b border-slate-900 pb-3">
                      <span className="text-[11px] font-mono text-slate-500">OUTPUT BUFFER DECODED</span>
                      <button
                        onClick={() => handleCopy(response.text, 'main-response')}
                        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 transition-colors hover:bg-slate-900/50 py-1 px-2.5 rounded-md border border-slate-900 cursor-pointer"
                      >
                        {copiedId === 'main-response' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400 font-semibold font-mono text-[11px]">COPIED</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span className="font-mono text-[11px]">COPY STREAM</span>
                          </>
                        )}
                      </button>
                    </div>
                    
                    <div className="prose prose-invert prose-slate max-w-none text-slate-300 font-sans leading-relaxed tracking-wide space-y-2">
                      {parseMarkdown(response.text)}
                    </div>
                  </motion.div>
                )}

                {activeTab === 'payload' && (
                  <motion.div
                    key="tab-payload"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="max-w-4xl mx-auto"
                  >
                    <div className="flex items-center justify-between mb-4 border-b border-slate-900 pb-3">
                      <span className="text-[11px] font-mono text-slate-500 font-semibold">API RESPONSE PAYLOAD INTERFACE SPEC</span>
                      <button
                        onClick={() => handleCopy(JSON.stringify(response, null, 2), 'spec-json')}
                        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100 transition-colors hover:bg-slate-900/50 py-1 px-2.5 rounded-md border border-slate-900 cursor-pointer"
                      >
                        {copiedId === 'spec-json' ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-emerald-400 font-semibold font-mono text-[11px]">COPIED</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span className="font-mono text-[11px]">COPY SPEC</span>
                          </>
                        )}
                      </button>
                    </div>
                    <pre className="text-xs font-mono text-amber-500/90 leading-relaxed overflow-x-auto p-4 bg-slate-950 border border-slate-900 rounded-lg max-h-[500px]">
                      {JSON.stringify({
                        status: "200 OK",
                        headers: {
                          "content-type": "application/json",
                          "x-goog-service": "gemini-developer-platform"
                        },
                        data: {
                          model: response.modelUsed,
                          latencyMs: response.duration,
                          timestamp: response.timestamp,
                          payload: {
                            text: response.text
                          }
                        }
                      }, null, 2)}
                    </pre>
                  </motion.div>
                )}

                {activeTab === 'prompt' && (
                  <motion.div
                    key="tab-prompt"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="max-w-4xl mx-auto"
                  >
                    <div className="flex items-center justify-between mb-4 border-b border-slate-900 pb-3">
                      <span className="text-[11px] font-mono text-slate-500">REQUEST SPEC FRAME</span>
                    </div>
                    <pre className="text-xs font-mono text-slate-400 leading-relaxed overflow-x-auto p-4 bg-slate-950 border border-slate-900 rounded-lg max-h-[500px]">
                      {`POST /v1beta/models/${selectedModel}:generateContent HTTP/1.1`}
                    </pre>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}