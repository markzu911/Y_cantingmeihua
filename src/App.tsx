import React, { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, Wand2, Download, Loader2, CheckCircle2, AlertCircle, X, Key, Plus, Trash2, Coins } from 'lucide-react';
import { analyzeRestaurantImage, beautifyRestaurantImage, AnalysisResult } from './lib/gemini';

// Add type definition for window.aistudio
declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

interface SaasUserInfo {
  name: string;
  enterprise: string;
  integral: number;
}

interface SaasToolInfo {
  name: string;
  integral: number;
}

export default function App() {
  const [hasKey, setHasKey] = useState(true);
  const [originalImage, setOriginalImage] = useState<{ base64: string; mimeType: string; url: string } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  
  const [activeTab, setActiveTab] = useState<'analysis' | 'decor' | 'settings'>('analysis');
  const [options, setOptions] = useState({
    ratio: '1:1',
    lighting: '暖色调',
    resolution: '1K'
  });
  
  const [allowAdditions, setAllowAdditions] = useState(false);

  const [isBeautifying, setIsBeautifying] = useState(false);
  const [beautifiedImage, setBeautifiedImage] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // SaaS Integration State
  const [userId, setUserId] = useState<string | null>(null);
  const [toolId, setToolId] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<SaasUserInfo | null>(null);
  const [toolInfo, setToolInfo] = useState<SaasToolInfo | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle postMessage for SAAS_INIT
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === 'SAAS_INIT') {
        const { userId: uid, toolId: tid } = event.data;
        if (uid && uid !== "null" && uid !== "undefined") setUserId(uid);
        if (tid && tid !== "null" && tid !== "undefined") setToolId(tid);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Launch Phase: Get Initial Data
  useEffect(() => {
    const fetchLaunchData = async () => {
      if (!userId || !toolId) return;
      try {
        const response = await fetch('/api/tool/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const result = await response.json();
        if (result.success) {
          setUserInfo(result.data.user);
          setToolInfo(result.data.tool);
        }
      } catch (err) {
        console.error('Launch failed:', err);
      }
    };
    fetchLaunchData();
  }, [userId, toolId]);

  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio && window.aistudio.hasSelectedApiKey) {
        const has = await window.aistudio.hasSelectedApiKey();
        setHasKey(has);
      }
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio && window.aistudio.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasKey(true); // Assume success to avoid race condition
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const base64 = dataUrl.split(',')[1];
      setOriginalImage({
        base64,
        mimeType: file.type,
        url: dataUrl
      });
      setAnalysisResult(null);
      setBeautifiedImage(null);
      setHistory([]);
      setError(null);
      setActiveTab('analysis');
    };
    reader.readAsDataURL(file);
  };

  const handleAnalyze = async () => {
    if (!originalImage) return;
    
    // Verify Phase
    if (userId && toolId) {
      setIsAnalyzing(true);
      try {
        const verifyRes = await fetch('/api/tool/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          setError(verifyData.message || '积分不足');
          setIsAnalyzing(false);
          return;
        }
      } catch (err) {
        console.error('Verify failed:', err);
      }
    }

    setIsAnalyzing(true);
    setError(null);
    try {
      const result = await analyzeRestaurantImage(originalImage.base64, originalImage.mimeType);
      setAnalysisResult(result);
      if (result.recommendedLighting && ['暖色调', '清新浅色', '高端暗色'].includes(result.recommendedLighting)) {
        setOptions(prev => ({ ...prev, lighting: result.recommendedLighting }));
      }
    } catch (err: any) {
      setError(err.message || '分析失败，请重试');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleBeautify = async () => {
    if (!originalImage || !analysisResult) return;
    setIsBeautifying(true);
    setError(null);
    try {
      const resultImage = await beautifyRestaurantImage(
        originalImage.base64,
        originalImage.mimeType,
        analysisResult,
        options,
        allowAdditions
      );
      setBeautifiedImage(resultImage);
      setHistory(prev => [resultImage, ...prev]);

      // Consume Phase
      if (userId && toolId) {
        try {
          const consumeRes = await fetch('/api/tool/consume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, toolId })
          });
          const consumeData = await consumeRes.json();
          if (consumeData.success) {
            setUserInfo(prev => prev ? { ...prev, integral: consumeData.data.currentIntegral } : null);
          }
        } catch (err) {
          console.error('Consume failed:', err);
        }
      }
    } catch (err: any) {
      const errorMsg = err.message || '';
      if (errorMsg.includes('403') || errorMsg.includes('PERMISSION_DENIED') || errorMsg.includes('Requested entity was not found')) {
        setHasKey(false);
        setError('API Key 权限不足或未找到。请重新选择一个已启用计费的 Google Cloud 项目的 API Key。');
      } else {
        setError(errorMsg || '美化失败，请重试');
      }
    } finally {
      setIsBeautifying(false);
    }
  };

  const handleDownload = () => {
    if (!beautifiedImage) return;
    const a = document.createElement('a');
    a.href = beautifiedImage;
    a.download = 'beautified-restaurant.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handlePointChange = (index: number, value: string) => {
    if (!analysisResult) return;
    const newPoints = [...analysisResult.beautifyPoints];
    newPoints[index] = value;
    setAnalysisResult({ ...analysisResult, beautifyPoints: newPoints });
  };

  const handleAddPoint = () => {
    if (!analysisResult) return;
    setAnalysisResult({ ...analysisResult, beautifyPoints: [...analysisResult.beautifyPoints, ''] });
  };

  const handleDeletePoint = (index: number) => {
    if (!analysisResult) return;
    const newPoints = analysisResult.beautifyPoints.filter((_, i) => i !== index);
    setAnalysisResult({ ...analysisResult, beautifyPoints: newPoints });
  };

  const handleToggleAddition = (index: number) => {
    if (!analysisResult || !analysisResult.recommendedAdditions) return;
    const newAdditions = [...analysisResult.recommendedAdditions];
    newAdditions[index].enabled = !newAdditions[index].enabled;
    setAnalysisResult({ ...analysisResult, recommendedAdditions: newAdditions });
  };

  if (!hasKey) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans relative overflow-hidden">
        {/* Decorative background */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-100/50 rounded-full blur-3xl" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-violet-100/50 rounded-full blur-3xl" />
        
        <div className="bg-white/80 backdrop-blur-xl p-8 rounded-3xl shadow-xl shadow-slate-200/50 border border-white max-w-md w-full text-center relative z-10">
          <div className="w-16 h-16 bg-slate-100 text-slate-900 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-inner">
            <Key className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-3 tracking-tight">需要配置 API Key</h1>
          <p className="text-slate-600 mb-6 text-sm leading-relaxed">
            为了使用高质量的图像生成模型（gemini-3.1-flash-image-preview），您需要选择一个关联了计费的 Google Cloud 项目的 API Key。
            <br/><br/>
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-700 hover:underline font-medium transition-colors">
              了解关于计费的更多信息 &rarr;
            </a>
          </p>
          <button
            onClick={handleSelectKey}
            className="w-full py-3.5 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-medium transition-all shadow-md hover:shadow-lg active:scale-[0.98] flex items-center justify-center gap-2"
          >
            <Key className="w-5 h-5" />
            选择 API Key
          </button>
          {error && (
            <div className="mt-4 p-3 bg-red-50 text-red-700 text-sm rounded-xl border border-red-100 text-left">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans relative overflow-hidden">
      {/* Decorative background blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-blue-100/40 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-violet-100/40 rounded-full blur-3xl pointer-events-none" />

      <header className="bg-white/70 backdrop-blur-md border-b border-slate-200/80 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-slate-900 p-1.5 rounded-lg shadow-sm">
              <Wand2 className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">餐厅一键美化</h1>
          </div>

          <div className="flex items-center gap-4">
            {userInfo && (
              <div className="flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-2xl border border-slate-200">
                <Coins className="w-4 h-4 text-amber-500" />
                <span className="text-sm font-bold text-slate-700">积分: {userInfo.integral}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 relative z-10">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3 text-red-700 shadow-sm">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm font-medium">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column: Image Upload & Preview */}
          <div className="space-y-6">
            <div className="bg-white/80 backdrop-blur-xl p-6 lg:p-8 rounded-3xl shadow-xl shadow-slate-200/40 border border-white/60">
              <h2 className="text-lg font-bold mb-5 flex items-center gap-3 text-slate-800 tracking-tight">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 text-slate-700 text-sm shadow-inner">1</span>
                图片上传
              </h2>
              
              {!originalImage ? (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-slate-300 rounded-2xl p-12 flex flex-col items-center justify-center text-slate-500 hover:bg-slate-50/50 hover:border-slate-400 transition-all cursor-pointer group"
                >
                  <div className="bg-white p-4 rounded-full shadow-sm mb-4 group-hover:scale-105 transition-transform">
                    <Upload className="w-8 h-8 text-slate-400 group-hover:text-slate-600" />
                  </div>
                  <p className="text-sm font-semibold text-slate-700">点击上传餐厅图片</p>
                  <p className="text-xs mt-1.5 text-slate-400">支持 JPG, PNG 格式</p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="relative rounded-2xl overflow-hidden border border-slate-200/60 bg-slate-100/50 aspect-video flex items-center justify-center shadow-inner">
                    <img src={originalImage.url} alt="Original" className="max-w-full max-h-full object-contain" />
                    <button 
                      onClick={() => setOriginalImage(null)}
                      className="absolute top-3 right-3 bg-white/90 backdrop-blur-md text-slate-700 px-3.5 py-1.5 rounded-xl text-sm font-medium hover:bg-white shadow-sm hover:shadow transition-all"
                    >
                      重新上传
                    </button>
                  </div>
                  
                  {!analysisResult && (
                    <button
                      onClick={handleAnalyze}
                      disabled={isAnalyzing}
                      className="w-full py-3.5 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-medium flex items-center justify-center gap-2 transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-md hover:shadow-lg active:scale-[0.98]"
                    >
                      {isAnalyzing ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          AI 智能识别中...
                        </>
                      ) : (
                        <>
                          <Wand2 className="w-5 h-5" />
                          开始智能分析
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleImageUpload} 
                accept="image/*" 
                className="hidden" 
              />
            </div>

            {/* Output Image */}
            {beautifiedImage && (
              <div className="bg-white/80 backdrop-blur-xl p-6 lg:p-8 rounded-3xl shadow-xl shadow-slate-200/40 border border-white/60">
                <h2 className="text-lg font-bold mb-5 flex items-center gap-3 text-slate-800 tracking-tight">
                  <span className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 text-slate-700 text-sm shadow-inner">4</span>
                  图片输出
                </h2>
                <div 
                  className="relative rounded-2xl overflow-hidden border border-slate-200/60 bg-slate-100/50 aspect-video flex items-center justify-center group cursor-pointer shadow-inner"
                  onClick={() => setIsModalOpen(true)}
                >
                  <img src={beautifiedImage} alt="Beautified" className="max-w-full max-h-full object-contain group-hover:scale-[1.02] transition-transform duration-500 ease-out" />
                  <div className="absolute inset-0 bg-slate-900/0 group-hover:bg-slate-900/10 transition-colors duration-300 flex items-center justify-center">
                    <span className="opacity-0 group-hover:opacity-100 bg-white/95 text-slate-900 px-4 py-2 rounded-xl text-sm font-semibold shadow-lg transition-all duration-300 transform translate-y-2 group-hover:translate-y-0">点击放大查看</span>
                  </div>
                </div>
                <button
                  onClick={handleDownload}
                  className="mt-5 w-full py-3.5 px-4 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 rounded-2xl font-medium flex items-center justify-center gap-2 transition-all shadow-sm active:scale-[0.98]"
                >
                  <Download className="w-5 h-5" />
                  下载当前图片
                </button>
              </div>
            )}

            {/* History Gallery */}
            {history.length > 1 && (
              <div className="bg-white/80 backdrop-blur-xl p-6 lg:p-8 rounded-3xl shadow-xl shadow-slate-200/40 border border-white/60">
                <h2 className="text-sm font-bold text-slate-800 mb-4 tracking-tight">历史生成记录</h2>
                <div className="flex gap-3 overflow-x-auto pb-3 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
                  {history.map((img, idx) => (
                    <img
                      key={idx}
                      src={img}
                      alt={`Generated ${idx}`}
                      className={`h-24 w-24 object-cover rounded-2xl cursor-pointer border-2 transition-all shrink-0 ${beautifiedImage === img ? 'border-slate-900 shadow-md scale-100' : 'border-transparent hover:border-slate-300 opacity-70 hover:opacity-100 scale-95 hover:scale-100'}`}
                      onClick={() => setBeautifiedImage(img)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Analysis & Options */}
          <div className="space-y-6 lg:sticky lg:top-24 lg:h-[calc(100vh-8rem)]">
            {!analysisResult ? (
              <div className="bg-white/80 backdrop-blur-xl p-6 lg:p-8 rounded-3xl shadow-xl shadow-slate-200/40 border border-white/60 h-full min-h-[400px] flex items-center justify-center">
                <div className="text-slate-400 text-sm font-medium flex flex-col items-center gap-3">
                  <Wand2 className="w-8 h-8 opacity-50" />
                  请先上传图片并点击智能分析
                </div>
              </div>
            ) : (
              <div className="bg-white/80 backdrop-blur-xl p-6 lg:p-8 rounded-3xl shadow-xl shadow-slate-200/40 border border-white/60 flex flex-col h-full max-h-[800px] transition-all duration-500">
                {/* Tabs Header */}
                <div className="flex p-1.5 space-x-1 bg-slate-100/80 rounded-2xl mb-6 shrink-0">
                  <button 
                    onClick={() => setActiveTab('analysis')} 
                    className={`flex-1 py-2.5 text-sm font-bold rounded-xl transition-all ${activeTab === 'analysis' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                  >
                    基础分析
                  </button>
                  <button 
                    onClick={() => setActiveTab('decor')} 
                    className={`flex-1 py-2.5 text-sm font-bold rounded-xl transition-all ${activeTab === 'decor' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                  >
                    软装推荐
                  </button>
                  <button 
                    onClick={() => setActiveTab('settings')} 
                    className={`flex-1 py-2.5 text-sm font-bold rounded-xl transition-all ${activeTab === 'settings' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'}`}
                  >
                    输出设置
                  </button>
                </div>

                {/* Tab Content - Scrollable */}
                <div className="flex-1 overflow-y-auto pr-2 -mr-2 scrollbar-thin scrollbar-thumb-slate-200 scrollbar-track-transparent">
                  {activeTab === 'analysis' && (
                    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">餐厅布局</label>
                          <div className="w-full px-3.5 py-2.5 border border-slate-200/60 bg-white rounded-xl text-sm text-slate-700 whitespace-pre-wrap min-h-[2.5rem] shadow-sm">
                            {analysisResult.layout}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">装修风格</label>
                          <div className="w-full px-3.5 py-2.5 border border-slate-200/60 bg-white rounded-xl text-sm text-slate-700 whitespace-pre-wrap min-h-[2.5rem] shadow-sm">
                            {analysisResult.style}
                          </div>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">光影推荐理由</label>
                        <div className="w-full px-3.5 py-2.5 border border-slate-200/60 bg-white rounded-xl text-sm text-slate-700 whitespace-pre-wrap min-h-[2.5rem] shadow-sm">
                          {analysisResult.lightingReason}
                        </div>
                      </div>
                      <div className="pt-2">
                        <label className="block text-sm font-bold text-slate-800 mb-3">需要美化的点 <span className="text-xs font-normal text-slate-500 ml-1">(可修改/增删)</span></label>
                        <div className="space-y-2.5">
                          {analysisResult.beautifyPoints.map((point, idx) => (
                            <div key={idx} className="flex items-center gap-2 group">
                              <input 
                                type="text"
                                value={point}
                                onChange={(e) => handlePointChange(idx, e.target.value)}
                                className="flex-1 px-4 py-2.5 bg-white border border-slate-200/80 rounded-xl focus:ring-2 focus:ring-slate-900 focus:border-slate-900 text-sm shadow-sm transition-all"
                                placeholder="输入美化要求..."
                              />
                              <button 
                                onClick={() => handleDeletePoint(idx)}
                                className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors border border-transparent hover:border-red-100 opacity-0 group-hover:opacity-100 focus:opacity-100"
                                title="删除"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={handleAddPoint}
                            className="w-full py-3 border-2 border-dashed border-slate-200 rounded-xl text-sm font-medium text-slate-500 hover:border-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-all flex items-center justify-center gap-1.5 mt-3"
                          >
                            <Plus className="w-4 h-4" /> 添加美化点
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === 'decor' && (
                    <div className="space-y-5 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="flex items-center justify-between bg-slate-50 p-4 rounded-2xl border border-slate-200/60">
                        <div>
                          <h3 className="text-sm font-bold text-slate-800">开启智能软装</h3>
                          <p className="text-xs text-slate-500 mt-1">允许 AI 在画面中添加推荐的装饰物</p>
                        </div>
                        <button 
                          onClick={() => setAllowAdditions(!allowAdditions)} 
                          className={`w-12 h-6 rounded-full transition-colors relative shadow-inner shrink-0 ${allowAdditions ? 'bg-slate-900' : 'bg-slate-300'}`}
                        >
                          <div className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform shadow-sm ${allowAdditions ? 'translate-x-6.5' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                      
                      {allowAdditions ? (
                        <div className="space-y-3">
                          <p className="text-xs text-slate-500 font-medium mb-3 px-1">AI 推荐了以下装饰，您可以单独开启或关闭：</p>
                          {analysisResult?.recommendedAdditions?.map((add, idx) => (
                            <div key={idx} className={`flex items-center justify-between p-4 rounded-2xl border transition-all ${add.enabled ? 'bg-white border-slate-300 shadow-sm' : 'bg-slate-50 border-slate-200 opacity-60'}`}>
                              <div className="pr-4">
                                <div className={`text-sm font-bold ${add.enabled ? 'text-slate-800' : 'text-slate-500'}`}>{add.item}</div>
                                <div className="text-xs text-slate-500 mt-1 leading-relaxed">{add.reason}</div>
                              </div>
                              <button 
                                onClick={() => handleToggleAddition(idx)}
                                className={`shrink-0 w-10 h-5 rounded-full transition-colors relative shadow-inner ${add.enabled ? 'bg-indigo-500' : 'bg-slate-300'}`}
                              >
                                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-transform shadow-sm ${add.enabled ? 'translate-x-5.5' : 'translate-x-0.5'}`} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-sm text-slate-500 bg-slate-50 p-4 rounded-2xl border border-slate-200/60 text-center py-8">
                          已关闭软装推荐。<br/>AI 将严格保持原有物品，不会添加新物件。
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'settings' && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">图片比例</label>
                        <div className="flex flex-wrap gap-2.5">
                          {['1:1', '3:4', '4:3', '9:16', '16:9'].map(ratio => (
                            <button
                              key={ratio}
                              onClick={() => setOptions({...options, ratio})}
                              className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all border ${options.ratio === ratio ? 'bg-slate-900 border-slate-900 text-white shadow-md' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'}`}
                            >
                              {ratio}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">光影效果</label>
                        <div className="flex flex-wrap gap-2.5">
                          {['暖色调', '清新浅色', '高端暗色'].map(lighting => (
                            <button
                              key={lighting}
                              onClick={() => setOptions({...options, lighting})}
                              className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all border ${options.lighting === lighting ? 'bg-slate-900 border-slate-900 text-white shadow-md' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'}`}
                            >
                              {lighting}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">清晰度</label>
                        <div className="flex flex-wrap gap-2.5">
                          {['1K', '2K', '4K'].map(res => (
                            <button
                              key={res}
                              onClick={() => setOptions({...options, resolution: res})}
                              className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all border ${options.resolution === res ? 'bg-slate-900 border-slate-900 text-white shadow-md' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'}`}
                            >
                              {res}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Fixed Footer with Beautify Button */}
                <div className="pt-5 mt-4 border-t border-slate-200/60 shrink-0">
                  <button
                    onClick={handleBeautify}
                    disabled={isBeautifying || !analysisResult}
                    className="w-full py-4 px-4 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl font-semibold flex items-center justify-center gap-2.5 transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-lg hover:shadow-xl active:scale-[0.98] text-base tracking-wide"
                  >
                    {isBeautifying ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        智能美化中...
                      </>
                    ) : (
                      <>
                        <ImageIcon className="w-5 h-5" />
                        一键美化
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Image Modal */}
      {isModalOpen && beautifiedImage && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 sm:p-8"
          onClick={() => setIsModalOpen(false)}
        >
          <button 
            className="absolute top-4 right-4 text-white/70 hover:text-white p-2 transition-colors"
            onClick={() => setIsModalOpen(false)}
          >
            <X className="w-8 h-8" />
          </button>
          <img 
            src={beautifiedImage} 
            alt="Beautified Enlarged" 
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
