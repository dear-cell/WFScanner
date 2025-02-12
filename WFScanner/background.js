let currentHeaders = {};
let blacklist = new Set();

// 加载黑名单
async function loadBlacklist() {
  try {
    const response = await fetch(chrome.runtime.getURL('blacklist.txt'));
    const text = await response.text();
    const defaultBlacklist = text.split('\n').filter(line => line.trim());
    const { userBlacklist = [] } = await chrome.storage.local.get('userBlacklist');
    blacklist = new Set([...defaultBlacklist, ...userBlacklist]);
  } catch (error) {
    console.error('加载黑名单失败:', error);
  }
}

// 保存用户黑名单
async function saveUserBlacklist() {
  try {
    const response = await fetch(chrome.runtime.getURL('blacklist.txt'));
    const text = await response.text();
    const defaultBlacklist = text.split('\n').filter(line => line.trim());
    const userBlacklist = Array.from(blacklist).filter(item => !defaultBlacklist.includes(item));
    await chrome.storage.local.set({ userBlacklist });
    await loadBlacklist();
  } catch (error) {
    console.error('保存黑名单失败:', error);
  }
}

// 检查URL是否在黑名单中
function isUrlBlacklisted(url) {
  try {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      return false;
    }

    let domain = new URL(url).hostname.toLowerCase();

    if (blacklist.has(domain)) {
      return true;
    }

    for (const pattern of blacklist) {
      const lowerPattern = pattern.toLowerCase();
      if (pattern.startsWith('*.')) {
        const baseDomain = lowerPattern.substring(2);
        if (domain.endsWith(baseDomain)) {
          return true;
        }
      } else if (domain === lowerPattern || domain.endsWith('.' + lowerPattern)) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

// 处理添加黑名单
async function addToBlacklist(urls) {
  for (let url of urls) {
    try {
      if (url.startsWith('@') || url.startsWith('http://') || url.startsWith('https://')) {
        url = url.startsWith('@') ? url.substring(1) : url;
        const domain = new URL(url).hostname.toLowerCase();
        blacklist.add(domain);
        blacklist.add('*.' + domain);
      } else {
        url = url.toLowerCase();
        blacklist.add(url);
        if (!url.startsWith('*.')) {
          blacklist.add('*.' + url);
        }
      }
    } catch (error) {
      console.error('添加黑名单失败:', error);
    }
  }
  await saveUserBlacklist();
}

// 处理消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'analyze') {
    // 立即执行分析
    (async () => {
      try {
        const result = await performAnalysis(request.tabId);
        sendResponse(result);
      } catch (error) {
        console.error('分析错误:', error);
        sendResponse(null);
      }
    })();
    return true; // 保持消息通道开启
  } else if (request.type === 'getHeaders') {
    const tabId = sender.tab?.id;
    sendResponse({headers: currentHeaders[tabId] || {}});
  } else if (request.type === 'getBlacklist') {
    sendResponse({ blacklist: Array.from(blacklist) });
  } else if (request.type === 'addToBlacklist') {
    addToBlacklist(request.urls).then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (request.type === 'removeFromBlacklist') {
    blacklist.delete(request.url);
    if (!request.url.startsWith('*.')) {
      blacklist.delete('*.' + request.url);
    }
    saveUserBlacklist().then(() => {
      sendResponse({ success: true });
    });
    return true;
  } else if (request.type === 'checkBlacklist') {
    sendResponse(isUrlBlacklisted(request.url));
  }
  return true;
});

// 新的分析函数
async function performAnalysis(tabId) {
  if (!tabId || tabId < 0) return null;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || tab.status !== 'complete') return null;

    if (isUrlBlacklisted(tab.url)) {
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
      return null;
    }

    const [injection] = await chrome.scripting.executeScript({
      target: {tabId: tabId},
      function: async () => {
        try {
          if (document.readyState !== 'complete') return null;

          const response = await fetch(chrome.runtime.getURL('finger.json'));
          if (!response.ok) {
            console.error('规则文件加载失败');
            return null;
          }
          
          const data = await response.json();
          const rules = data.fingerprint || [];
          console.log('加载规则数量:', rules.length);
          
          const pageInfo = {
            url: window.location.href,
            title: document.title,
            body: document.documentElement.outerHTML,
            text: document.body.innerText,
            length: document.body.innerText.length
          };

          console.log('页面信息:', {
            url: pageInfo.url,
            title: pageInfo.title,
            bodyLength: pageInfo.body.length
          });

          const headers = await new Promise((resolve) => {
            chrome.runtime.sendMessage({type: 'getHeaders'}, response => {
              resolve(response?.headers || {});
            });
          });

          const headersString = JSON.stringify(headers).toLowerCase();
          const matchedCMS = new Set();
          const matchDetails = [];

          for (const rule of rules) {
            if (!rule?.keyword) continue;
            
            const keywords = Array.isArray(rule.keyword) ? rule.keyword : [rule.keyword];
            let matched = false;
            
            switch (rule.location) {
              case 'body':
                if (rule.method === 'keyword') {
                  matched = keywords.every(keyword => {
                    const isMatch = pageInfo.body.includes(keyword);
                    matchDetails.push({
                      cms: rule.cms,
                      location: 'body',
                      keyword,
                      matched: isMatch
                    });
                    return isMatch;
                  });
                  if (matched) matchedCMS.add(rule.cms);
                }
                break;

              case 'header':
                if (rule.method === 'keyword') {
                  matched = keywords.every(keyword => {
                    const isMatch = headersString.includes(keyword.toLowerCase());
                    matchDetails.push({
                      cms: rule.cms,
                      location: 'header',
                      keyword,
                      matched: isMatch
                    });
                    return isMatch;
                  });
                  if (matched) matchedCMS.add(rule.cms);
                }
                break;

              case 'title':
                if (rule.method === 'keyword') {
                  matched = keywords.every(keyword => {
                    const isMatch = pageInfo.title.includes(keyword);
                    matchDetails.push({
                      cms: rule.cms,
                      location: 'title',
                      keyword,
                      matched: isMatch
                    });
                    return isMatch;
                  });
                  if (matched) matchedCMS.add(rule.cms);
                }
                break;
            }
          }

          console.log('匹配详情:', matchDetails);
          console.log('匹配到的CMS:', Array.from(matchedCMS));

          if (matchedCMS.size > 0) {
            return {
              url: pageInfo.url,
              cms: Array.from(matchedCMS).join(','),
              server: headers['server'] || '',
              statuscode: 200,
              length: pageInfo.length,
              title: pageInfo.title,
              cmsCount: matchedCMS.size,
              matchDetails: matchDetails
            };
          }
          return null;
        } catch (error) {
          console.error('分析执行错误:', error);
          return null;
        }
      }
    });

    const result = injection?.result;
    if (result) {
      chrome.action.setBadgeText({
        text: result.cmsCount.toString(),
        tabId: tabId
      });
      chrome.action.setBadgeBackgroundColor({
        color: '#ff4081',
        tabId: tabId
      });
    } else {
      chrome.action.setBadgeText({
        text: '',
        tabId: tabId
      });
    }

    return result;

  } catch (error) {
    console.error('分析过程错误:', error);
    chrome.action.setBadgeText({
      text: '',
      tabId: tabId
    });
    return null;
  }
}

// 监听标签页更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    performAnalysis(tabId);
  }
});

// 监听标签页激活
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  if (tab.status === 'complete') {
    performAnalysis(activeInfo.tabId);
  }
});

// 初始化加载
loadBlacklist();
chrome.runtime.onInstalled.addListener(loadBlacklist);
chrome.runtime.onStartup.addListener(loadBlacklist); 