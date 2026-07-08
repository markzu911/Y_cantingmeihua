import React, { useState, useRef, useEffect } from 'react';
import { Upload, Image as ImageIcon, Wand2, Download, Loader2, CheckCircle2, AlertCircle, X, Key, Plus, Trash2, Coins, MessageSquare, Settings, Sparkles, Send, Check, RotateCcw, Bot, User } from 'lucide-react';
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

interface ChatMessage {
  id: string;
  sender: 'ai' | 'user';
  text: string;
  type?: 'text' | 'image-upload' | 'analysis-result' | 'options-ratio' | 'options-resolution' | 'options-lighting' | 'options-decor' | 'decor-checkboxes' | 'beautify-trigger' | 'loading' | 'result-card' | 'error';
  image?: string;
  meta?: any;
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

  // Dual Mode State
  const [mode, setMode] = useState<'landing' | 'agent' | 'expert'>('landing');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [customRequirements, setCustomRequirements] = useState<string[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [messageQueue, setMessageQueue] = useState<{ id: string, text: string }[]>([]);

  // User custom selections tracking
  const [isRatioSelected, setIsRatioSelected] = useState(false);
  const [isResolutionSelected, setIsResolutionSelected] = useState(false);
  const [isDecorSelected, setIsDecorSelected] = useState(false);
  const [isLightingSelected, setIsLightingSelected] = useState(false);

  // Drag & drop state tracking
  const [isDragging, setIsDragging] = useState(false);
  const [isChatDragging, setIsChatDragging] = useState(false);

  // Pending beautification if triggered before space analysis finishes
  const beautifyPendingRef = useRef<{
    pending: boolean;
    options: { ratio: string; lighting: string; resolution: string };
    allowAdditions: boolean;
  } | null>(null);

  // Controller for aborting generation
  const abortControllerRef = useRef<AbortController | null>(null);

  // SaaS Integration State
  const [userId, setUserId] = useState<string | null>(null);
  const [toolId, setToolId] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<SaasUserInfo | null>(null);
  const [toolInfo, setToolInfo] = useState<SaasToolInfo | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Initialize Welcome Message
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        {
          id: 'welcome',
          sender: 'ai',
          text: '您好！我是您的智能餐厅美化智能体。我可以帮您快速对餐厅进行高清、真实的清洁提亮与软装定制。首先，请上传您的餐厅原始照片 📸。',
          type: 'image-upload'
        }
      ]);
    }
  }, []);

  // Sync when mode switches to Agent Mode
  useEffect(() => {
    if (mode === 'agent' && originalImage && messages.length <= 1) {
      setMessages([
        {
          id: 'welcome',
          sender: 'ai',
          text: '您好！我是您的智能餐厅美化智能体。我可以帮您快速对餐厅进行高清、真实的清洁提亮与软装定制。首先，请上传您的餐厅原始照片 📸。',
          type: 'image-upload'
        },
        {
          id: 'sync-uploaded-' + Date.now(),
          sender: 'user',
          text: '已导入餐厅照片 📸',
          image: originalImage.url
        }
      ]);
      autoAnalyzeInChat(originalImage.base64, originalImage.mimeType);
    }
  }, [mode]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [messages]);

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

  const processImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      
      // Client-side image compression
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxSide = 1600;

        // Calculate scaling
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
          // Fill with white background for transparency conversion
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
        }

        // Convert to highly compressed JPEG
        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const base64 = compressedDataUrl.split(',')[1];
        
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
        setIsRatioSelected(false);
        setIsResolutionSelected(false);
        setIsDecorSelected(false);
        setIsLightingSelected(false);
        beautifyPendingRef.current = null;

        if (mode === 'agent') {
          setMessages(prev => [
            ...prev,
            {
              id: 'user-uploaded-' + Date.now(),
              sender: 'user',
              text: '已上传餐厅照片 📸',
              image: compressedDataUrl
            }
          ]);
          autoAnalyzeInChat(base64, 'image/jpeg');
        }
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processImageFile(file);
    e.target.value = ''; // Reset so uploading same file works
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processImageFile(file);
    }
  };

  const handleChatDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsChatDragging(true);
  };

  const handleChatDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsChatDragging(false);
  };

  const handleChatDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsChatDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processImageFile(file);
    }
  };

  const autoAnalyzeInChat = async (base64: string, mimeType: string) => {
    const analysisLoadingId = 'ai-analyzing-' + Date.now();
    setMessages(prev => [
      ...prev,
      {
        id: analysisLoadingId,
        sender: 'ai',
        text: '正在智能审视与分析您的餐厅空间，请稍候... 🔍',
        type: 'loading'
      }
    ]);

    if (userId && toolId) {
      try {
        const verifyRes = await fetch('/api/tool/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          setMessages(prev => prev.filter(m => m.id !== analysisLoadingId).concat([
            {
              id: 'err-' + Date.now(),
              sender: 'ai',
              text: `❌ 积分不足，无法执行该操作：${verifyData.message || '需要更多积分'}`,
              type: 'error'
            }
          ]));
          return;
        }
      } catch (err) {
        console.error('Verify failed:', err);
      }
    }

    abortControllerRef.current = new AbortController();

    try {
      const result = await analyzeRestaurantImage(base64, mimeType, abortControllerRef.current.signal);
      setAnalysisResult(result);
      
      const recommendedLighting = result.recommendedLighting && ['暖色调', '清新浅色', '高端暗色'].includes(result.recommendedLighting)
        ? result.recommendedLighting
        : '暖色调';

      if (result.recommendedLighting && ['暖色调', '清新浅色', '高端暗色'].includes(result.recommendedLighting)) {
        setOptions(prev => ({ ...prev, lighting: result.recommendedLighting }));
      }

      if (beautifyPendingRef.current && beautifyPendingRef.current.pending) {
        const pendingConfig = beautifyPendingRef.current;
        beautifyPendingRef.current = null; // reset

        const finalOptions = {
          ...pendingConfig.options,
          lighting: recommendedLighting
        };

        setOptions(finalOptions);
        setAllowAdditions(pendingConfig.allowAdditions);
        setIsRatioSelected(true);
        setIsResolutionSelected(true);
        setIsDecorSelected(true);
        setIsLightingSelected(true);

        setMessages(prev => prev.filter(m => m.id !== analysisLoadingId).concat([
          {
            id: 'analysis-res-' + Date.now(),
            sender: 'ai',
            text: `分析完成！已为您自动匹配最佳艺术基调为「${recommendedLighting}」。\n将使用默认参数（${finalOptions.resolution}, ${finalOptions.ratio}, 不需要软装）立即为您启动一键美化...`,
            type: 'analysis-result',
            meta: result
          }
        ]));

        setTimeout(() => {
          handleBeautifyInChat(finalOptions, pendingConfig.allowAdditions, result);
        }, 1200);
      } else {
        setMessages(prev => prev.filter(m => m.id !== analysisLoadingId).concat([
          {
            id: 'analysis-res-' + Date.now(),
            sender: 'ai',
            text: `分析完成！我发现了以下可以优化的地方：`,
            type: 'analysis-result',
            meta: result
          }
        ]));
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return; // Aborted by user
      }
      setMessages(prev => prev.filter(m => m.id !== analysisLoadingId).concat([
        {
          id: 'err-' + Date.now(),
          sender: 'ai',
          text: `❌ 空间分析失败：${err.message || '请重试'}`,
          type: 'error'
        }
      ]));
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleSelectRatioInChat = (ratio: string) => {
    setOptions(prev => ({ ...prev, ratio }));
    setIsRatioSelected(true);
    setMessages(prev => [
      ...prev,
      {
        id: 'user-ratio-' + Date.now(),
        sender: 'user',
        text: `画面比例：${ratio}`
      },
      {
        id: 'ai-resolution-ask-' + Date.now(),
        sender: 'ai',
        text: `已确认画面比例为「${ratio}」！接下来，请选择您需要的「画面清晰度（分辨率）」💎：`,
        type: 'options-resolution'
      }
    ]);
  };

  const handleSelectResolutionInChat = (resolution: string) => {
    setOptions(prev => ({ ...prev, resolution }));
    setIsResolutionSelected(true);
    setMessages(prev => [
      ...prev,
      {
        id: 'user-resolution-' + Date.now(),
        sender: 'user',
        text: `画面清晰度：${resolution}`
      },
      {
        id: 'ai-lighting-ask-' + Date.now(),
        sender: 'ai',
        text: `已确认分辨率为「${resolution}」！接下来，请选择您期望的「艺术基调（光影优化效果）」💡：\n(已根据您的餐厅推荐: ${analysisResult?.recommendedLighting || '暖色调'})`,
        type: 'options-lighting'
      }
    ]);
  };

  const handleSelectLightingInChat = (lighting: string) => {
    setOptions(prev => ({ ...prev, lighting }));
    setIsLightingSelected(true);
    setMessages(prev => [
      ...prev,
      {
        id: 'user-lighting-' + Date.now(),
        sender: 'user',
        text: `艺术基调：${lighting}`
      },
      {
        id: 'ai-decor-ask-' + Date.now(),
        sender: 'ai',
        text: `已确认艺术基调为「${lighting}」！接下来，是否开启「智能空间软装推荐」？\n开启后，AI 将在场景中推荐增加软装饰品或绿植（完全在推荐清单内，绝不无中生有其他多余物件）。若关闭，则纯粹进行去杂物清洗与质感提亮。`,
        type: 'options-decor'
      }
    ]);
  };

  const handleSelectDecorInChat = (enabled: boolean) => {
    setAllowAdditions(enabled);
    setIsDecorSelected(true);
    if (enabled) {
      setMessages(prev => [
        ...prev,
        {
          id: 'user-decor-' + Date.now(),
          sender: 'user',
          text: '开启智能软装推荐'
        },
        {
          id: 'ai-decor-items-' + Date.now(),
          sender: 'ai',
          text: '为您推荐了以下几项软装升级建议，您可以自由点击启用或停用：',
          type: 'decor-checkboxes'
        }
      ]);
    } else {
      setMessages(prev => [
        ...prev,
        {
          id: 'user-decor-' + Date.now(),
          sender: 'user',
          text: '不开启软装，仅做清洁提亮'
        },
        {
          id: 'ai-beautify-ready-' + Date.now(),
          sender: 'ai',
          text: '好的，我们将保持原有的物件陈设，纯净清洗除垢，恢复材质的高级质感。请确认以下美化逻辑无误，点击开始一键美化。',
          type: 'beautify-trigger'
        }
      ]);
    }
  };

  const handleBeautifyInChat = async (optionsOverride?: typeof options, allowAdditionsOverride?: boolean, analysisResultOverride?: AnalysisResult) => {
    const finalAnalysisResult = analysisResultOverride || analysisResult;
    if (!originalImage || !finalAnalysisResult) return;

    const beautifyLoadingId = 'ai-beautifying-' + Date.now();
    setMessages(prev => [
      ...prev,
      {
        id: 'user-start-' + Date.now(),
        sender: 'user',
        text: '开始一键美化 🚀'
      },
      {
        id: beautifyLoadingId,
        sender: 'ai',
        text: '正在用 AI 画笔重绘您的餐厅，预计耗时 30-40 秒，请稍候... 🎨',
        type: 'loading'
      }
    ]);

    if (userId && toolId) {
      try {
        const verifyRes = await fetch('/api/tool/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          setMessages(prev => prev.filter(m => m.id !== beautifyLoadingId).concat([
            {
              id: 'err-' + Date.now(),
              sender: 'ai',
              text: `❌ 积分不足，无法执行该操作：${verifyData.message || '需要更多积分'}`,
              type: 'error'
            }
          ]));
          return;
        }
      } catch (err) {
        console.error('Verify failed:', err);
      }
    }

    try {
      abortControllerRef.current = new AbortController();
      const resultImageBase64 = await beautifyRestaurantImage(
        originalImage.base64,
        originalImage.mimeType,
        finalAnalysisResult,
        optionsOverride || options,
        allowAdditionsOverride !== undefined ? allowAdditionsOverride : allowAdditions,
        customRequirements,
        abortControllerRef.current.signal
      );

      setBeautifiedImage(resultImageBase64);
      setHistory(prev => [resultImageBase64, ...prev]);

      let finalImageUrl = resultImageBase64;

      if (userId && toolId) {
        const consumeRes = await fetch('/api/tool/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const consumeData = await consumeRes.json();
        
        if (consumeData.success) {
          if (consumeData.data) {
            setUserInfo(prev => prev ? { ...prev, integral: consumeData.data.currentIntegral } : null);
          }

          const base64Data = resultImageBase64.replace(/^data:image\/\w+;base64,/, '');
          const binaryString = window.atob(base64Data);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const fileSize = bytes.byteLength;
          const blob = new Blob([bytes], { type: 'image/png' });

          const tokenRes = await fetch('/api/upload/direct-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, toolId, source: 'result', mimeType: 'image/png', fileName: 'result.png', fileSize })
          });
          const token = await tokenRes.json();

          if (token.success) {
            const uploadRes = await fetch(token.uploadUrl, {
              method: token.method || 'PUT',
              headers: token.headers,
              body: blob
            });

            if (uploadRes.ok) {
              const commitRes = await fetch('/api/upload/commit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userId,
                  toolId,
                  source: 'result',
                  objectKey: token.objectKey,
                  fileSize
                })
              });
              const commit = await commitRes.json();
              if (commit.savedToRecords && commit.image?.url) {
                finalImageUrl = commit.image.url;
                setBeautifiedImage(commit.image.url);
                setHistory(prev => {
                  const newHistory = [...prev];
                  newHistory[0] = commit.image.url;
                  return newHistory;
                });
              }
            }
          }
        }
      }

      setMessages(prev => prev.filter(m => m.id !== beautifyLoadingId).concat([
        {
          id: 'beautify-res-' + Date.now(),
          sender: 'ai',
          text: '您的餐厅美化图已成功渲染完成！✨ 整体色调得到了重塑，地面与墙体破损、暗沉、污渍等均已完全修复并提升质感，台面整理也已洁净有序。您觉得效果满意吗？',
          type: 'result-card',
          image: finalImageUrl
        }
      ]));

    } catch (err: any) {
      if (err.name === 'AbortError') {
        return; // Aborted by user
      }
      const errorMsg = err.message || '';
      let displayedError = '美化重绘失败，请稍后重试。';
      if (errorMsg.includes('403') || errorMsg.includes('PERMISSION_DENIED') || errorMsg.includes('Requested entity was not found')) {
        setHasKey(false);
        displayedError = 'API Key 权限不足或未找到。请重新选择一个已启用计费项目的 API Key。';
      }
      setMessages(prev => prev.filter(m => m.id !== beautifyLoadingId).concat([
        {
          id: 'err-' + Date.now(),
          sender: 'ai',
          text: `❌ 渲染遇到问题：${displayedError}`,
          type: 'error'
        }
      ]));
    } finally {
      if (abortControllerRef.current) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleRestartInChat = () => {
    setOriginalImage(null);
    setAnalysisResult(null);
    setBeautifiedImage(null);
    setHistory([]);
    setCustomRequirements([]);
    setError(null);
    setIsRatioSelected(false);
    setIsResolutionSelected(false);
    setIsLightingSelected(false);
    setIsDecorSelected(false);
    setMessages([
      {
        id: 'welcome-' + Date.now(),
        sender: 'ai',
        text: '您好！我是您的智能餐厅美化智能体。我可以帮您快速对餐厅进行高清、真实的清洁提亮与软装定制。首先，请上传您的餐厅原始照片 📸。',
        type: 'image-upload'
      }
    ]);
  };

  // Process message queue when generation finishes
  useEffect(() => {
    if (!isBeautifying && !isAnalyzing && messageQueue.length > 0) {
      const nextMessage = messageQueue[0];
      setMessageQueue(prev => prev.slice(1));
      handleSendMessage(nextMessage.text, true);
    }
  }, [isBeautifying, isAnalyzing, messageQueue]);

  const handleSendMessage = (text: string, isFromQueue: boolean = false) => {
    if (!text.trim()) return;
    
    let userMsgId = 'user-text-' + Date.now();
    if (!isFromQueue) {
      setMessages(prev => [
        ...prev,
        {
          id: userMsgId,
          sender: 'user',
          text
        }
      ]);
      setInputMessage('');
    }

    setTimeout(() => {
      const lowerText = text.toLowerCase();

      // Check if image is generating
      if (isBeautifying || isAnalyzing) {
        const stopKeywords = ["停止", "取消", "终止", "不画了", "停下", "中断", "stop", "cancel", "abort"];
        const isStop = stopKeywords.some(kw => lowerText.includes(kw));

        if (isStop) {
          if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
          }
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-aborted-' + Date.now(),
              sender: 'ai',
              text: '✨ 已为您停止生成。您可以随时修改需求后重新生成。',
              type: 'text'
            }
          ]);
          setIsBeautifying(false);
          setIsAnalyzing(false);
          
          // Remove loading messages
          setMessages(prev => prev.filter(msg => msg.type !== 'loading'));
          return;
        } else {
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-busy-' + Date.now(),
              sender: 'ai',
              text: '图片正在努力生成中 🎨，您的需求我已记下，将在生成完毕后为您处理！如果想要中止生成，可以说「停止」。',
              type: 'text'
            }
          ]);
          
          // Queue requirement for after generation if it's not a stop command
          setMessageQueue(prev => [...prev, { id: 'user-text-' + Date.now(), text }]);
          return;
        }
      }

      // Intercept add/delete suggestion commands
      if (analysisResult) {
        const deleteKeywords = ["删除", "删掉", "去掉", "取消", "清除", "移除", "不想要", "不加", "拿掉", "裁减", "剪掉", "不要"];
        let isDelete = false;
        let deleteTarget = "";
        
        for (const kw of deleteKeywords) {
          if (lowerText.includes(kw)) {
            isDelete = true;
            const index = lowerText.indexOf(kw);
            let target = text.substring(index + kw.length).replace(/[:：建议软装方案核心点「」'"]/g, "").trim();
            if (!target) {
              target = text.substring(0, index).replace(/[把这那个个建议软装方案「」'"]/g, "").trim();
            }
            if (target) {
              deleteTarget = target;
            }
            break;
          }
        }
        
        if (isDelete && deleteTarget) {
          let deletedFromPoints = false;
          let deletedFromAdditions = false;
          let matchedItemName = "";
          
          const updatedPoints = analysisResult.beautifyPoints.filter(pt => {
            if (pt.toLowerCase().includes(deleteTarget.toLowerCase())) {
              deletedFromPoints = true;
              matchedItemName = pt;
              return false;
            }
            return true;
          });
          
          let updatedAdditions = analysisResult.recommendedAdditions || [];
          if (analysisResult.recommendedAdditions) {
            updatedAdditions = analysisResult.recommendedAdditions.filter(add => {
              if (add.item.toLowerCase().includes(deleteTarget.toLowerCase())) {
                deletedFromAdditions = true;
                matchedItemName = add.item;
                return false;
              }
              return true;
            });
          }
          
          if (deletedFromPoints || deletedFromAdditions) {
            setAnalysisResult({
              ...analysisResult,
              beautifyPoints: updatedPoints,
              recommendedAdditions: updatedAdditions
            });
            
            setMessages(prev => [
              ...prev,
              {
                id: 'ai-delete-confirm-' + Date.now(),
                sender: 'ai',
                text: `✨ 已为您在美化方案中移除了「${matchedItemName || deleteTarget}」。建议列表已实时更新！`,
                type: 'text'
              }
            ]);
            return;
          } else {
            const allItems = [
              ...analysisResult.beautifyPoints,
              ...(analysisResult.recommendedAdditions || []).map(a => a.item)
            ];
            const suggestionsList = allItems.filter(item => 
              deleteTarget.split('').some(char => item.includes(char))
            );

            let feedbackText = `✨ 收到您的移除指令！未在当前的建议清单中直接找到「${deleteTarget}」。`;
            if (suggestionsList.length > 0) {
              feedbackText += `您是指以下某项吗？您可以直接发送指令删除它们：\n` + suggestionsList.map(s => ` - 删除「${s}」`).join('\n');
            } else {
              feedbackText += `我已在定制设计要求中为您记录了「排除：${deleteTarget}」的限制，生成时将避免出现此项。`;
              setCustomRequirements(prev => {
                const reqText = `排除：${deleteTarget}`;
                if (prev.includes(reqText)) return prev;
                return [...prev, reqText];
              });
            }

            setMessages(prev => [
              ...prev,
              {
                id: 'ai-delete-not-found-' + Date.now(),
                sender: 'ai',
                text: feedbackText,
                type: 'text'
              }
            ]);
            return;
          }
        }
        
        // Detect Add / New Recommendation
        const addKeywords = ["增加", "新增", "添加", "加上", "想加", "建议加上", "建议增加", "建议新增"];
        let isAdd = false;
        let addTarget = "";
        
        for (const kw of addKeywords) {
          if (lowerText.includes(kw)) {
            isAdd = true;
            const index = lowerText.indexOf(kw);
            let target = text.substring(index + kw.length).replace(/[:：建议软装方案核心点「」'"]/g, "").trim();
            if (target) {
              addTarget = target;
            }
            break;
          }
        }
        
        if (!isAdd && (text.startsWith("建议：") || text.startsWith("建议 ") || text.startsWith("建议在"))) {
          isAdd = true;
          addTarget = text.replace(/^建议[:：\s]*/, "").trim();
        }
        
        if (isAdd && addTarget) {
          const isSoftDecor = /(挂画|绿植|桌花|窗帘|吊灯|灯饰|摆设|餐具|配饰|软装|桌布|绿萝|发财树|花卉|盆栽|艺术品|钢琴|椅子|桌椅|饰品|花瓶|围裙|海报|菜单|壁画|地毯|餐垫|纸巾盒|调料瓶)/i.test(addTarget);
          
          let updatedPoints = [...analysisResult.beautifyPoints];
          if (!updatedPoints.some(pt => pt.toLowerCase().includes(addTarget.toLowerCase()))) {
            updatedPoints.push(addTarget);
          }
          
          let updatedAdditions = [...(analysisResult.recommendedAdditions || [])];
          if (isSoftDecor && !updatedAdditions.some(add => add.item.toLowerCase().includes(addTarget.toLowerCase()))) {
            updatedAdditions.push({
              item: addTarget,
              reason: '用户对话新增的专属软装定制建议',
              enabled: true
            });
          }
          
          setAnalysisResult({
            ...analysisResult,
            beautifyPoints: updatedPoints,
            recommendedAdditions: updatedAdditions
          });
          
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-add-confirm-' + Date.now(),
              sender: 'ai',
              text: `✨ 已为您成功新增了美化建议：「${addTarget}」！${isSoftDecor ? '此建议也已同步加入软装升级清单并开启点缀。' : ''}您可以在设计建议面板或本对话中随时查看。`,
              type: 'text'
            }
          ]);
          return;
        }
      }

      // Parse parameters or custom requirements
      let parsedRatio = '';
      let parsedResolution = '';
      let parsedLighting = '';
      let parsedDecor: boolean | null = null;
      let extraReq = '';

      const feedback: string[] = [];

      // 1. Ratio
      if (lowerText.includes('16:9') || lowerText.includes('16比9')) {
        parsedRatio = '16:9';
        feedback.push('📐 画面比例已设为：16:9 (横屏，适合宽敞全景)');
      } else if (lowerText.includes('4:3') || lowerText.includes('4比3')) {
        parsedRatio = '4:3';
        feedback.push('📐 画面比例已设为：4:3 (标准画幅)');
      } else if (lowerText.includes('3:4') || lowerText.includes('3比4')) {
        parsedRatio = '3:4';
        feedback.push('📐 画面比例已设为：3:4 (竖屏画幅)');
      } else if (lowerText.includes('1:1') || lowerText.includes('1比1') || lowerText.includes('正方形')) {
        parsedRatio = '1:1';
        feedback.push('📐 画面比例已设为：1:1 (正方形，聚焦餐桌主体)');
      } else if (lowerText.includes('9:16') || lowerText.includes('9比16')) {
        parsedRatio = '9:16';
        feedback.push('📐 画面比例已设为：9:16 (手机竖屏，适合小红书/分享)');
      }

      // 2. Resolution
      if (lowerText.includes('4k') || lowerText.includes('极高分辨率') || lowerText.includes('影院级')) {
        parsedResolution = '4K';
        feedback.push('💎 渲染分辨率已设为：4K (影院级超清画质，极致细节)');
      } else if (lowerText.includes('2k') || lowerText.includes('高清') || lowerText.includes('超清') || lowerText.includes('高分辨率')) {
        parsedResolution = '2K';
        feedback.push('💎 渲染分辨率已设为：2K (极致画质，细节饱满)');
      } else if (lowerText.includes('1k') || lowerText.includes('标清') || lowerText.includes('标准分辨率')) {
        parsedResolution = '1K';
        feedback.push('⚡ 渲染分辨率已设为：1K (标准画质，生成迅速)');
      }

      // 3. Lighting
      if (lowerText.includes('暖色') || lowerText.includes('温馨') || lowerText.includes('暖光') || lowerText.includes('黄光') || lowerText.includes('暖调')) {
        parsedLighting = '暖色调';
        feedback.push('💡 艺术光影基调已设为：暖色调 (温馨舒适，宾至如归)');
      } else if (lowerText.includes('清新') || lowerText.includes('浅色') || lowerText.includes('白光') || lowerText.includes('明亮') || lowerText.includes('冷光')) {
        parsedLighting = '清新浅色';
        feedback.push('💡 艺术光影基调已设为：清新浅色 (透亮清爽，洁净宜人)');
      } else if (lowerText.includes('高端暗色') || lowerText.includes('暗色') || lowerText.includes('奢华') || lowerText.includes('雅致') || lowerText.includes('暗调') || lowerText.includes('高奢')) {
        parsedLighting = '高端暗色';
        feedback.push('💡 艺术光影基调已设为：高端暗色 (典雅深邃，质感非凡)');
      }

      // 4. Decor Additions
      if (lowerText.includes('不开启软装') || lowerText.includes('不加配饰') || lowerText.includes('不加装饰') || lowerText.includes('纯净清洁') || lowerText.includes('仅清洁') || lowerText.includes('仅做清洁') || lowerText.includes('关闭软装') || lowerText.includes('不开启配饰') || lowerText.includes('关闭配饰') || lowerText.includes('不要软装') || lowerText.includes('关闭软装推荐')) {
        parsedDecor = false;
        feedback.push('🍃 装饰装潢：不额外增加新配饰，保持原格局仅进行材质修复与提亮');
      } else if (lowerText.includes('开启软装') || lowerText.includes('加配饰') || lowerText.includes('开启配饰') || lowerText.includes('添加配饰') || lowerText.includes('添加软装') || lowerText.includes('要软装') || lowerText.includes('开启软装推荐')) {
        parsedDecor = true;
        feedback.push('🌸 装饰装潢：已开启智能空间配饰推荐点缀');
      }

      // Local tracking variables for this turn
      let currentLighting = options.lighting;
      let currentDecor: boolean | null = allowAdditions;
      let wasRatioChosen = !!parsedRatio;
      let wasResolutionChosen = !!parsedResolution;
      let wasLightingChosen = !!parsedLighting;
      let wasDecorChosen = parsedDecor !== null;

      const lastAiMsg = [...messages].reverse().find(m => m.sender === 'ai');
      const stage = lastAiMsg?.type || 'text';

      // Stage-specific implicit parsing
      if (stage === 'options-ratio' && !wasRatioChosen) {
        if (lowerText.includes('1:1') || lowerText.includes('1比1') || lowerText.includes('正方形')) {
          parsedRatio = '1:1';
          wasRatioChosen = true;
          feedback.push('📐 画面比例已设为：1:1 (正方形)');
        } else if (lowerText.includes('16:9') || lowerText.includes('16比9')) {
          parsedRatio = '16:9';
          wasRatioChosen = true;
          feedback.push('📐 画面比例已设为：16:9 (横屏)');
        } else if (lowerText.includes('4:3') || lowerText.includes('4比3')) {
          parsedRatio = '4:3';
          wasRatioChosen = true;
          feedback.push('📐 画面比例已设为：4:3 (标准横屏)');
        } else if (lowerText.includes('3:4') || lowerText.includes('3比4')) {
          parsedRatio = '3:4';
          wasRatioChosen = true;
          feedback.push('📐 画面比例已设为：3:4 (标准竖屏)');
        } else if (lowerText.includes('9:16') || lowerText.includes('9比16')) {
          parsedRatio = '9:16';
          wasRatioChosen = true;
          feedback.push('📐 画面比例已设为：9:16 (手机竖屏)');
        }
      }

      if (stage === 'options-resolution' && !wasResolutionChosen) {
        if (lowerText.includes('4k')) {
          parsedResolution = '4K';
          wasResolutionChosen = true;
          feedback.push('💎 渲染分辨率已设为：4K (影院级超清)');
        } else if (lowerText.includes('2k') || lowerText.includes('高') || lowerText.includes('超')) {
          parsedResolution = '2K';
          wasResolutionChosen = true;
          feedback.push('💎 渲染分辨率已设为：2K (极致画质)');
        } else if (lowerText.includes('1k') || lowerText.includes('标') || lowerText.includes('标准')) {
          parsedResolution = '1K';
          wasResolutionChosen = true;
          feedback.push('⚡ 渲染分辨率已设为：1K (标准画质)');
        }
      }

      if (stage === 'options-lighting' && !wasLightingChosen) {
        if (lowerText.includes('暖') || lowerText.includes('黄') || lowerText.includes('温馨')) {
          parsedLighting = '暖色调';
          wasLightingChosen = true;
          feedback.push('💡 艺术光影基调已设为：暖色调 (温馨舒适，宾至如归)');
        } else if (lowerText.includes('白') || lowerText.includes('清新') || lowerText.includes('亮') || lowerText.includes('浅')) {
          parsedLighting = '清新浅色';
          wasLightingChosen = true;
          feedback.push('💡 艺术光影基调已设为：清新浅色 (透亮清爽，洁净宜人)');
        } else if (lowerText.includes('黑') || lowerText.includes('暗') || lowerText.includes('雅') || lowerText.includes('奢')) {
          parsedLighting = '高端暗色';
          wasLightingChosen = true;
          feedback.push('💡 艺术光影基调已设为：高端暗色 (典雅深邃，质感非凡)');
        }
      }

      if (stage === 'options-decor' && !wasDecorChosen) {
        if (lowerText.includes('开') || lowerText.includes('要') || lowerText.includes('是') || lowerText.includes('需要') || lowerText.includes('加')) {
          parsedDecor = true;
          wasDecorChosen = true;
          feedback.push('🌸 装饰装潢：已开启智能空间配饰推荐点缀');
        } else if (lowerText.includes('不') || lowerText.includes('否') || lowerText.includes('仅清洁') || lowerText.includes('关') || lowerText.includes('去')) {
          parsedDecor = false;
          wasDecorChosen = true;
          feedback.push('🍃 装饰装潢：不额外增加新配饰，保持原格局仅进行材质修复与提亮');
        }
      }

      // If they are on final stage and say "不开启软装" or "不要软装了" etc., parse it
      if ((stage === 'decor-checkboxes' || stage === 'beautify-trigger') && !wasDecorChosen) {
        if (lowerText.includes('不') || lowerText.includes('关') || lowerText.includes('去') || lowerText.includes('清洁') || lowerText.includes('不要')) {
          parsedDecor = false;
          wasDecorChosen = true;
          feedback.push('🍃 装饰装潢已变更为：不开启软装配饰，仅进行清洁材质提亮');
        } else if (lowerText.includes('开') || lowerText.includes('要') || lowerText.includes('加') || lowerText.includes('软装')) {
          parsedDecor = true;
          wasDecorChosen = true;
          feedback.push('🌸 装饰装潢已变更为：已开启智能空间配饰推荐点缀');
        }
      }

      // Apply options changes if parsed
      if (parsedRatio) {
        setOptions(prev => ({ ...prev, ratio: parsedRatio }));
        setIsRatioSelected(true);
      }
      if (parsedResolution) {
        setOptions(prev => ({ ...prev, resolution: parsedResolution }));
        setIsResolutionSelected(true);
      }
      if (parsedLighting) {
        setOptions(prev => ({ ...prev, lighting: parsedLighting }));
        setIsLightingSelected(true);
        currentLighting = parsedLighting;
      }
      if (parsedDecor !== null) {
        setAllowAdditions(parsedDecor);
        setIsDecorSelected(true);
        currentDecor = parsedDecor;
      }

      // 5. Trigger word check to start beautification automatically if requested
      const isTriggerWord = (lowerText.includes('开始') || lowerText.includes('一键美化') || lowerText.includes('生成') || lowerText.includes('画') || lowerText.includes('渲染')) && !lowerText.includes('不') && !lowerText.includes('关闭');
      if (isTriggerWord) {
        if (!originalImage) {
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-resp-' + Date.now(),
              sender: 'ai',
              text: '💡 请先上传您的餐厅原始照片 📸 才能开始进行设计美化生成哦！您可以通过点击下方的「选择原图」按钮或拖拽图片进行上传。',
              type: 'image-upload'
            }
          ]);
          return;
        } else if (!analysisResult) {
          // It's still analyzing! Setup pending beautification config
          const finalRatio = isRatioSelected ? (parsedRatio || options.ratio) : '1:1';
          const finalResolution = isResolutionSelected ? (parsedResolution || options.resolution) : '1K';
          const finalDecor = isDecorSelected ? (parsedDecor !== null ? parsedDecor : allowAdditions) : false;
          
          beautifyPendingRef.current = {
            pending: true,
            options: {
              ratio: finalRatio,
              lighting: parsedLighting || options.lighting,
              resolution: finalResolution
            },
            allowAdditions: finalDecor
          };

          setMessages(prev => [
            ...prev,
            {
              id: 'ai-pending-beautify-' + Date.now(),
              sender: 'ai',
              text: `🚀 收到一键生成指令！正在为您加速进行空间特征审视与智能分析中。\n分析完成后，将自动应用默认/当前设计预设（比例: ${finalRatio}, 分辨率: ${finalResolution}, 软装: ${finalDecor ? '开启' : '不开启'}）直接启动一键美化，请稍等片刻... ⏳`
            }
          ]);
          return;
        } else {
          // Both image and analysis results are ready!
          // Apply defaults if they haven't chosen them yet
          const finalRatio = isRatioSelected ? (parsedRatio || options.ratio) : '1:1';
          const finalResolution = isResolutionSelected ? (parsedResolution || options.resolution) : '1K';
          const finalDecor = isDecorSelected ? (parsedDecor !== null ? parsedDecor : allowAdditions) : false;
          const finalLighting = parsedLighting || options.lighting;

          const overriddenOptions = {
            ratio: finalRatio,
            resolution: finalResolution,
            lighting: finalLighting
          };

          // Synchronously set state so the UI updates
          setOptions(overriddenOptions);
          setAllowAdditions(finalDecor);
          setIsRatioSelected(true);
          setIsResolutionSelected(true);
          setIsDecorSelected(true);

          handleBeautifyInChat(overriddenOptions, finalDecor);
          return;
        }
      }

      // 6. Record descriptive custom requirement
      let remainingText = lowerText;
      remainingText = remainingText.replace(/(16:9|4:3|1:1|3:4|9:16|16比9|4比3|1比1|3比4|9比16|正方形|宽屏|横屏|竖屏|手机屏幕|手机竖屏|竖版|横版|比例)/g, '');
      remainingText = remainingText.replace(/(4k|2k|1k|uhd|hd|超清|高清|标清|分辨率|清晰度)/g, '');
      remainingText = remainingText.replace(/(暖色调|暖调|暖光|温馨|黄光|清新浅色|清新|浅色|白光|明亮|冷光|高端暗色|高端|暗色|奢华|雅致|暗调|高奢|艺术基调|光影)/g, '');
      remainingText = remainingText.replace(/(不开启软装|不加配饰|不加装饰|纯净清洁|仅清洁|仅做清洁|关闭软装|不开启配饰|关闭配饰|不要软装|关闭软装推荐|开启软装|加配饰|开启配饰|添加配饰|添加软装|要软装|开启软装推荐|软装|配饰|点缀|装饰|不用)/g, '');
      
      const cleanRemaining = remainingText.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()？?，。！：]/g, '').trim();
      const hasActualCustomRequest = cleanRemaining.length >= 2;

      if (hasActualCustomRequest) {
        extraReq = text;
        setCustomRequirements(prev => {
          if (prev.includes(text)) return prev;
          return [...prev, text];
        });
        feedback.push(`✏️ 特别美化要求已录入："${text}"`);
      }

      if (!originalImage) {
        setMessages(prev => [
          ...prev,
          {
            id: 'ai-resp-' + Date.now(),
            sender: 'ai',
            text: '已收到您的指令，并成功更新设计预设！请先上传您的餐厅原始照片 📸 开启智能设计美化。点击下方「选择原图」按钮即可。',
            type: 'image-upload'
          }
        ]);
      } else if (!analysisResult) {
        setMessages(prev => [
          ...prev,
          {
            id: 'ai-resp-' + Date.now(),
            sender: 'ai',
            text: '已收到您的特别指令，并已更新至设计指令集中！我已经收到您的照片了，正在为您开启智能分析。'
          }
        ]);
      } else {
        const feedbackPrefix = feedback.length > 0 
          ? `✨ 已为您解析并实时更新设计指令：\n${feedback.map(f => ` - ${f}`).join('\n')}\n\n` 
          : '';

        // Dialog State Machine - Dynamic & Adaptive State-Skipping Pipeline
        const isRatioDone = isRatioSelected || !!parsedRatio;
        const isResDone = isResolutionSelected || !!parsedResolution;
        const isLightingDone = isLightingSelected || !!parsedLighting;
        const isDecorDone = isDecorSelected || (parsedDecor !== null);

        if (!isRatioDone) {
          // Ratio is missing
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-ratio-ask-' + Date.now(),
              sender: 'ai',
              text: `${feedbackPrefix}为了呈现最符合您心意的美化图，请选择您期望的「画面比例（尺寸）」📐：`,
              type: 'options-ratio'
            }
          ]);
        } else if (!isResDone) {
          // Resolution is missing
          const ratioVal = parsedRatio || options.ratio;
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-resolution-ask-' + Date.now(),
              sender: 'ai',
              text: `${feedbackPrefix}已确认画面比例为「${ratioVal}」！接下来，请选择您需要的「画面清晰度（分辨率）」💎：`,
              type: 'options-resolution'
            }
          ]);
        } else if (!isLightingDone) {
          // Lighting is missing
          const resVal = parsedResolution || options.resolution;
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-lighting-ask-' + Date.now(),
              sender: 'ai',
              text: `${feedbackPrefix}已确认分辨率为「${resVal}」！接下来，请选择您期望的「艺术基调（光影优化效果）」💡：\n(已根据您的餐厅推荐: ${analysisResult?.recommendedLighting || '暖色调'})`,
              type: 'options-lighting'
            }
          ]);
        } else if (!isDecorDone) {
          // Decor is missing
          const lightingVal = currentLighting;
          setMessages(prev => [
            ...prev,
            {
              id: 'ai-decor-ask-' + Date.now(),
              sender: 'ai',
              text: `${feedbackPrefix}已确认艺术基调为「${lightingVal}」！接下来，是否开启「智能空间软装推荐」？\n开启后，AI 将在场景中推荐增加软装饰品或绿植。若关闭，则纯粹进行去杂物清洗与质感提亮。`,
              type: 'options-decor'
            }
          ]);
        } else {
          // All parameters are collected! Present final summary & action triggers
          const finalDecor = currentDecor !== null ? currentDecor : allowAdditions;
          const finalRatio = parsedRatio || options.ratio;
          const finalResolution = parsedResolution || options.resolution;
          const finalLighting = currentLighting;

          if (finalDecor === true) {
            setMessages(prev => [
              ...prev,
              {
                id: 'ai-decor-items-' + Date.now(),
                sender: 'ai',
                text: `${feedbackPrefix}全部设计参数已配置完成！📐比例：${finalRatio} | 💎分辨率：${finalResolution} | 💡艺术基调：${finalLighting}。已开启智能空间配饰推荐点缀！为您定制推荐了以下几项软装升级，您可以自由挑选：`,
                type: 'decor-checkboxes'
              }
            ]);
          } else {
            setMessages(prev => [
              ...prev,
              {
                id: 'ai-beautify-ready-' + Date.now(),
                sender: 'ai',
                text: `${feedbackPrefix}全部设计参数配置完成！📐比例：${finalRatio} | 💎分辨率：${finalResolution} | 💡艺术基调：${finalLighting}。我们将保持原有的陈设，纯净清洗除垢，提升材质的高级质感。请确认设计预设无误，点击开始一键美化。`,
                type: 'beautify-trigger'
              }
            ]);
          }
        }
      }
    }, 800);
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
    
    // 1. Verify Before Generation
    if (userId && toolId) {
      setIsBeautifying(true);
      try {
        const verifyRes = await fetch('/api/tool/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          setError(verifyData.message || '积分不足');
          setIsBeautifying(false);
          return;
        }
      } catch (err) {
        console.error('Verify failed:', err);
      }
    } else {
      setIsBeautifying(true);
    }

    setError(null);
    try {
      // 2. AI Generate
      const resultImageBase64 = await beautifyRestaurantImage(
        originalImage.base64,
        originalImage.mimeType,
        analysisResult,
        options,
        allowAdditions,
        customRequirements
      );

      // Display immediately
      setBeautifiedImage(resultImageBase64);
      setHistory(prev => [resultImageBase64, ...prev]);

      // 3. Consume
      if (userId && toolId) {
        let currentIntegral = userInfo?.integral;
        const consumeRes = await fetch('/api/tool/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId })
        });
        const consumeData = await consumeRes.json();
        
        if (!consumeData.success) {
           console.error("consume failed, skip upload", consumeData);
           return;
        }
        
        if (consumeData.success && consumeData.data) {
          currentIntegral = consumeData.data.currentIntegral;
          setUserInfo(prev => prev ? { ...prev, integral: consumeData.data.currentIntegral } : null);
        }

        // 4. Direct Token
        const base64Data = resultImageBase64.replace(/^data:image\/\w+;base64,/, '');
        const binaryString = window.atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const fileSize = bytes.byteLength;
        const blob = new Blob([bytes], { type: 'image/png' }); // Gemini typically returns PNG for images

        const tokenRes = await fetch('/api/upload/direct-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, toolId, source: 'result', mimeType: 'image/png', fileName: 'result.png', fileSize })
        });
        const token = await tokenRes.json();

        if (token.success) {
          // 6. PUT to OSS
          const uploadRes = await fetch(token.uploadUrl, {
            method: token.method || 'PUT',
            headers: token.headers,
            body: blob
          });

          if (uploadRes.ok) {
            // 7. Commit
            const commitRes = await fetch('/api/upload/commit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId,
                toolId,
                source: 'result',
                objectKey: token.objectKey,
                fileSize
              })
            });
            const commit = await commitRes.json();
            if (commit.savedToRecords) {
                console.log("Successfully uploaded to SaaS OSS and committed:", commit.image);
                if (commit.image && commit.image.url) {
                  setBeautifiedImage(commit.image.url);
                  setHistory(prev => {
                    const newHistory = [...prev];
                    newHistory[0] = commit.image.url;
                    return newHistory;
                  });
                }
            }
          }
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
    <div className="h-screen flex flex-col bg-[#FDFCFB] text-[#3D3935] font-sans relative overflow-hidden">
      <div className="absolute top-[-15%] left-[-10%] w-[70%] sm:w-[50%] h-[50%] bg-[#E8EDE7] rounded-full blur-[120px] opacity-40 pointer-events-none" />
      <div className="absolute bottom-[-15%] right-[-10%] w-[70%] sm:w-[50%] h-[50%] bg-[#F5EDE6] rounded-full blur-[120px] opacity-40 pointer-events-none" />

      <header className="bg-white/60 backdrop-blur-xl border-b border-[#EAE3DC] sticky top-0 z-50 shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 sm:h-20 flex items-center justify-between">
          <div 
            className="flex items-center gap-2 sm:gap-3 cursor-pointer group hover:opacity-85 transition-opacity"
            onClick={() => setMode('landing')}
          >
            <div className="bg-[#3D3935] p-1.5 sm:p-2 rounded-lg sm:rounded-xl shrink-0 group-hover:scale-105 transition-transform duration-300">
              <Wand2 className="w-3.5 h-3.5 sm:w-5 sm:h-5 text-white" />
            </div>
            <h1 className="text-base sm:text-2xl font-serif font-semibold tracking-tight text-[#3D3935] truncate max-w-[150px] sm:max-w-none">餐厅一键美化</h1>
          </div>

          <div className="flex items-center gap-2 sm:gap-6">
            {mode !== 'landing' && (
              <button
                onClick={() => setMode('landing')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-[#6B6661] hover:text-[#3D3935] bg-[#F2F0ED] hover:bg-[#EAE3DC] rounded-xl border border-[#EAE3DC] transition-all"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>返回主页</span>
              </button>
            )}
            {userInfo && (
              <div className="flex items-center gap-1 sm:gap-1.5 px-2.5 py-1 sm:px-3 sm:py-1.5 bg-white/50 backdrop-blur-sm rounded-full border border-[#EAE3DC] shadow-sm">
                <Coins className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#C18C5D]" />
                <span className="text-[10px] sm:text-sm font-bold text-[#6B6661] whitespace-nowrap">{userInfo.integral}</span>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-4 sm:px-6 relative z-10 flex flex-col flex-1 min-h-0 overflow-hidden py-3 sm:py-4">
        {mode === 'landing' ? (
          <div className="flex-1 w-full max-w-5xl mx-auto flex flex-col items-center justify-center py-4 sm:py-6 animate-in fade-in zoom-in-95 duration-500 overflow-y-auto no-scrollbar">
            {/* Badge */}
            <div className="mb-6 bg-white px-3.5 py-1.5 text-xs text-[#6B6661] font-bold border border-[#EAE3DC] rounded-full inline-flex items-center gap-1.5 shadow-sm">
              <span>🏠 餐厅美化智能助手 V4.0</span>
            </div>

            {/* Heading */}
            <h2 className="text-3xl sm:text-5xl font-serif font-semibold tracking-tight text-[#3D3935] text-center mt-2 max-w-3xl leading-tight">
              开启您的 AI 餐厅美化之旅
            </h2>

            {/* Subheading */}
            <p className="text-xs sm:text-sm text-[#9B9691] max-w-2xl mx-auto mt-5 text-center leading-relaxed">
              无论您是希望得到贴心的智能设计助理引导，还是渴望在全功能的专业面板上精细调校，我们都为您提供了专属的使用方案。
            </p>

            {/* Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full max-w-4xl mt-12 sm:mt-16">
              {/* Agent Mode Card */}
              <div className="bg-white/90 backdrop-blur-md rounded-3xl border border-[#EAE3DC] p-6 sm:p-8 flex flex-col justify-between shadow-[0_15px_40px_rgba(141,163,153,0.05)] hover:shadow-[0_20px_50px_rgba(141,163,153,0.1)] transition-all duration-300 h-full group">
                <div className="space-y-6">
                  {/* Icon */}
                  <div className="w-12 h-12 rounded-2xl bg-[#E8EDE7] border border-[#D9E2D7] text-[#4A5D4F] flex items-center justify-center shadow-sm">
                    <Sparkles className="w-6 h-6" />
                  </div>
                  {/* Title & Tag */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-lg sm:text-xl font-serif font-bold text-[#3D3935]">智能体模式</h3>
                      <span className="text-[10px] bg-[#E8EDE7] text-[#4A5D4F] border border-[#D9E2D7] px-2.5 py-0.5 rounded-md font-bold tracking-wider font-sans whitespace-nowrap">推荐新手</span>
                    </div>
                    <p className="text-xs sm:text-sm text-[#9B9691] leading-relaxed">
                      对话式交互，像和专业设计师聊天一样。AI 将一步步引导您选择餐厅照片、艺术光影、开启软装定制，直接在聊天框内返回生成效果。
                    </p>
                  </div>
                </div>
                {/* Button */}
                <button
                  onClick={() => setMode('agent')}
                  className="w-full mt-8 py-3 bg-[#3D3935] hover:bg-black text-white font-bold rounded-xl text-sm transition-all flex items-center justify-center gap-2 shadow-sm transform group-hover:-translate-y-0.5 duration-200"
                >
                  <Bot className="w-4 h-4" />
                  <span>开启智能对话引导</span>
                </button>
              </div>

              {/* Expert Mode Card */}
              <div className="bg-white/90 backdrop-blur-md rounded-3xl border border-[#EAE3DC] p-6 sm:p-8 flex flex-col justify-between shadow-[0_15px_40px_rgba(141,163,153,0.05)] hover:shadow-[0_20px_50px_rgba(141,163,153,0.1)] transition-all duration-300 h-full group">
                <div className="space-y-6">
                  {/* Icon */}
                  <div className="w-12 h-12 rounded-2xl bg-[#F2F0ED] border border-[#EAE3DC] text-[#3D3935] flex items-center justify-center shadow-sm">
                    <Settings className="w-6 h-6" />
                  </div>
                  {/* Title & Tag */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-lg sm:text-xl font-serif font-bold text-[#3D3935]">专家工作台</h3>
                      <span className="text-[10px] bg-[#F2F0ED] text-[#6B6661] border border-[#EAE3DC] px-2.5 py-0.5 rounded-md font-bold tracking-wider font-sans whitespace-nowrap">高阶微调</span>
                    </div>
                    <p className="text-xs sm:text-sm text-[#9B9691] leading-relaxed">
                      经典分步流程。提供高可控性的输出设置、画面比例调节，支持针对性细节美化、推荐配饰按需增减。
                    </p>
                  </div>
                </div>
                {/* Button */}
                <button
                  onClick={() => setMode('expert')}
                  className="w-full mt-8 py-3 bg-[#F2F0ED] hover:bg-[#EAE3DC] text-[#3D3935] border border-[#EAE3DC] font-bold rounded-xl text-sm transition-all flex items-center justify-center gap-2 shadow-sm transform group-hover:-translate-y-0.5 duration-200"
                >
                  <Settings className="w-4 h-4" />
                  <span>进入设计师工作台</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {error && (
              <div className="mb-6 sm:mb-8 p-4 sm:p-5 bg-red-50/70 backdrop-blur-sm border border-red-100 rounded-2xl sm:rounded-[2rem] flex items-start gap-3 sm:gap-4 text-red-800 shadow-sm animate-in fade-in slide-in-from-top-2">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
                <p className="text-xs sm:text-sm font-medium">{error}</p>
              </div>
            )}

            {mode === 'agent' ? (
          <div className="flex-1 w-full max-w-4xl mx-auto flex flex-col bg-white/70 backdrop-blur-xl border border-[#EAE3DC] rounded-3xl overflow-hidden shadow-[0_20px_50px_rgba(141,163,153,0.06)] min-h-0">
            {/* Live Design Parameters & Custom Requirements Summary */}
            <div className="bg-[#FBF9F6] border-b border-[#EAE3DC] px-4 py-2.5 sm:px-6 flex flex-wrap items-center justify-between gap-3 text-xs text-[#6B6661]">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="font-bold text-[#3D3935] flex items-center gap-1">🛠️ 当前设计预设：</span>
                <span className="bg-white px-2 py-0.5 rounded-md border border-[#EAE3DC] font-medium">比例: {options.ratio}</span>
                <span className="bg-white px-2 py-0.5 rounded-md border border-[#EAE3DC] font-medium">基调: {options.lighting}</span>
                <span className="bg-white px-2 py-0.5 rounded-md border border-[#EAE3DC] font-medium">分辨率: {options.resolution}</span>
                <span className="bg-white px-2 py-0.5 rounded-md border border-[#EAE3DC] font-medium">配饰: {allowAdditions ? '开启' : '关闭'}</span>
              </div>
              {customRequirements.length > 0 && (
                <div className="flex items-center gap-2 max-w-full">
                  <span className="font-bold text-[#4A5D4F] shrink-0">✏️ 已录入对话要求 ({customRequirements.length})：</span>
                  <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-0.5 max-w-[200px] sm:max-w-xs">
                    {customRequirements.map((req, idx) => (
                      <span 
                        key={idx} 
                        className="bg-[#E8EDE7] text-[#4A5D4F] border border-[#D9E2D7] px-2 py-0.5 rounded-md font-medium text-[10px] whitespace-nowrap flex items-center gap-1"
                      >
                        <span className="truncate max-w-[80px]">{req}</span>
                        <button 
                          onClick={() => setCustomRequirements(prev => prev.filter((_, i) => i !== idx))}
                          className="hover:text-red-500 font-bold ml-0.5"
                          title="删除该要求"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Chat Messages */}
            <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 scrollbar-thin scrollbar-thumb-[#EAE3DC] scrollbar-track-transparent">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex items-start gap-3 sm:gap-4 ${msg.sender === 'user' ? 'flex-row-reverse' : ''} animate-in fade-in duration-300`}
                >
                  {/* Avatar */}
                  <div className={`w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 shadow-sm border ${msg.sender === 'user' ? 'bg-[#3D3935] border-[#3D3935] text-white' : 'bg-[#E8EDE7] border-[#D9E2D7] text-[#4A5D4F]'}`}>
                    {msg.sender === 'user' ? <User className="w-4 h-4 sm:w-5 sm:h-5" /> : <Bot className="w-4 h-4 sm:w-5 sm:h-5" />}
                  </div>

                  {/* Bubble content */}
                  <div className="max-w-[80%] space-y-2">
                    <div className={`rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 text-xs sm:text-sm leading-relaxed shadow-sm border ${msg.sender === 'user' ? 'bg-[#3D3935] text-white border-[#3D3935] rounded-tr-none' : 'bg-white border-[#EAE3DC] text-[#3D3935] rounded-tl-none'}`}>
                      {msg.text.split('\n').map((line, i) => <p key={i}>{line}</p>)}
                      
                      {/* Image Preview inside text */}
                      {msg.image && msg.type !== 'result-card' && (
                        <div className="mt-3 rounded-xl overflow-hidden border border-[#EAE3DC] max-w-sm cursor-pointer" onClick={() => { if (msg.type !== 'image-upload') { setBeautifiedImage(msg.image!); setIsModalOpen(true); } }}>
                          <img src={msg.image} alt="Message attach" className="w-full max-h-48 object-cover" />
                        </div>
                      )}

                      {/* Interactive block - Image Upload */}
                      {msg.type === 'image-upload' && (
                        <div className="mt-4">
                          {!originalImage ? (
                            <div
                              onClick={() => fileInputRef.current?.click()}
                              onDragOver={handleChatDragOver}
                              onDragLeave={handleChatDragLeave}
                              onDrop={handleChatDrop}
                              className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center transition-all cursor-pointer group ${isChatDragging ? 'border-[#8DA399] bg-[#E8EDE7]/50 scale-[1.02]' : 'border-[#8DA399] bg-[#FDFCFB]/80 hover:bg-[#F2F0ED]/30 animate-pulse'}`}
                            >
                              <Upload className="w-6 h-6 text-[#8DA399] mb-2" />
                              <span className="text-xs font-bold text-[#6B6661]">选择您想要美化的餐厅照片</span>
                            </div>
                          ) : (
                            <div className="border border-[#E8EDE7] bg-[#E8EDE7]/30 rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <ImageIcon className="w-4 h-4 text-[#8DA399]" />
                                <span className="text-xs text-[#6B6661] font-semibold truncate max-w-[150px]">已上传原图</span>
                              </div>
                              <button
                                onClick={handleRestartInChat}
                                className="text-xs text-red-500 hover:text-red-600 transition-colors font-bold"
                              >
                                重新选择
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Interactive block - Analysis result */}
                      {msg.type === 'analysis-result' && (analysisResult || msg.meta) && (() => {
                        const activeAnalysis = analysisResult || msg.meta;
                        return (
                          <div className="mt-4 space-y-3 pt-3 border-t border-[#EAE3DC]/60 text-xs text-[#6B6661]">
                            <div className="bg-[#F9F8F6] p-3 rounded-lg border border-[#EAE3DC]">
                              <span className="font-bold block text-[#3D3935] mb-1">📐 空间格局</span>
                              {activeAnalysis.layout}
                            </div>
                            <div className="bg-[#F9F8F6] p-3 rounded-lg border border-[#EAE3DC]">
                              <span className="font-bold block text-[#3D3935] mb-1">🏺 空间风格</span>
                              {activeAnalysis.style}
                            </div>
                            <div className="bg-[#E8EDE7]/60 p-3 rounded-lg border border-[#D9E2D7]">
                              <span className="font-bold block text-[#4A5D4F] mb-1">💡 推荐光影逻辑</span>
                              {activeAnalysis.lightingReason}
                            </div>
                            <div className="space-y-1.5">
                              <span className="font-bold block text-[#3D3935] mt-2">✨ 空间核心美化方案：</span>
                              {activeAnalysis.beautifyPoints.map((pt: string, idx: number) => (
                                <div key={idx} className="flex items-center justify-between gap-1.5 bg-[#FDFCFB] px-2.5 py-1.5 rounded-lg border border-[#EAE3DC]/60 group/item transition-all">
                                  <div className="flex items-center gap-1.5">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-[#8DA399] shrink-0" />
                                    <span>{pt}</span>
                                  </div>
                                  <button
                                    onClick={() => {
                                      const newPoints = activeAnalysis.beautifyPoints.filter((_, i) => i !== idx);
                                      setAnalysisResult({ ...activeAnalysis, beautifyPoints: newPoints });
                                    }}
                                    className="p-1 text-[#9B9691] hover:text-red-500 rounded transition-all opacity-0 group-hover/item:opacity-100"
                                    title="删除此建议"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="text-[10px] text-[#9B9691] italic bg-[#F2F0ED]/40 p-2 rounded-lg border border-dashed border-[#EAE3DC] mt-2 leading-relaxed">
                              💡 提示：您可直接在下方对话框发送「增加 建议内容」或「删除 建议内容」来智能增删列表项。
                            </div>
                            <button
                              onClick={() => {
                                setMessages(prev => [...prev, {
                                  id: 'ratio-choice-' + Date.now(),
                                  sender: 'ai',
                                  text: `好的，确认建议后，请选择您期望的「画面比例（尺寸）」📐：`,
                                  type: 'options-ratio'
                                }]);
                              }}
                              className="w-full mt-3 py-2.5 bg-[#3D3935] text-white text-xs font-bold rounded-lg shadow-sm hover:opacity-90 transition-all active:scale-95"
                            >
                              确认建议，进入下一步：选择画面比例
                            </button>
                          </div>
                        );
                      })()}

                      {/* Interactive block - Ratio Options */}
                      {msg.type === 'options-ratio' && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {['1:1', '16:9', '4:3', '3:4', '9:16'].map((val) => (
                            <button
                              key={val}
                              onClick={() => handleSelectRatioInChat(val)}
                              className="px-4 py-2 bg-[#F2F0ED] hover:bg-[#3D3935] hover:text-white border border-[#EAE3DC] rounded-xl text-xs font-bold transition-all transform active:scale-95 text-[#6B6661]"
                            >
                              {val === '1:1' ? '1:1 (正方形比例)' : val === '16:9' ? '16:9 (横屏比例)' : val === '4:3' ? '4:3 (标准横屏)' : val === '3:4' ? '3:4 (标准竖屏)' : '9:16 (手机竖屏)'}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Interactive block - Resolution Options */}
                      {msg.type === 'options-resolution' && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {['1K', '2K', '4K'].map((val) => (
                            <button
                              key={val}
                              onClick={() => handleSelectResolutionInChat(val)}
                              className="px-4 py-2 bg-[#F2F0ED] hover:bg-[#3D3935] hover:text-white border border-[#EAE3DC] rounded-xl text-xs font-bold transition-all transform active:scale-95 text-[#6B6661]"
                            >
                              {val === '1K' ? '1K (标准清晰度)' : val === '2K' ? '2K (高清重绘)' : '4K (极致超清重绘)'}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Interactive block - Lighting Options */}
                      {msg.type === 'options-lighting' && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {['暖色调', '清新浅色', '高端暗色'].map((val) => (
                            <button
                              key={val}
                              onClick={() => handleSelectLightingInChat(val)}
                              className="px-4 py-2 bg-[#F2F0ED] hover:bg-[#3D3935] hover:text-white border border-[#EAE3DC] rounded-xl text-xs font-bold transition-all transform active:scale-95 text-[#6B6661]"
                            >
                              {val}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Interactive block - Decor Yes/No Options */}
                      {msg.type === 'options-decor' && (
                        <div className="mt-4 flex gap-3">
                          <button
                            onClick={() => handleSelectDecorInChat(true)}
                            className="flex-1 py-2 bg-[#8DA399] hover:bg-[#7C9288] text-white rounded-xl text-xs font-bold transition-all transform active:scale-95 flex items-center justify-center gap-1.5"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>启用软装推荐</span>
                          </button>
                          <button
                            onClick={() => handleSelectDecorInChat(false)}
                            className="flex-1 py-2 bg-[#F2F0ED] hover:bg-[#3D3935] hover:text-white border border-[#EAE3DC] text-[#6B6661] rounded-xl text-xs font-bold transition-all transform active:scale-95 flex items-center justify-center gap-1.5"
                          >
                            <span>不启用，仅纯净清洁</span>
                          </button>
                        </div>
                      )}

                      {/* Interactive block - Decor checklists */}
                      {msg.type === 'decor-checkboxes' && analysisResult?.recommendedAdditions && (
                        <div className="mt-4 space-y-3 border-t border-[#EAE3DC]/60 pt-3">
                          <div className="space-y-2">
                            {analysisResult.recommendedAdditions.map((add, idx) => (
                              <div
                                key={idx}
                                className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition-all group/decor ${add.enabled ? 'bg-[#E8EDE7]/30 border-[#8DA399]/30' : 'bg-gray-50/50 border-[#EAE3DC]'}`}
                              >
                                <div className="flex-1 cursor-pointer" onClick={() => handleToggleAddition(idx)}>
                                  <span className="font-bold text-xs block text-[#3D3935]">{add.item}</span>
                                  <span className="text-[10px] text-[#9B9691] italic">{add.reason}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const newAdditions = analysisResult.recommendedAdditions.filter((_, i) => i !== idx);
                                      setAnalysisResult({ ...analysisResult, recommendedAdditions: newAdditions });
                                    }}
                                    className="p-1 text-[#9B9691] hover:text-red-500 rounded transition-all opacity-0 group-hover/decor:opacity-100"
                                    title="删除此项"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                  <div
                                    onClick={() => handleToggleAddition(idx)}
                                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 cursor-pointer transition-all ${add.enabled ? 'bg-[#8DA399] border-[#8DA399] text-white' : 'border-[#EAE3DC] bg-white'}`}
                                  >
                                    {add.enabled && <Check className="w-2.5 h-2.5 text-white" />}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="text-[10px] text-[#9B9691] italic bg-[#F2F0ED]/40 p-2 rounded-lg border border-dashed border-[#EAE3DC] mt-1 leading-relaxed">
                            💡 提示：您可直接在下方对话框发送「增加 软装物品」或「删除 软装物品」来智能配置软装方案。
                          </div>
                          <button
                            onClick={handleBeautifyInChat}
                            className="w-full py-2.5 bg-[#3D3935] hover:bg-black text-white font-bold rounded-xl text-xs transition-all flex items-center justify-center gap-1.5 shadow-md"
                          >
                            <Wand2 className="w-4 h-4 animate-pulse" />
                            <span>确认配饰并开始美化</span>
                          </button>
                        </div>
                      )}

                      {/* Interactive block - Trigger */}
                      {msg.type === 'beautify-trigger' && (
                        <div className="mt-4">
                          <button
                            onClick={handleBeautifyInChat}
                            className="w-full py-3 bg-[#3D3935] hover:bg-black text-white font-bold rounded-xl text-xs sm:text-sm transition-all flex items-center justify-center gap-2 shadow-md"
                          >
                            <Wand2 className="w-4 h-4 animate-pulse" />
                            <span>立即一键美化 (10 积分)</span>
                          </button>
                        </div>
                      )}

                      {/* Interactive block - Loading Indicator */}
                      {msg.type === 'loading' && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-[#8DA399] font-medium animate-pulse">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>AI 重绘画卷正在徐徐铺开...</span>
                        </div>
                      )}

                      {/* Interactive block - Result Card */}
                      {msg.type === 'result-card' && msg.image && (
                        <div className="mt-4 space-y-4">
                          <div className="relative rounded-xl overflow-hidden border border-[#EAE3DC] aspect-video bg-gray-50 flex items-center justify-center shadow-inner group">
                            <img src={msg.image} alt="Result card illustration" className="max-w-full max-h-full object-contain" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center cursor-pointer" onClick={() => { setBeautifiedImage(msg.image!); setIsModalOpen(true); }}>
                              <span className="opacity-0 group-hover:opacity-100 bg-white/95 text-[#3D3935] text-xs px-3 py-1.5 rounded-lg shadow-lg font-bold transition-all">全屏查看</span>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => { setBeautifiedImage(msg.image!); setIsModalOpen(true); }}
                              className="flex-1 py-2 bg-[#F2F0ED] hover:bg-[#3D3935] hover:text-white border border-[#EAE3DC] text-[#6B6661] text-xs font-bold rounded-xl transition-all"
                            >
                              放大细节
                            </button>
                            <button
                              onClick={handleDownload}
                              className="flex-1 py-2 bg-[#8DA399] hover:bg-[#7C9288] text-white text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1"
                            >
                              <Download className="w-3.5 h-3.5" />
                              <span>保存下载</span>
                            </button>
                            <button
                              onClick={handleRestartInChat}
                              className="py-2 px-3 bg-white hover:bg-red-50 border border-red-100 text-red-500 rounded-xl transition-all flex items-center justify-center"
                              title="重新美化一张"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Chat Input Bar */}
            <div className="p-4 sm:p-5 bg-white border-t border-[#EAE3DC]/80 flex items-center gap-3">
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSendMessage(inputMessage); }}
                className="flex-1 px-4 py-3 bg-[#F9F8F6] border border-[#EAE3DC] rounded-xl text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#8DA399]/20 focus:border-[#8DA399] transition-all"
                placeholder={originalImage ? "发送指令（如：选择暖色调、新增建议：放置大型盆栽、删除小型绿植）" : "请先选择原图上传..."}
              />
              <button
                onClick={() => handleSendMessage(inputMessage)}
                className="p-3 bg-[#3D3935] hover:bg-black text-white rounded-xl transition-all active:scale-95 shrink-0"
              >
                <Send className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-10 items-stretch min-h-0 overflow-hidden">
          {/* Left Column: Image Area */}
          <div className="h-full flex flex-col gap-6 overflow-y-auto pr-1.5 -mr-1.5 scrollbar-thin scrollbar-thumb-[#EAE3DC] scrollbar-track-transparent pb-4">
            <div className={`glass-panel p-5 sm:p-8 rounded-3xl lg:rounded-[2.5rem] ${!originalImage ? 'flex-1 flex flex-col min-h-0' : ''}`}>
              <h2 className="text-lg sm:text-xl font-serif font-semibold mb-4 sm:mb-6 flex items-center gap-3 sm:gap-4 text-[#3D3935] shrink-0">
                <span className="flex items-center justify-center w-6 h-6 sm:w-8 sm:h-8 rounded-full bg-[#F2F0ED] text-[#6B6661] text-[10px] sm:text-xs font-sans shadow-inner">01</span>
                图片上传
              </h2>
              
              {!originalImage ? (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`flex-1 border-2 border-dashed rounded-2xl sm:rounded-[2rem] p-8 sm:p-16 flex flex-col items-center justify-center text-[#9B9691] transition-all cursor-pointer group ${isDragging ? 'border-[#8DA399] bg-[#E8EDE7]/50 scale-[1.01]' : 'border-[#EAE3DC] hover:bg-[#FDFCFB] hover:border-[#8DA399]'}`}
                >
                  <div className="bg-white p-4 sm:p-5 rounded-2xl sm:rounded-3xl shadow-[0_10px_20px_rgba(0,0,0,0.03)] mb-4 sm:mb-6 group-hover:scale-105 transition-transform duration-500">
                    <Upload className="w-8 h-8 sm:w-10 sm:h-10 text-[#8DA399] opacity-70 group-hover:opacity-100" />
                  </div>
                  <p className="text-sm sm:text-base font-semibold text-[#6B6661] text-center">点击或拖拽上传餐厅图片</p>
                  <p className="text-xs mt-2 text-[#9B9691] text-center">支持 JPG, PNG, WebP，最大 20MB</p>
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
                      disabled={isAnalyzing}
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
          <div className="h-full flex flex-col min-h-0 overflow-hidden pb-4">
            {!analysisResult ? (
              <div className="glass-panel p-8 sm:p-12 rounded-3xl lg:rounded-[2.5rem] flex flex-col items-center justify-center text-center h-full">
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
                          onClick={() => {
                            setAllowAdditions(!allowAdditions);
                            setIsDecorSelected(true);
                          }} 
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
                                onClick={() => {
                                  setOptions({...options, [group.key]: val});
                                  if (group.key === 'ratio') setIsRatioSelected(true);
                                  if (group.key === 'resolution') setIsResolutionSelected(true);
                                  if (group.key === 'lighting') setIsLightingSelected(true);
                                }}
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
                    className="w-full py-4 sm:py-5 px-4 sm:px-6 btn-primary rounded-2xl sm:rounded-[1.5rem] font-bold flex items-center justify-center gap-2 sm:gap-3 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_20px_40px_rgba(61,57,53,0.15)] hover:shadow-[0_25px_50px_rgba(61,57,53,0.25)] active:scale-[0.98] text-sm sm:text-base"
                  >
                    {isBeautifying ? (
                      <>
                        <Loader2 className="w-5 h-5 sm:w-5.5 sm:h-5.5 animate-spin" />
                        <span className="text-sm sm:text-base">AI 画笔重绘中...</span>
                      </>
                    ) : (
                      <>
                        <ImageIcon className="w-5 h-5 sm:w-5.5 sm:h-5.5" />
                        <span className="text-sm sm:text-base">即刻开启美化</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        )}
          </>
        )}
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
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleImageUpload} 
        accept="image/*" 
        className="hidden" 
      />
    </div>
  );
}
