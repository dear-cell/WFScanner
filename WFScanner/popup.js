document.addEventListener('DOMContentLoaded', async () => {
  const resultsDiv = document.getElementById('results');
  const badgeElement = document.getElementById('badge');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const blacklistInput = document.getElementById('blacklistInput');
  const addBlacklistBtn = document.getElementById('addBlacklistBtn');
  const blacklistItems = document.getElementById('blacklistItems');

  // 加载黑名单
  async function loadBlacklist() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getBlacklist' });
      displayBlacklist(response.blacklist);
    } catch (error) {
      console.error('加载黑名单失败:', error);
      blacklistItems.innerHTML = '<div class="error">加载黑名单失败</div>';
    }
  }

  // 显示黑名单
  function displayBlacklist(blacklist) {
    const tableBody = document.getElementById('blacklistTableBody');
    tableBody.innerHTML = '';
    
    blacklist.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${item}</td>
        <td>
          <button class="delete-btn" data-url="${item}">删除</button>
        </td>
      `;
      tableBody.appendChild(tr);
    });

    // 添加删除按钮事件
    tableBody.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.dataset.url;
        await chrome.runtime.sendMessage({ 
          type: 'removeFromBlacklist', 
          url: url 
        });
        loadBlacklist();
      });
    });
  }

  // 处理添加黑名单
  async function addToBlacklist(input) {
    let url = input.trim();
    if (!url) return;

    try {
      if (url.startsWith('@')) {
        // 处理完整URL
        url = url.substring(1);
        const domain = new URL(url).hostname;
        await chrome.runtime.sendMessage({
          type: 'addToBlacklist',
          urls: [
            domain,                    // 域名
            '*.' + domain              // 通配符形式
          ]
        });
      } else {
        // 直接添加输入的内容
        await chrome.runtime.sendMessage({
          type: 'addToBlacklist',
          urls: [url]
        });
      }

      document.getElementById('blacklistInput').value = '';
      await loadBlacklist();
    } catch (error) {
      console.error('添加黑名单失败:', error);
      alert('添加失败: ' + error.message);
    }
  }

  // 添加按钮点击事件
  addBlacklistBtn.addEventListener('click', () => {
    const input = document.getElementById('blacklistInput');
    addToBlacklist(input.value);
  });

  // 输入框回车事件
  blacklistInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addToBlacklist(e.target.value);
    }
  });

  // 切换设置面板
  settingsBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('show');
    resultsDiv.style.display = settingsPanel.classList.contains('show') ? 'none' : 'block';
    
    if (settingsPanel.classList.contains('show')) {
      // 调整弹窗大小以适应设置面板
      document.body.style.width = '500px';
      document.body.style.height = '600px';
      await loadBlacklist();
    } else {
      // 恢复原始大小
      document.body.style.width = '400px';
      document.body.style.height = 'auto';
    }
  });

  // 点击外部关闭设置面板
  document.addEventListener('click', (e) => {
    if (!settingsPanel.contains(e.target) && e.target !== settingsBtn) {
      settingsPanel.classList.remove('show');
      resultsDiv.style.display = 'block';
      document.body.style.width = '400px';
      document.body.style.height = 'auto';
    }
  });

  // 分析当前页面
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab) {
      throw new Error('无法获取当前标签页');
    }

    // 检查黑名单
    const isBlacklisted = await chrome.runtime.sendMessage({
      type: 'checkBlacklist',
      url: tab.url
    });

    if (isBlacklisted) {
      resultsDiv.innerHTML = '<div class="no-result">当前网站在黑名单中</div>';
      badgeElement.style.display = 'none';
      return;
    }

    // 执行分析
    const [injection] = await chrome.scripting.executeScript({
      target: {tabId: tab.id},
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

          // 获取响应头（通过background.js）
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

          // 返回结果
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
    if (!result) {
      resultsDiv.innerHTML = '<div class="no-result">未发现匹配的指纹</div>';
      badgeElement.style.display = 'none';
      return;
    }

    // 更新popup中的badge
    badgeElement.textContent = result.cmsCount.toString();
    badgeElement.style.display = 'inline-block';

    // 更新结果显示
    resultsDiv.innerHTML = `
      <div class="result-card">
        <div class="result-item">
          <span class="result-label">URL:</span>
          <span class="result-value">${result.url}</span>
        </div>
        <div class="result-item">
          <span class="result-label">CMS:</span>
          <span class="result-value cms-value">${result.cms}</span>
        </div>
        <div class="result-item">
          <span class="result-label">Server:</span>
          <span class="result-value">${result.server || '未知'}</span>
        </div>
        <div class="result-item">
          <span class="result-label">Status Code:</span>
          <span class="result-value">${result.statuscode}</span>
        </div>
        <div class="result-item">
          <span class="result-label">Length:</span>
          <span class="result-value">${result.length}</span>
        </div>
        <div class="result-item">
          <span class="result-label">Title:</span>
          <span class="result-value">${result.title}</span>
        </div>
      </div>
    `;

  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">错误: ${error.message}</div>`;
    console.error('执行分析时出错:', error);
    badgeElement.style.display = 'none';
  }
});

// 定义要注入的函数
function analyzePageContent(rules) {
  try {
    const results = [];
    const bodyContent = document.body.innerHTML;
    
    // 检查规则
    rules.forEach(rule => {
      if (rule.location === 'body') {
        rule.keyword.forEach(keyword => {
          if (bodyContent.includes(keyword)) {
            results.push({
              cms: rule.cms,
              matched: keyword,
              location: 'body'
            });
          }
        });
      }
    });

    return results;
  } catch (error) {
    console.error('分析页面内容时出错:', error);
    return [];
  }
}