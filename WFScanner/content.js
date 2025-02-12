// 添加消息监听
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'startAnalysis') {
    analyzePage().then(results => {
      sendResponse({results: results});
    }).catch(error => {
      sendResponse({error: error.message});
    });
    return true; // 保持消息通道开启
  }
});

async function analyzePage() {
  try {
    console.log('开始分析页面');
    
    // 获取当前页面信息
    const pageInfo = {
      url: window.location.href,
      title: document.title,
      body: document.body.innerHTML,
      length: document.body.innerHTML.length
    };
    console.log('页面信息:', pageInfo);

    // 获取规则文件
    const response = await fetch(chrome.runtime.getURL('finger.json'));
    if (!response.ok) {
      throw new Error(`无法加载规则文件: ${response.status}`);
    }
    const data = await response.json();
    const rules = data.fingerprint || [];
    
    // 获取响应头
    const headers = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({type: 'getHeaders'}, response => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response?.headers || {});
        }
      });
    });

    // 将headers转换为字符串以便进行关键词匹配
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
              // 必须所有关键词都匹配
              isMatch = keywords.every(keyword => 
                pageInfo.body.includes(keyword)
              );
            } else if (rule.method === 'regular') {
              isMatch = keywords.some(keyword => {
                try {
                  const regex = new RegExp(keyword);
                  return regex.test(pageInfo.body);
                } catch (e) {
                  console.error('正则表达式错误:', e);
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
                  console.error('正则表达式错误:', e);
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
                  console.error('正则表达式错误:', e);
                  return false;
                }
              });
            }
            break;
        }

        if (isMatch) {
          matchedCMS.add(rule.cms);
          console.log(`匹配到规则: ${rule.cms}, 位置: ${rule.location}, 方法: ${rule.method}`);
        }
      } catch (ruleError) {
        console.error('处理规则时出错:', ruleError, rule);
      }
    }

    // 只在有匹配结果时返回
    if (matchedCMS.size > 0) {
      const result = {
        url: pageInfo.url,
        cms: Array.from(matchedCMS).join(','),
        server: headers['server'] || headers['Server'] || '',
        statuscode: 200, // 由于是在页面中运行，说明状态码是200
        length: pageInfo.length,
        title: pageInfo.title
      };
      console.log('最终结果:', result);
      return [result]; // 返回单个结果数组
    }

    return []; // 没有匹配时返回空数组
    
  } catch (error) {
    console.error('分析过程出错:', error);
    throw error;
  }
}

// 等待页面加载完成后执行
if (document.readyState === 'complete') {
  analyzePage();
} else {
  window.addEventListener('load', analyzePage);
} 