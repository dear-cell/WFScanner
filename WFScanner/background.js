let currentHeaders = {};
let blacklist = new Set();

// 加载黑名单
async function loadBlacklist() {
  try {
    // 加载默认黑名单
    const response = await fetch(chrome.runtime.getURL('blacklist.txt'));
    const text = await response.text();
    const defaultBlacklist = text.split('\n').filter(line => line.trim());
    
    // 加载用户自定义黑名单
    const storage = await chrome.storage.local.get(['userBlacklist']);
    const userBlacklist = storage.userBlacklist || [];
    
    // 合并黑名单
    blacklist = new Set([...defaultBlacklist, ...userBlacklist]);
    console.log('已加载黑名单:', Array.from(blacklist));
  } catch (error) {
    console.error('加载黑名单失败:', error);
  }
}

// 保存用户黑名单
async function saveUserBlacklist() {
  const storage = await chrome.storage.local.get(['userBlacklist']);
  const defaultBlacklist = await loadDefaultBlacklist();
  const userBlacklist = Array.from(blacklist).filter(item => !defaultBlacklist.includes(item));
  await chrome.storage.local.set({ userBlacklist });
}

// 加载默认黑名单
async function loadDefaultBlacklist() {
  const response = await fetch(chrome.runtime.getURL('blacklist.txt'));
  const text = await response.text();
  return text.split('\n').filter(line => line.trim());
}

// 检查URL是否在黑名单中
function isUrlBlacklisted(url) {
  try {
    return Array.from(blacklist).some(pattern => {
      if (pattern.includes('*')) {
        // 处理通配符
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(url);
      }
      return url.toLowerCase().startsWith(pattern.toLowerCase());
    });
  } catch (error) {
    console.error('URL检查错误:', error);
    return false;
  }
}

// 监听请求，捕获响应头
chrome.webRequest.onHeadersReceived.addListener(
  details => {
    const headers = {};
    details.responseHeaders.forEach(header => {
      headers[header.name.toLowerCase()] = header.value;
    });
    currentHeaders[details.tabId] = headers;
    
    // 当捕获到响应头时，触发分析
    analyzeCurrentTab(details.tabId);
  },
  {urls: ['<all_urls>']},
  ['responseHeaders']
);

// 清理不再需要的headers
chrome.tabs.onRemoved.addListener((tabId) => {
  delete currentHeaders[tabId];
});

// 处理消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getHeaders') {
    const tabId = sender.tab?.id;
    sendResponse({headers: currentHeaders[tabId] || {}});
  } else if (request.type === 'getBlacklist') {
    sendResponse({ blacklist: Array.from(blacklist) });
  } else if (request.type === 'addToBlacklist') {
    request.urls.forEach(url => blacklist.add(url));
    saveUserBlacklist();
    sendResponse({ success: true });
  } else if (request.type === 'removeFromBlacklist') {
    blacklist.delete(request.url);
    saveUserBlacklist();
    sendResponse({ success: true });
  } else if (request.type === 'checkBlacklist') {
    sendResponse(isUrlBlacklisted(request.url));
  }
  return true;
});

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (!isUrlBlacklisted(tab.url)) {
      analyzeCurrentTab(tabId);
    } else {
      // 清除角标
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
    }
  }
});

// 监听标签页激活
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  if (tab.url && !isUrlBlacklisted(tab.url)) {
    analyzeCurrentTab(activeInfo.tabId);
  } else {
    // 清除角标
    chrome.action.setBadgeText({
      text: '',
      tabId: activeInfo.tabId
    });
  }
});

// 分析当前标签页
async function analyzeCurrentTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;

    // 检查黑名单
    const isBlacklisted = await isUrlBlacklisted(tab.url);
    if (isBlacklisted) {
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
      return;
    }

    const [injection] = await chrome.scripting.executeScript({
      target: {tabId: tabId},
      function: async () => {
        try {
          // 获取规则文件
          const response = await fetch(chrome.runtime.getURL('finger.json'));
          if (!response.ok) {
            throw new Error(`无法加载规则文件: ${response.status}`);
          }
          const data = await response.json();
          const rules = data.fingerprint || [];
          
          // 获取页面信息
          const pageInfo = {
            url: window.location.href,
            title: document.title,
            body: document.body.innerHTML,
            length: document.body.innerHTML.length
          };

          // 获取响应头
          const headers = await new Promise((resolve) => {
            chrome.runtime.sendMessage({type: 'getHeaders'}, response => {
              resolve(response?.headers || {});
            });
          });

          const headersString = JSON.stringify(headers).toLowerCase();
          const matchedCMS = new Set();

          // 检查每个规则
          for (const rule of rules) {
            try {
              if (!rule || typeof rule !== 'object' || !rule.keyword) continue;
              
              const keywords = Array.isArray(rule.keyword) ? rule.keyword : [rule.keyword];
              let isMatch = false;

              switch (rule.location) {
                case 'body':
                  if (rule.method === 'keyword') {
                    isMatch = keywords.every(keyword => 
                      pageInfo.body.includes(keyword)
                    );
                  } else if (rule.method === 'regular') {
                    isMatch = keywords.some(keyword => {
                      try {
                        const regex = new RegExp(keyword);
                        return regex.test(pageInfo.body);
                      } catch (e) {
                        return false;
                      }
                    });
                  }
                  break;

                case 'header':
                  if (rule.method === 'keyword') {
                    isMatch = keywords.every(keyword =>
                      headersString.includes(keyword.toLowerCase())
                    );
                  } else if (rule.method === 'regular') {
                    isMatch = keywords.some(keyword => {
                      try {
                        const regex = new RegExp(keyword, 'i');
                        return regex.test(headersString);
                      } catch (e) {
                        return false;
                      }
                    });
                  }
                  break;

                case 'title':
                  if (rule.method === 'keyword') {
                    isMatch = keywords.every(keyword =>
                      pageInfo.title.includes(keyword)
                    );
                  } else if (rule.method === 'regular') {
                    isMatch = keywords.some(keyword => {
                      try {
                        const regex = new RegExp(keyword);
                        return regex.test(pageInfo.title);
                      } catch (e) {
                        return false;
                      }
                    });
                  }
                  break;
              }

              if (isMatch) {
                matchedCMS.add(rule.cms);
              }
            } catch (ruleError) {
              console.error('处理规则时出错:', ruleError);
            }
          }

          if (matchedCMS.size > 0) {
            return {
              url: pageInfo.url,
              cms: Array.from(matchedCMS).join(','),
              server: headers['server'] || headers['Server'] || '',
              statuscode: 200,
              length: pageInfo.length,
              title: pageInfo.title,
              cmsCount: matchedCMS.size
            };
          }
          return null;
        } catch (error) {
          console.error('分析过程出错:', error);
          return null;
        }
      }
    });

    const result = injection.result;
    if (result) {
      // 更新角标
      chrome.action.setBadgeText({
        text: result.cmsCount.toString(),
        tabId: tabId
      });
      chrome.action.setBadgeBackgroundColor({
        color: '#ff4081',
        tabId: tabId
      });
    } else {
      // 清除角标
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
    }

  } catch (error) {
    console.error('执行分析时出错:', error);
    chrome.action.setBadgeText({
      text: '',
      tabId: tabId
    });
  }
} 