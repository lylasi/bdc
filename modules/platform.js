/**
 * 平台检测与兼容性处理模块
 * 支持iOS、Android、PC、微信内置浏览器的特性检测和适配
 * 使用方法：import * as platform from './platform.js'
 */

// =================================
// 平台和浏览器检测
// =================================

/**
 * 检测当前运行平台和浏览器环境
 */
export const detect = (() => {
    const ua = navigator.userAgent.toLowerCase();
    const platform = navigator.platform?.toLowerCase() || '';
    
    return {
        // 操作系统检测
        isIOS: /iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && 'ontouchend' in document),
        isAndroid: /android/.test(ua),
        isMobile: /mobile|android|iphone|ipad|ipod|blackberry|windows phone/.test(ua),
        isPC: !(/mobile|android|iphone|ipad|ipod|blackberry|windows phone/.test(ua)),
        
        // 浏览器检测
        isSafari: /safari/.test(ua) && !/chrome/.test(ua),
        isChrome: /chrome/.test(ua) && !/edge/.test(ua),
        isFirefox: /firefox/.test(ua),
        isEdge: /edge/.test(ua),
        
        // 特殊环境检测
        isWeixin: /micromessenger/.test(ua),
        isQQ: /qq\//.test(ua),
        isUCBrowser: /ucbrowser/.test(ua),
        
        // 版本信息
        iOSVersion: (() => {
            const match = ua.match(/os (\d+)_(\d+)/);
            return match ? parseFloat(`${match[1]}.${match[2]}`) : null;
        })(),
        
        androidVersion: (() => {
            const match = ua.match(/android (\d+)\.(\d+)/);
            return match ? parseFloat(`${match[1]}.${match[2]}`) : null;
        })(),
        
        // 原始信息
        userAgent: ua,
        platform: platform
    };
})();

// =================================
// 特性检测
// =================================

/**
 * 检测浏览器支持的特性
 */
export const features = {
    // 视窗相关
    visualViewport: 'visualViewport' in window,
    
    // 音频相关  
    webAudio: 'AudioContext' in window || 'webkitAudioContext' in window,
    speechSynthesis: 'speechSynthesis' in window,
    
    // DOM相关
    intersectionObserver: 'IntersectionObserver' in window,
    resizeObserver: 'ResizeObserver' in window,
    
    // 存储相关
    localStorage: (() => {
        try {
            const test = '__localStorage_test__';
            localStorage.setItem(test, test);
            localStorage.removeItem(test);
            return true;
        } catch {
            return false;
        }
    })(),
    
    // 网络相关
    serviceWorker: 'serviceWorker' in navigator,
    
    // 触摸相关
    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    
    // CSS特性
    cssSticky: (() => {
        const el = document.createElement('div');
        el.style.position = 'sticky';
        return el.style.position === 'sticky';
    })()
};

// =================================
// 视窗管理
// =================================

/**
 * 获取真实的视窗高度（处理iOS地址栏问题）
 */
export function getViewportHeight() {
    if (features.visualViewport) {
        return window.visualViewport.height;
    }
    
    // iOS Safari地址栏处理
    if (detect.isIOS && detect.isSafari) {
        // 使用window.innerHeight，但需要监听resize
        return window.innerHeight;
    }
    
    return window.innerHeight;
}

/**
 * 获取安全区域高度（考虑底部安全区域）
 */
export function getSafeAreaHeight() {
    const height = getViewportHeight();
    
    // iPhone X系列底部安全区域处理
    if (detect.isIOS) {
        const safeAreaBottom = parseInt(
            getComputedStyle(document.documentElement)
                .getPropertyValue('--sat') || '0'
        );
        return height - safeAreaBottom;
    }
    
    return height;
}

// =================================
// 页面可见性管理
// =================================

/**
 * 获取页面可见性API（跨浏览器）
 */
export function getVisibilityAPI() {
    if (typeof document.hidden !== 'undefined') {
        return {
            hidden: 'hidden',
            visibilityChange: 'visibilitychange'
        };
    } else if (typeof document.msHidden !== 'undefined') {
        return {
            hidden: 'msHidden',
            visibilityChange: 'msvisibilitychange'
        };
    } else if (typeof document.webkitHidden !== 'undefined') {
        return {
            hidden: 'webkitHidden',
            visibilityChange: 'webkitvisibilitychange'
        };
    }
    
    return null;
}

/**
 * 监听页面可见性变化
 */
export function onVisibilityChange(callback) {
    const api = getVisibilityAPI();
    if (!api) return null;
    
    const handler = () => {
        callback(!document[api.hidden]);
    };
    
    document.addEventListener(api.visibilityChange, handler);
    
    return () => {
        document.removeEventListener(api.visibilityChange, handler);
    };
}

// =================================
// 音频兼容性处理
// =================================

/**
 * 检查音频自动播放策略
 */
export async function checkAutoplayPolicy() {
    if (!features.webAudio) return false;
    
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContext();
        
        if (context.state === 'suspended') {
            return false; // 需要用户交互
        }
        
        context.close();
        return true;
    } catch {
        return false;
    }
}

/**
 * 微信浏览器音频处理
 */
export function initWeixinAudio(callback) {
    if (!detect.isWeixin) return;
    
    if (window.WeixinJSBridge) {
        callback();
    } else {
        document.addEventListener('WeixinJSBridgeReady', callback);
    }
}

// =================================
// 触摸和交互优化
// =================================

/**
 * 获取适合的触摸目标尺寸
 */
export function getOptimalTouchTarget() {
    if (detect.isIOS) {
        return 44; // iOS HIG推荐
    } else if (detect.isAndroid) {
        return 48; // Material Design推荐
    }
    return 40; // 通用最小尺寸
}

/**
 * 禁用iOS Safari的弹性滚动
 */
export function disableBounceScrolling(element) {
    if (!detect.isIOS) return;
    
    let startY = 0;
    
    element.addEventListener('touchstart', e => {
        startY = e.touches[0].pageY;
    });
    
    element.addEventListener('touchmove', e => {
        const y = e.touches[0].pageY;
        const scrollTop = element.scrollTop;
        const scrollHeight = element.scrollHeight;
        const clientHeight = element.clientHeight;
        
        // 到顶部或底部时阻止默认行为
        if ((scrollTop === 0 && y > startY) || 
            (scrollTop + clientHeight >= scrollHeight && y < startY)) {
            e.preventDefault();
        }
    });
}

// =================================
// 调试和日志
// =================================

/**
 * 输出平台检测信息（开发模式）
 */
export function logPlatformInfo() {
    if (process?.env?.NODE_ENV === 'production') return;
    
    console.group('🔍 Platform Detection');
    console.log('Platform:', detect);
    console.log('Features:', features);
    console.log('Viewport Height:', getViewportHeight());
    console.log('Safe Area Height:', getSafeAreaHeight());
    console.groupEnd();
}