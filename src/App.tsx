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
  const [originalImage, setOriginalImage] = useState<{ base64: string; mimeType: string; url: string; saasUrl?: string } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'analysis' | 'decor' | 'settings'>('analysis');
  const [options, setOptions] = useState({
    ratio: '1:1',
    lighting: '暖色调',
    resolution: '1K'
  });
  
  const [allowAdditions, setAllowAdditions] = useState(false);

  const [isBeautifying, setIsBeautifying] = useState(false);
  const [beautifyProgress, setBeautifyProgress] = useState(0);
  const [beautifyMessage, setBeautifyMessage] = useState('');
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

    setIsUploading(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxSide = 3072;

        if (width > height) {
          if (width > maxSide) {
            height *= maxSide / width;
            width = maxSide;
          }
        } else {
          if (height > maxSide) {
            width *= maxSide / height;
            height = maxSide;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
        }

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
        const base64 = compressedDataUrl.split(',')[1];
        
        // Immediately set original image for preview
        setOriginalImage({
          base64,
          mimeType: 'image/jpeg',
          url: compressedDataUrl
        });
        
        setAnalysisResult(null);
        setBeautifiedImage(null);
        setHistory([]);
        setError(null);
        setActiveTab('analysis');
        setIsUploading(false);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleAnalyze = async () => {
    if (!originalImage) return;
    
    setIsAnalyzing(true);
    setError(null);
    try {
      // Use saasUrl if available to keep request body small
      const result = await analyzeRestaurantImage(
        originalImage.saasUrl ? null : originalImage.base64, 
        originalImage.saasUrl ? null : originalImage.mimeType, 
        userId, 
        toolId,
        originalImage.saasUrl
      );
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
    setBeautifyProgress(0);
    setBeautifyMessage('正在初始化...');
    setError(null);
    try {
      const result = await beautifyRestaurantImage(
        originalImage.saasUrl ? null : originalImage.base64,
        originalImage.saasUrl ? null : originalImage.mimeType,
        analysisResult,
        options,
        allowAdditions,
        userId,
        toolId,
        originalImage.saasUrl,
        (progress, message) => {
          setBeautifyProgress(progress);
          setBeautifyMessage(message);
        }
      );
      
      const { image: saasImage } = result;
      if (saasImage?.url) {
        setBeautifiedImage(saasImage.url);
        setHistory(prev => [saasImage.url, ...prev]);
      } else {
        throw new Error('美化成功但未返回图片链接');
      }

      // Refresh integral after generation
      if (userId && toolId) {
        setTimeout(() => {
          fetch('/api/tool/launch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, toolId })
          }).then(r => r.json())
            .then(res => {
              if (res.success) setUserInfo(res.data.user);
            }).catch(console.error);
        }, 1000);
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
      setBeautifyProgress(0);
      setBeautifyMessage('');
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
      <div className="min-h-screen bg-[#FDFCFB] flex items-center justify-center p-4 font-sans relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-[#E8EDE7] rounded-full blur-[120px] opacity-60" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-[#F5EDE6] rounded-full blur-[120px] opacity-60" />
        
        <div className="bg-white/40 backdrop-blur-2xl p-10 rounded-[2.5rem] shadow-[0_20px_50px_rgba(141,163,153,0.1)] border border-white/60 max-w-md w-full text-center relative z-10">
          <div className="w-16 h-16 bg-[#F2F0ED] text-[#3D3935] rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-inner">
            <Key className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-serif font-medium text-[#3D3935] mb-4 tracking-tight italic">需要配置 API Key</h1>
          <p className="text-[#6B6661] mb-8 text-sm leading-relaxed">
            为了使用高质量的图像生成模型，您需要选择一个关联了计费的项目。
            <br/><br/>
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-[#8DA399] hover:text-[#7C9288] font-semibold transition-colors underline decoration-[#8DA399]/30 underline-offset-4">
              了解关于计费的更多信息 &rarr;
            </a>
          </p>
          <button
            onClick={handleSelectKey}
            className="w-full py-4 px-6 btn-primary rounded-2xl font-semibold transition-all shadow-lg shadow-black/5 hover:shadow-black/10 active:scale-[0.98] flex items-center justify-center gap-3"
          >
            <Key className="w-5 h-5" />
            选择 API Key
          </button>
          {error && (
            <div className="mt-6 p-4 bg-red-50/50 backdrop-blur-sm text-red-700 text-sm rounded-2xl border border-red-100 text-left">
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#3D3935] font-sans relative overflow-x-hidden">
      <div className="absolute top-[-15%] left-[-10%] w-[70%] sm:w-[50%] h-[50%] bg-[#E8EDE7] rounded-full blur-[120px] opacity-40 pointer-events-none" />
      <div className="absolute bottom-[-15%] right-[-10%] w-[70%] sm:w-[50%] h-[50%] bg-[#F5EDE6] rounded-full blur-[120px] opacity-40 pointer-events-none" />

      <header className="bg-white/60 backdrop-blur-xl border-b border-[#EAE3DC] sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-20 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="bg-[#3D3935] p-1.5 sm:p-2 rounded-lg sm:rounded-xl shrink-0">
              <Wand2 className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white" />
            </div>
            <h1 className="text-base sm:text-2xl font-serif font-semibold tracking-tight text-[#3D3935] truncate max-w-[150px] sm:max-w-none">餐厅一键美化</h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-6">
            {userInfo && (
              <div className="flex items-center gap-1 sm:gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 bg-white/50 backdrop-blur-sm rounded-full border border-[#EAE3DC] shadow-sm">
                <Coins className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#C18C5D]" />
                <span className="text-[10px] sm:text-sm font-bold text-[#6B6661] whitespace-nowrap">{userInfo.integral}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-12 relative z-10">
        {error && (
          <div className="mb-6 sm:mb-8 p-4 sm:p-5 bg-red-50/70 backdrop-blur-sm border border-red-100 rounded-2xl sm:rounded-[2rem] flex items-start gap-3 sm:gap-4 text-red-800 shadow-sm animate-in fade-in slide-in-from-top-2">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
            <p className="text-xs sm:text-sm font-medium">{error}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-start">
          {/* Left Column: Image Area */}
          <div className="space-y-6 sm:space-y-8">
            <div className="glass-panel p-5 sm:p-8 rounded-3xl lg:rounded-[2.5rem]">
              <h2 className="text-lg sm:text-xl font-serif font-semibold mb-4 sm:mb-6 flex items-center gap-3 sm:gap-4 text-[#3D3935]">
                <span className="flex items-center justify-center w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-[#F2F0ED] text-[#6B6661] text-[10px] sm:text-xs font-sans shadow-inner">01</span>
                图片上传
              </h2>
              
              {!originalImage ? (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-[#EAE3DC] rounded-2xl sm:rounded-[2rem] p-8 sm:p-16 flex flex-col items-center justify-center text-[#9B9691] hover:bg-[#FDFCFB] hover:border-[#8DA399] transition-all cursor-pointer group"
                >
                  <div className="bg-white p-4 sm:p-5 rounded-2xl sm:rounded-3xl shadow-[0_10px_20px_rgba(0,0,0,0.03)] mb-4 sm:mb-6 group-hover:scale-105 transition-transform duration-500">
                    <Upload className="w-8 h-8 sm:w-10 sm:h-10 text-[#8DA399] opacity-70 group-hover:opacity-100" />
                  </div>
                  <p className="text-sm sm:text-base font-semibold text-[#6B6661] text-center">点击或拖拽上传餐厅图片</p>
                </div>
              ) : (
                <div className="space-y-4 sm:space-y-6">
                  <div className="relative rounded-2xl sm:rounded-[2rem] overflow-hidden border border-[#EAE3DC] bg-[#F9F8F6] aspect-video flex items-center justify-center shadow-inner group">
                    <img src={originalImage.url} alt="Original" className="max-w-full max-h-full object-contain" />
                    <button 
                      onClick={() => setOriginalImage(null)}
                      className="absolute top-2 sm:top-4 right-2 sm:right-4 bg-white/80 backdrop-blur-md text-[#3D3935] px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl sm:rounded-2xl text-[10px] sm:text-sm font-semibold hover:bg-white shadow-lg border border-white/50 transition-all sm:opacity-0 group-hover:opacity-100 transform sm:translate-y-2 group-hover:translate-y-0"
                    >
                      重新上传
                    </button>
                  </div>
                  
                  {!analysisResult && (
                    <button
                      onClick={handleAnalyze}
                      disabled={isAnalyzing || isUploading}
                      className="w-full py-3.5 sm:py-4.5 px-4 sm:px-6 btn-primary rounded-xl sm:rounded-[1.25rem] font-semibold flex items-center justify-center gap-2 sm:gap-3 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-xl shadow-black/5 hover:shadow-black/10 active:scale-[0.99]"
                    >
                      {isAnalyzing ? (
                        <>
                          <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
                          <span className="text-sm sm:text-base">AI 正在审视空间...</span>
                        </>
                      ) : (
                        <>
                          <Wand2 className="w-4 h-4 sm:w-5 sm:h-5" />
                          <span className="text-sm sm:text-base">开始智能空间分析</span>
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
              <div className="glass-panel p-5 sm:p-8 rounded-3xl lg:rounded-[2.5rem] animate-in fade-in zoom-in-95 duration-500">
                <h2 className="text-lg sm:text-xl font-serif font-semibold mb-4 sm:mb-6 flex items-center gap-3 sm:gap-4 text-[#3D3935]">
                  <span className="flex items-center justify-center w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-[#F2F0ED] text-[#6B6661] text-[10px] sm:text-xs font-sans shadow-inner">04</span>
                  美化成果
                </h2>
                <div 
                  className="relative rounded-2xl sm:rounded-[2rem] overflow-hidden border border-[#EAE3DC] bg-[#F9F8F6] aspect-video flex items-center justify-center group cursor-pointer shadow-inner"
                  onClick={() => setIsModalOpen(true)}
                >
                  <img src={beautifiedImage} alt="Beautified" className="max-w-full max-h-full object-contain sm:group-hover:scale-[1.03] transition-transform duration-700 ease-out" />
                  <div className="absolute inset-0 bg-[#3D3935]/0 sm:group-hover:bg-[#3D3935]/10 transition-colors duration-500 flex items-center justify-center">
                    <span className="opacity-0 sm:group-hover:opacity-100 bg-white/95 text-[#3D3935] px-4 sm:px-6 py-2 sm:py-3 rounded-xl sm:rounded-2xl text-xs sm:text-sm font-bold shadow-2xl transition-all duration-500 transform translate-y-4 group-hover:translate-y-0">全屏查看细节</span>
                  </div>
                </div>
                <button
                  onClick={handleDownload}
                  className="mt-4 sm:mt-6 w-full py-3.5 sm:py-4.5 px-4 sm:px-6 btn-secondary rounded-xl sm:rounded-[1.25rem] font-semibold flex items-center justify-center gap-2 sm:gap-3 shadow-sm hover:shadow-md active:scale-[0.99]"
                >
                  <Download className="w-4 h-4 sm:w-5 sm:h-5" />
                  <span className="text-sm sm:text-base">保存美化后的作品</span>
                </button>
              </div>
            )}

            {/* History Gallery */}
            {history.length > 1 && (
              <div className="glass-panel p-5 sm:p-8 rounded-3xl lg:rounded-[2.5rem]">
                <h2 className="text-[10px] sm:text-sm font-semibold text-[#9B9691] mb-4 sm:mb-5 tracking-widest uppercase">灵感记录</h2>
                <div className="flex gap-3 sm:gap-4 overflow-x-auto pb-4 scrollbar-thin scrollbar-thumb-[#EAE3DC] scrollbar-track-transparent snap-x snap-mandatory">
                  {history.map((img, idx) => (
                    <img
                      key={idx}
                      src={img}
                      alt={`Generated ${idx}`}
                      className={`h-20 w-20 sm:h-28 sm:w-28 object-cover rounded-xl sm:rounded-2xl cursor-pointer border-2 transition-all p-1 shrink-0 snap-start ${beautifiedImage === img ? 'border-[#8DA399] shadow-lg scale-100 bg-white' : 'border-transparent hover:border-[#EAE3DC] opacity-60 hover:opacity-100 scale-95 hover:scale-100'}`}
                      onClick={() => setBeautifiedImage(img)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Analysis & Customization */}
          <div className="lg:sticky lg:top-28 space-y-6 sm:space-y-8">
            {!analysisResult ? (
              <div className="glass-panel p-8 sm:p-12 rounded-3xl lg:rounded-[2.5rem] flex flex-col items-center justify-center text-center min-h-[300px] sm:min-h-[500px]">
                <div className="bg-[#F2F0ED] p-4 sm:p-6 rounded-2xl sm:rounded-3xl mb-4 sm:mb-6 shadow-inner">
                  <ImageIcon className="w-8 h-8 sm:w-10 sm:h-10 text-[#9B9691] opacity-30" />
                </div>
                <h3 className="text-base sm:text-lg font-serif font-medium text-[#3D3935] mb-2">待命中的灵感</h3>
                <p className="text-xs sm:text-sm text-[#9B9691] max-w-[200px] sm:max-w-[240px]">上传您的餐厅空间照片，AI 将为您提供专业的改善建议。</p>
              </div>
            ) : (
              <div className="glass-panel p-5 sm:p-8 rounded-3xl lg:rounded-[2.5rem] flex flex-col h-full max-h-[none] lg:max-h-[850px] animate-in fade-in slide-in-from-right-8 duration-700">
                {/* Custom Tabs */}
                <div className="flex p-1 bg-[#F2F0ED]/80 rounded-xl sm:rounded-2xl mb-6 sm:mb-8 shrink-0 relative">
                  {['analysis', 'decor', 'settings'].map((tab) => (
                    <button 
                      key={tab}
                      onClick={() => setActiveTab(tab as any)} 
                      className={`flex-1 py-2 sm:py-3 text-[10px] sm:text-xs font-bold rounded-lg sm:rounded-[14px] transition-all relative z-10 ${activeTab === tab ? 'text-[#3D3935]' : 'text-[#9B9691] hover:text-[#6B6661]'}`}
                    >
                      {tab === 'analysis' ? '空间洞察' : tab === 'decor' ? '软装建议' : '输出工艺'}
                      {activeTab === tab && (
                        <div className="absolute inset-0 bg-white rounded-lg sm:rounded-[14px] shadow-sm -z-10 animate-in fade-in zoom-in-95 duration-300" />
                      )}
                    </button>
                  ))}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto pr-2 -mr-2 lg:pr-3 lg:-mr-3 scrollbar-thin scrollbar-thumb-[#EAE3DC] scrollbar-track-transparent">
                  {activeTab === 'analysis' && (
                    <div className="space-y-6 sm:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                        <div className="p-4 sm:p-5 bg-white/40 rounded-xl sm:rounded-2xl border border-[#EAE3DC] shadow-sm">
                          <label className="block text-[8px] sm:text-[10px] font-bold text-[#9B9691] uppercase tracking-[0.15em] mb-2">现状布局</label>
                          <p className="text-xs sm:text-sm text-[#3D3935] leading-relaxed font-medium">{analysisResult.layout}</p>
                        </div>
                        <div className="p-4 sm:p-5 bg-white/40 rounded-xl sm:rounded-2xl border border-[#EAE3DC] shadow-sm">
                          <label className="block text-[8px] sm:text-[10px] font-bold text-[#9B9691] uppercase tracking-[0.15em] mb-2">识别风格</label>
                          <p className="text-xs sm:text-sm text-[#3D3935] leading-relaxed font-medium">{analysisResult.style}</p>
                        </div>
                      </div>
                      
                      <div className="p-4 sm:p-6 bg-[#E8EDE7]/40 rounded-2xl sm:rounded-[1.5rem] border border-[#D9E2D7] shadow-inner">
                        <label className="block text-[8px] sm:text-[10px] font-bold text-[#8DA399] uppercase tracking-[0.15em] mb-3">光影优化逻辑</label>
                        <p className="text-xs sm:text-sm text-[#4A5D4F] leading-relaxed italic">{analysisResult.lightingReason}</p>
                      </div>

                      <div className="pt-2">
                        <div className="flex items-center justify-between mb-4">
                          <label className="text-xs sm:text-sm font-bold text-[#3D3935]">核心美化点</label>
                          <button
                            onClick={handleAddPoint}
                            className="bg-white p-1.5 rounded-lg border border-[#EAE3DC] text-[#8DA399] hover:bg-[#F2F0ED] transition-colors"
                          >
                            <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          </button>
                        </div>
                        <div className="space-y-3">
                          {analysisResult.beautifyPoints.map((point, idx) => (
                            <div key={idx} className="flex items-center gap-2 sm:gap-3 group animate-in fade-in slide-in-from-left-2 transition-all">
                              <div className="flex-1 relative">
                                <input 
                                  type="text"
                                  value={point}
                                  onChange={(e) => handlePointChange(idx, e.target.value)}
                                  className="w-full pl-4 sm:pl-5 pr-10 sm:pr-12 py-2.5 sm:py-3.5 bg-white/60 border border-[#EAE3DC] rounded-xl sm:rounded-2xl focus:ring-2 focus:ring-[#8DA399]/20 focus:border-[#8DA399] text-xs sm:text-sm shadow-sm transition-all focus:bg-white"
                                  placeholder="输入您的特别要求..."
                                />
                                <button 
                                  onClick={() => handleDeletePoint(idx)}
                                  className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 p-2 text-[#9B9691] hover:text-red-500 sm:opacity-0 group-hover:opacity-100 transition-all"
                                >
                                  <X className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === 'decor' && (
                    <div className="space-y-4 sm:space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      <div className="p-4 sm:p-6 bg-white/40 rounded-2xl sm:rounded-[2rem] border border-[#EAE3DC] shadow-sm flex items-center justify-between gap-4">
                        <div className="pr-2 sm:pr-8">
                          <h3 className="text-xs sm:text-sm font-bold text-[#3D3935]">智能空间软装</h3>
                          <p className="text-[10px] sm:text-xs text-[#9B9691] mt-1 sm:mt-1.5 leading-relaxed">启用后，AI 将自动推荐饰品、绿植及灯具。</p>
                        </div>
                        <button 
                          onClick={() => setAllowAdditions(!allowAdditions)} 
                          className={`w-12 sm:w-14 h-6 sm:h-7 rounded-full transition-all duration-500 relative shadow-inner shrink-0 ${allowAdditions ? 'bg-[#8DA399]' : 'bg-[#EAE3DC]'}`}
                        >
                          <div className={`w-4.5 h-4.5 sm:w-5.5 sm:h-5.5 bg-white rounded-full absolute top-0.75 transition-transform duration-500 shadow-md ${allowAdditions ? 'translate-x-[1.4rem] sm:translate-x-[1.85rem]' : 'translate-x-0.75'}`} />
                        </button>
                      </div>
                      
                      {allowAdditions ? (
                        <div className="grid gap-3 sm:gap-4">
                          {analysisResult?.recommendedAdditions?.map((add, idx) => (
                            <div 
                              key={idx} 
                              className={`p-4 sm:p-5 rounded-[1.25rem] sm:rounded-[1.75rem] border transition-all duration-500 cursor-pointer flex flex-col gap-1.5 ${add.enabled ? 'bg-white border-[#8DA399]/30 shadow-[0_4px_12px_rgba(141,163,153,0.1)]' : 'bg-white/20 border-[#EAE3DC] opacity-60'}`}
                              onClick={() => handleToggleAddition(idx)}
                            >
                              <div className="flex items-center justify-between">
                                <div className="text-xs sm:text-sm font-bold text-[#3D3935]">{add.item}</div>
                                <div className={`w-3.5 h-3.5 sm:w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all ${add.enabled ? 'bg-[#8DA399] border-[#8DA399]' : 'border-[#EAE3DC]'}`}>
                                  {add.enabled && <CheckCircle2 className="w-2.5 h-2.5 text-white" />}
                                </div>
                              </div>
                              <div className="text-[10px] sm:text-xs text-[#9B9691] leading-relaxed italic">{add.reason}</div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs sm:text-sm text-[#9B9691] bg-[#F2F0ED]/40 p-6 sm:p-10 rounded-[1.5rem] sm:rounded-[2rem] border border-dashed border-[#EAE3DC] text-center italic">
                          环境软装已禁用。我们将保持原有的陈设，仅进行光影与材质的针对性优化。
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'settings' && (
                    <div className="space-y-6 sm:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                      {[
                        { label: '图片比例', key: 'ratio', options: ['1:1', '3:4', '4:3', '9:16', '16:9'] },
                        { label: '艺术基调', key: 'lighting', options: ['暖色调', '清新浅色', '高端暗色'] },
                        { label: '数字分辨率', key: 'resolution', options: ['1K', '2K', '4K'] }
                      ].map((group) => (
                        <div key={group.key}>
                          <label className="block text-[8px] sm:text-[10px] font-bold text-[#9B9691] uppercase tracking-[0.2em] mb-3 sm:mb-4">{group.label}</label>
                          <div className="flex flex-wrap gap-2 sm:gap-2.5">
                            {group.options.map(val => (
                              <button
                                key={val}
                                onClick={() => setOptions({...options, [group.key]: val})}
                                className={`px-4 sm:px-5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-[10px] sm:text-xs font-bold transition-all border ${options[group.key as keyof typeof options] === val ? 'bg-[#3D3935] border-[#3D3935] text-white shadow-lg sm:shadow-xl' : 'bg-white border-[#EAE3DC] text-[#6B6661] hover:border-[#8DA399] hover:bg-[#FDFCFB]'}`}
                              >
                                {val}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Footer Action */}
                <div className="pt-6 sm:pt-8 mt-6 sm:mt-8 border-t border-[#EAE3DC]/60 shrink-0">
                    <button
                      onClick={handleBeautify}
                      disabled={isBeautifying || !analysisResult}
                      className="relative w-full py-4 sm:py-5 px-4 sm:px-6 btn-primary rounded-2xl sm:rounded-[1.5rem] font-bold flex items-center justify-center gap-2 sm:gap-3 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_20px_40px_rgba(61,57,53,0.15)] hover:shadow-[0_25px_50px_rgba(61,57,53,0.25)] active:scale-[0.98] text-sm sm:text-base overflow-hidden"
                    >
                      {isBeautifying && (
                        <div 
                          className="absolute inset-0 bg-white/20 transition-all duration-300 pointer-events-none" 
                          style={{ width: `${beautifyProgress}%` }} 
                        />
                      )}
                      <div className="relative z-10 flex items-center gap-2 sm:gap-3">
                        {isBeautifying ? (
                          <>
                            <Loader2 className="w-5 h-5 sm:w-5.5 sm:h-5.5 animate-spin" />
                            <div className="flex flex-col items-center">
                              <span className="text-sm sm:text-base">{beautifyMessage || '正在重绘...'}</span>
                              <span className="text-[10px] sm:text-[12px] opacity-70 serif italic">{beautifyProgress}% 完成</span>
                            </div>
                          </>
                        ) : (
                          <>
                            <ImageIcon className="w-5 h-5 sm:w-5.5 sm:h-5.5" />
                            <span className="text-sm sm:text-base">即刻开启美化</span>
                          </>
                        )}
                      </div>
                    </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Fullscreen Image Modal */}
      {isModalOpen && beautifiedImage && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[#FDFCFB]/98 backdrop-blur-2xl p-4 sm:p-12 animate-in fade-in duration-500"
          onClick={() => setIsModalOpen(false)}
        >
          <button 
            className="absolute top-4 sm:top-8 right-4 sm:right-8 text-[#3D3935] p-3 rounded-full hover:bg-[#F2F0ED] transition-colors z-[110]"
            onClick={() => setIsModalOpen(false)}
          >
            <X className="w-6 h-6 sm:w-8 sm:h-8" />
          </button>
          <div className="relative w-full h-full flex items-center justify-center">
            <img 
              src={beautifiedImage} 
              alt="Beautified High Res" 
              className="max-w-full max-h-[85vh] sm:max-h-full object-contain rounded-2xl sm:rounded-[2rem] shadow-[0_40px_100px_rgba(0,0,0,0.15)]"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-4">
             <button
                onClick={(e) => { e.stopPropagation(); handleDownload(); }}
                className="px-6 py-3 bg-[#3D3935] text-white rounded-full font-bold shadow-2xl flex items-center gap-2 active:scale-95 transition-transform"
              >
                <Download className="w-5 h-5" />
                <span>保存图片</span>
              </button>
          </div>
        </div>
      )}
    </div>
  );
}
