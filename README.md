# Server-Meta: WhatsApp QA Bot with GitHub Actions Integration

## 📋 Overview

**Server-Meta** is an intelligent QA bot that connects WhatsApp messaging with GitHub Actions test automation. It allows users to trigger and monitor Playwright tests directly from WhatsApp using natural language commands, powered by the Groq AI API.

---

## 🎯 What It Does

This application provides a conversational interface via WhatsApp where users can:
- **Request test runs** with simple messages like "run tests" or "execute tests"
- **Receive real-time test results** including pass/fail counts and failure details
- **Track test execution** as the bot polls GitHub Actions for completion
- **Access test reports** with direct links to GitHub Actions runs

---

## 🤔 Why It Exists

- **Simplified QA Workflow**: No need to manually trigger GitHub Actions workflows or check dashboards
- **Accessibility**: QA engineers and stakeholders can interact with test infrastructure via familiar WhatsApp interface
- **Automation**: AI agent automatically understands user intent and executes appropriate commands
- **Real-time Notifications**: Immediate feedback on test execution status and results

---

## 🏗️ How It Works (Architecture)

```
WhatsApp Message
      ↓
Meta Webhook
      ↓
Express Server (server-meta.js)
      ↓
Groq AI Agent (understands intent)
      ↓
Tool Executor (runs GitHub Actions workflow)
      ↓
GitHub Actions API (triggers Playwright tests)
      ↓
Poll for Completion (checks run status)
      ↓
Parse Test Report (extracts results from artifacts)
      ↓
Send WhatsApp Response (back to user)
```

---

## 🔧 Components

### **1. Webhook Handler**
- `GET /webhook` - Verifies Meta's webhook subscription
- `POST /webhook` - Receives incoming WhatsApp messages

### **2. Agent Loop**
- Uses Groq AI to understand user commands
- Decides when to trigger the `run_tests` tool
- Maintains conversation history per user (phone number)

### **3. Tool Executor**
- `run_tests()` - The only available tool
- Triggers GitHub Actions workflow via API
- Polls GitHub until test completion
- Extracts and parses Playwright JSON report
- Returns summary to user

### **4. GitHub Integration**
- Dispatches GitHub Actions workflows
- Fetches workflow run status
- Downloads test artifacts (JSON reports)
- Parses Playwright test results

### **5. WhatsApp Integration**
- Sends messages via Meta's Graph API
- Acknowledges incoming messages
- Delivers final results to users

---

## 📦 What You Need (Environment Variables)

```env
# Meta WhatsApp
META_PHONE_ID=<your-meta-phone-id>
META_API_TOKEN=<your-meta-bearer-token>
WEBHOOK_VERIFY_TOKEN=<your-webhook-verify-token>

# GitHub
GITHUB_TOKEN=<your-github-personal-access-token>

# Groq AI
GROQ_API_KEY=<your-groq-api-key>

# Server
PORT=3000 (optional, defaults to 3000)
```

---

## 🚀 How to Set It Up

### **1. Prerequisites**
- Node.js 16+ installed
- Meta Business Account with WhatsApp Business API access
- GitHub repository with Playwright tests in GitHub Actions
- Groq API account

### **2. Installation**

```bash
# Clone or download the repository
cd ui-mcp

# Install dependencies
npm install

# Create .env file with all required credentials
echo "META_PHONE_ID=..." >> .env
echo "META_API_TOKEN=..." >> .env
echo "WEBHOOK_VERIFY_TOKEN=..." >> .env
echo "GITHUB_TOKEN=..." >> .env
echo "GROQ_API_KEY=..." >> .env
echo "PORT=3000" >> .env
```

### **3. Configure Repos**

Edit the `REPOS` array in `server-meta.js` to add your repositories:

```javascript
const REPOS = [
  {
    id: 1,
    name: "Your Project Name",
    keywords: ["your", "keywords"],
    repo: "owner/repo-name",
    workflow: "workflow-file-id",
    branch: "main",
  },
];
```

**How to find workflow ID:**
```bash
curl -H "Authorization: token YOUR_GITHUB_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/actions/workflows
```

### **4. Start the Server**

```bash
node server-meta.js
```

Expected output:
```
✅ Server running on port 3000
```

### **5. Configure Meta Webhook**

In Meta Business Suite, set:
- **Callback URL**: `https://your-domain.com/webhook`
- **Verify Token**: (same as `WEBHOOK_VERIFY_TOKEN` in .env)
- **Subscribe to messages** and **message_template_status_update** webhooks

---

## 💬 How to Use

### **User Side (WhatsApp)**

Simply send a message to your WhatsApp Business number:

```
User: "run tests"
Bot:  "⚙️ Ok mere Aakaa..."
Bot:  "⏳ [0m] queued"
Bot:  "⏳ [1m] in_progress"
Bot:  "Tests done ✅5 passed ❌0 failed ⊝0 skipped ⏱120s
       All passing! 🎉
       Run: https://github.com/.../runs/123456"
```

### **Supported Commands**
- "run tests"
- "execute tests"
- "trigger tests"
- "run playwright tests"
- (Any variation that implies running tests)

---

## 📊 Data Flow

### **Message Parsing**
```
WhatsApp → Meta Webhook → Extract phone + message text
```

### **AI Intent Recognition**
```
Groq API with system prompt → Decides if "run_tests" tool should be called
```

### **GitHub Workflow Trigger**
```
POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
```

### **Polling Loop**
```
Every 30 seconds: GET /repos/{owner}/{repo}/actions/runs/{run_id}
Until status = "completed"
```

### **Report Extraction**
```
Download artifact (json-report.zip)
→ Extract playwright-results.json
→ Walk test suites and specs
→ Count: passed, failed, skipped, duration
→ List failed test titles
```

---

## 📝 Key Files & Endpoints

| File/Endpoint | Purpose |
|---|---|
| `server-meta.js` | Main server file |
| `GET /health` | Health check endpoint |
| `GET /webhook` | Meta webhook verification |
| `POST /webhook` | Receives WhatsApp messages |
| `POST /groq-api` | (internal) Calls Groq for AI |
| `POST /github-api` | (internal) Calls GitHub API |

---

## 🔐 Security Considerations

1. **Environment Variables**: Never commit `.env` file
2. **GitHub Token**: Use fine-grained personal access tokens with repo-specific permissions
3. **Webhook Verification**: Always verify `WEBHOOK_VERIFY_TOKEN` matches
4. **Rate Limiting**: Groq (tier-dependent) and GitHub (60/hour unauthenticated, 5000/hour authenticated)

---

## 🛠️ Troubleshooting

| Issue | Solution |
|---|---|
| **Webhook not receiving messages** | Check Meta webhook settings match callback URL and verify token |
| **"Unknown tool" error** | Only `run_tests` tool is implemented; other commands won't trigger it |
| **Tests not completing** | Increase polling timeout or check GitHub Actions status page |
| **Report not found** | Ensure artifact is named `json-report` in your GitHub Actions workflow |
| **Groq rate limit** | Wait 15 seconds and retry (auto-handled) |

---

## 📚 Technologies Used

- **Express.js** - Web server framework
- **axios** - HTTP client for API calls
- **dotenv** - Environment variable management
- **Groq API** - AI agent for intent recognition
- **GitHub API** - Workflow automation and artifact access
- **Meta WhatsApp API** - Messaging delivery
- **jszip** - Artifact ZIP extraction

---

## 📄 License & Attribution

Built for automated QA testing via WhatsApp. Customize as needed.

---

## 🤝 Contributing

To extend functionality:
1. Add new repos to `REPOS` array
2. Define additional tools in `TOOL_DEFINITIONS`
3. Implement tool logic in `executeTool()` function
4. Update system prompt in `runAgent()` for new behaviors

---

**Last Updated**: March 2026  
**Maintained By**: QA Team
