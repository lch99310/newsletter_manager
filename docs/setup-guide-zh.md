# 手把手教學：Newsletter Manager 完整設定指南

---

## 你需要準備的東西

- 一個 GitHub 帳號
- 一個 email 信箱（用來接收 newsletter）
- 5 分鐘

---

## 第一步：Fork 專案到你的 GitHub

1. 打開這個專案的 GitHub 頁面
2. 點右上角的 **Fork** 按鈕
3. 在 Fork 頁面直接點 **Create fork**
4. 等待幾秒，你的帳號下就會有一份完整的副本

> 完成後你會在 `https://github.com/你的帳號/newsletter-manager` 看到這個專案

---

## 第二步：註冊 Resend（免費寄信服務）

1. 打開 [https://resend.com](https://resend.com)
2. 點 **Get Started** 或 **Sign Up** 註冊
3. 可以用 GitHub 帳號直接登入
4. 進入 Dashboard 後，點左側 **API Keys**
5. 點 **+ Create API Key**
   - Name: 隨便取，例如 `newsletter`
   - Permission: 選 **Sending access**
   - Domain: 選預設的
6. 點 **Create** 後會顯示一串 `re_` 開頭的 key
7. **複製這串 key，存起來（只會顯示一次）**

> Resend 免費方案：每天 100 封，每月 3,000 封，完全夠用

---

## 第三步：在 GitHub 設定 Secrets

Secrets 是存放密碼/金鑰的安全位置，GitHub Actions 會讀取它們。

1. 打開你 Fork 的專案頁面
2. 點上方的 **Settings**（齒輪圖示）
3. 左側選單找到 **Secrets and variables** → 點 **Actions**
4. 點 **New repository secret**
5. 新增第一個 Secret：
   - **Name**: `RESEND_API_KEY`
   - **Secret**: 貼上你在第二步複製的 Resend API key
   - 點 **Add secret**
6. 再點 **New repository secret**，新增第二個：
   - **Name**: `FROM_EMAIL`
   - **Secret**: `onboarding@resend.dev`
   - 點 **Add secret**

> `onboarding@resend.dev` 是 Resend 提供的測試用寄件地址。
> 之後你可以在 Resend 設定自己的網域來換成自己的 email。

---

## 第四步：啟用 GitHub Actions

Fork 的專案預設會關閉 Actions，需要手動開啟。

1. 點上方的 **Actions** 分頁
2. 會看到黃色提示：*"Workflows aren't being run on this forked repository"*
3. 點 **I understand my workflows, go ahead and enable them**

---

## 第五步：設定你要追蹤的網站

1. 在專案頁面，找到 `data/sources.json` 檔案，點進去
2. 點右上角的 **鉛筆圖示**（Edit this file）
3. 修改內容，格式如下：

```json
{
  "sources": [
    {
      "url": "https://www.latepost.com/",
      "name": "LatePost (晚点)"
    },
    {
      "url": "https://example.com/blog",
      "name": "另一個網站"
    }
  ]
}
```

4. 每個網站需要兩個欄位：
   - `url`: 網站首頁或文章列表頁的完整網址
   - `name`: 顯示名稱（會出現在 email 標題）
5. 改完後點 **Commit changes** 按鈕
6. 在彈出的對話框直接點 **Commit changes**

---

## 第六步：設定你的收件 email

1. 找到 `data/subscribers.json` 檔案，點進去
2. 點 **鉛筆圖示** 編輯
3. 修改內容：

```json
{
  "subscribers": [
    "你的真實email@gmail.com"
  ]
}
```

4. 如果有多個收件人：

```json
{
  "subscribers": [
    "email1@gmail.com",
    "email2@outlook.com"
  ]
}
```

5. 點 **Commit changes** 儲存

---

## 第七步：手動測試一次

1. 點上方 **Actions** 分頁
2. 左側點 **Check for Updates**
3. 右側點 **Run workflow** 下拉選單
4. 點綠色的 **Run workflow** 按鈕
5. 等一下會出現一個新的執行記錄（黃色圓圈表示執行中）
6. 點進去可以看詳細 log
7. 如果成功，你的信箱就會收到 email

---

## 第八步（選用）：開啟 GitHub Pages 管理頁面

1. 到 **Settings** → **Pages**
2. Source 選 **Deploy from a branch**
3. Branch 選 **main**，資料夾選 **/ (root)**
4. 點 **Save**
5. 等幾分鐘後，你的管理頁面就會在：
   `https://你的帳號.github.io/newsletter-manager/`

---

## 之後的日常使用

### 新增網站
編輯 `data/sources.json`，加一組新的 `{ "url": "...", "name": "..." }`

### 移除網站
編輯 `data/sources.json`，刪掉不要的那組

### 新增/移除收件人
編輯 `data/subscribers.json`，加或刪 email

### 修改檢查時間
編輯 `.github/workflows/check.yml`，改 cron 那一行：

| 想要的頻率 | cron 寫法 |
|-----------|----------|
| 每天早上 8 點 (UTC) | `0 8 * * *` |
| 每天台灣時間早上 8 點 | `0 0 * * *` |
| 每 6 小時 | `0 */6 * * *` |
| 每週一早上 | `0 8 * * 1` |

> 注意：GitHub Actions 的 cron 使用 UTC 時區。台灣是 UTC+8，所以台灣早上 8 點 = UTC 凌晨 0 點。

### 暫停不收信
到 **Actions** 分頁 → 點 **Check for Updates** → 點右上角 **...** → **Disable workflow**

---

## 常見問題

**Q: 為什麼某個網站抓不到文章？**
有些網站用 JavaScript 動態載入內容（SPA），基本的 HTML 抓取可能抓不到完整內容。
但系統仍會盡量從 HTML 中提取文章連結和標題。

**Q: 第一次執行會寄很多文章嗎？**
是的，第一次執行時所有文章都是「新的」。之後就只會寄新發現的文章。

**Q: 如果網站沒更新，會收到空信嗎？**
不會。沒有新文章就不會寄信。

**Q: GitHub Actions 要錢嗎？**
Public repo 完全免費。Private repo 每月有 2,000 分鐘免費額度，每天跑一次完全夠用。

**Q: Resend 要錢嗎？**
免費方案每天 100 封、每月 3,000 封。除非你追蹤非常多網站或有非常多收件人，否則不需要付費。
