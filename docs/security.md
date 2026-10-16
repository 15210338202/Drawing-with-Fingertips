# 密钥与安全纪律

## 三条红线

1. **API Key 绝不能出现在前端代码或公开仓库**
2. **`.env.example` 只放键名，永远不放值**
3. **提交前必须扫描 staged 内容是否有 key**

## 提交前检查命令

```bash
git diff --cached | grep -E "sk-|api[_-]?key.*=.*[a-zA-Z0-9]{20,}"
```

有输出 → 立刻 `git restore --staged <file>`，改完再提交。

## 已发生事故

- **10/20**：`frontend/.env.example` 误写入真实 DeepSeek key，被 GitHub Push Protection 拦截。处理：撤销旧 key、修正文件、`git commit --amend`/`rebase` 清理历史、重推。无泄漏。

## 构建产物扫描（每次部署前）

bash

```
cd frontend
pnpm build
grep -rE "sk-[a-zA-Z0-9]{20,}" .output/ || echo "无 key 残留"
```



无输出才可部署。